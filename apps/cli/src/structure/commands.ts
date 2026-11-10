import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { CliError, EXIT } from "../exit-codes.ts";
import { readFlags } from "../flags.ts";
import { type Connection, connect, type RunContext } from "../remote/connection.ts";
import { call } from "../remote/run.ts";
import { dedent, topLevelBlocks } from "./css-blocks.ts";
import {
	type DesignSystemDraft,
	markupOf,
	readStructure,
	SAFE_NAME,
	STRUCTURE_FOLDERS,
	type StructureItem,
	type StructureState,
} from "./state.ts";

/** The manifest `structure pull` writes beside the files: where they came from, and each file's base. */
const MANIFEST = "webcraft.json";

type Manifest = {
	format: 1;
	install: string;
	site: { id: string; name: string };
	pulledAt: string;
	/** Each file as pulled: a hash of its content, and its item's Draft version where the Install keeps one. */
	files: Record<string, { hash: string; version?: string | null }>;
};

const PULL_HELP = `Usage: webcraft structure pull [--site-id <id>] [--dir <folder>] [--force]

Writes a Site's Structure as files (Drafts, as they are now), with ${MANIFEST}, a manifest of what
was pulled:
  templates/site.wc.html, templates/search.wc.html          the Site and Search results templates
  templates/entry/<post type>.wc.html, templates/archive/…  each Post Type's Entry and Archive template
  components/<Name>.wc.html and components/<Name>.json      each Component's markup and its Props
  design-system/tokens.json                                 the Design tokens (DTCG)
  design-system/classes/<name>.css                          each Class: its styles, one @media (--<breakpoint>)
                                                            block per breakpoint, then its own CSS
  design-system/base.css, design-system/site.css            base styles and the Site's own CSS
  design-system/design-system.json                          dark mode, and the Classes' order
  post-types/<key>.json, loops/<name>.json, forms/<key>.json, filters/<name>.json
Template markup is a lossless view of the stored elements (data-wc-id keeps each element's id).

--site-id  the Site (needed the first time; then the manifest says)
--dir      the folder to write in (this one unless given)
--force    overwrite files changed since the last pull
`;

const PUSH_HELP = `Usage: webcraft structure push [--dir <folder>] [--dry-run] [--force] [--yes]

Sends the files you changed since the last pull to the Install, as Drafts: nothing is published
(publish in the admin, or with webcraft <group> publish). It shows what changes, per file, and goes
ahead once you confirm (or with --yes). New files make new Components, Post Types, Loops, Forms,
Filters, Classes and Templates; files you removed are never deleted on the Install.
Post Types have no Draft: a change to one applies at once.

A push whose files changed on the Install since the pull is refused, nothing sent, unless --force
(which overwrites those changes). Afterwards each file sent holds what the Install stored.

--dry-run  show what would change, and send nothing
--force    send files even where the Install changed them since the pull
`;

/** `webcraft structure pull` and `push`. */
export async function runStructure(
	context: RunContext,
	command: "pull" | "push",
	args: string[],
	help: boolean,
): Promise<number> {
	if (help) {
		context.io.stdout(command === "pull" ? PULL_HELP : PUSH_HELP);
		return EXIT.ok;
	}
	const given = parseOptions(args, command);
	return command === "pull" ? pull(context, given) : push(context, given);
}

type Options = { siteId?: string; dir: string; force: boolean; dryRun: boolean };

function parseOptions(args: string[], command: "pull" | "push"): Options {
	const options: Options = { dir: ".", force: false, dryRun: false };
	const flags = readFlags(args);
	for (let flag = flags.next(); flag; flag = flags.next()) {
		if (!flag.short && flag.name === "site-id" && command === "pull") {
			options.siteId = flags.value(flag, `--${flag.name} needs a value.`);
		} else if (!flag.short && flag.name === "dir") options.dir = flags.value(flag, `--${flag.name} needs a value.`);
		else if (!flag.short && flag.name === "force") options.force = true;
		else if (!flag.short && flag.name === "dry-run" && command === "push") options.dryRun = true;
		else
			throw new CliError(
				EXIT.usage,
				`webcraft structure ${command} has no option ${flag.raw}. See webcraft structure ${command} --help.`,
			);
	}
	if (flags.rest.length > 0) {
		throw new CliError(
			EXIT.usage,
			`webcraft structure ${command} has no option ${flags.rest[0]}. See webcraft structure ${command} --help.`,
		);
	}
	return options;
}

function hashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function readManifest(dir: string): Promise<Manifest | null> {
	try {
		const parsed = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Manifest;
		return parsed && typeof parsed.files === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** The structure files in the folder, by path (with `/`), with their content. */
async function readLocal(dir: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const walk = async (folder: string): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(folder, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && /\.(wc\.html|json|css)$/.test(entry.name)) {
				files.set(relative(dir, full).split(sep).join("/"), await readFile(full, "utf8"));
			}
		}
	};
	for (const folder of STRUCTURE_FOLDERS) await walk(join(dir, folder));
	return files;
}

async function writeFiles(dir: string, files: Iterable<[string, string]>): Promise<void> {
	for (const [path, content] of files) {
		const full = join(dir, ...path.split("/"));
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content);
	}
}

async function pull(context: RunContext, options: Options): Promise<number> {
	const { io } = context;
	const dir = resolve(io.cwd, options.dir);
	const manifest = await readManifest(dir);
	const siteId = options.siteId ?? manifest?.site.id;
	if (!siteId)
		throw new CliError(EXIT.usage, "Which Site? The first pull needs --site-id <id> (webcraft sites list shows them).");
	const connection = await connect(context);
	if (manifest && (manifest.site.id !== siteId || manifest.install !== connection.url) && !options.force) {
		throw new CliError(
			EXIT.usage,
			`${join(options.dir, MANIFEST)} is for another Site (${manifest.site.name} on ${manifest.install}). Pull into another folder, or pass --force to replace it.`,
		);
	}
	const local = await readLocal(dir);
	if (manifest && !options.force) {
		const changed = [...local].filter(
			([path, content]) => manifest.files[path] && manifest.files[path].hash !== hashOf(content),
		);
		if (changed.length > 0) {
			throw new CliError(
				EXIT.changedMeanwhile,
				`These files changed since the last pull, and pulling would overwrite them:\n${changed.map(([path]) => `  ${path}`).join("\n")}\nPush them first, or pass --force to overwrite them.`,
			);
		}
	}
	const state = await readStructure(connection, siteId, (text) => io.stderr(`webcraft: ${text}\n`));
	await writeFiles(dir, state.files);
	// Files of items the Install no longer has go too, unless they were changed here.
	let removed = 0;
	for (const [path, content] of local) {
		if (state.files.has(path) || !manifest?.files[path] || manifest.files[path].hash !== hashOf(content)) continue;
		await rm(join(dir, ...path.split("/")), { force: true });
		removed++;
	}
	const next: Manifest = {
		format: 1,
		install: connection.url,
		site: state.site,
		pulledAt: io.now().toISOString(),
		files: Object.fromEntries([...state.files].map(([path, content]) => [path, entryFor(state, path, content)])),
	};
	await writeFile(join(dir, MANIFEST), `${JSON.stringify(next, null, "\t")}\n`);
	if (context.options.json) {
		io.stdout(`${JSON.stringify({ site: state.site, dir, files: [...state.files.keys()], removed }, null, 2)}\n`);
	} else {
		io.stdout(
			`Pulled ${state.files.size} files of ${state.site.name} into ${options.dir === "." ? "this folder" : options.dir}` +
				`${removed > 0 ? `, and removed ${removed} the Install no longer has` : ""}.\nEdit them, then send your changes as Drafts with webcraft structure push.\n`,
		);
	}
	return EXIT.ok;
}

function entryFor(state: StructureState, path: string, content: string): Manifest["files"][string] {
	const item = itemOfPath(state.items, path);
	const version = item?.kind === "template" || item?.kind === "component" ? item.version : undefined;
	return version === undefined ? { hash: hashOf(content) } : { hash: hashOf(content), version };
}

/** One thing a push saves, from one or more files. */
type Unit = {
	key: string;
	order: number;
	paths: string[];
	/** The item on the Install now, or null for a new one. */
	item: StructureItem | null;
	describe: string;
};

/** A local file path recognised as one of a kind's units: its key (after `kind:`) and what to call it. */
type PathMatch = { key: string; describe: string };

/** `path`, with `suffix` taken off its end, or null when it doesn't end with it. */
function withoutSuffix(path: string, suffix: string): string | null {
	return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
}

/** `item`, asserting it is `kind` (every call site only ever is, by how the table below is built). */
function as<Kind extends StructureItem["kind"]>(
	kind: Kind,
	item: StructureItem,
): Extract<StructureItem, { kind: Kind }> {
	if (item.kind !== kind) throw new Error(`A Structure item of kind "${item.kind}" was read as "${kind}".`);
	return item as Extract<StructureItem, { kind: Kind }>;
}

/** What `sendUnit` needs, besides the unit's own key and item. */
type SendContext = {
	manifest: Manifest;
	state: StructureState;
	unit: Unit;
	local: Map<string, string>;
	force: boolean;
	send: (path: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/**
 * One kind of Structure item: how a local file path is recognised as one of its units, the matching
 * Install item's key, where push sends it (lower first), and how it is saved. A new kind is one more
 * entry here, instead of a fourth place to add it to (`unitOf`, `itemKey` and `sendUnit` used to be
 * three parallel switches over the same kinds).
 */
type Kind = {
	order: number;
	pathOf(path: string): PathMatch | null;
	/** `item`'s key (after `kind:`): called only with an item of this entry's own kind. */
	itemKeyOf(item: StructureItem): string;
	/** Saves this unit's change on the Install, as a Draft. `key` is its key, after `kind:`. */
	send(ctx: SendContext, key: string): Promise<void>;
};

const KINDS: Record<StructureItem["kind"], Kind> = {
	postType: {
		order: 0,
		pathOf: (path) => {
			const [folder, file, ...rest] = path.split("/");
			const key = folder === "post-types" && rest.length === 0 ? withoutSuffix(file ?? "", ".json") : null;
			return key && SAFE_NAME.test(key) ? { key, describe: `Post Type ${key}` } : null;
		},
		itemKeyOf: (item) => as("postType", item).key,
		send: async (ctx, key) => {
			const path = `post-types/${key}.json`;
			const file = parseJson(path, ctx.local.get(path));
			const item = ctx.unit.item;
			if (item) await ctx.send("postTypes/update", { postTypeId: as("postType", item).id, ...file });
			else await ctx.send("postTypes/create", { key, ...file });
		},
	},
	designSystem: {
		order: 1,
		pathOf: (path) => (path.split("/")[0] === "design-system" ? { key: "", describe: "the Design system" } : null),
		itemKeyOf: () => "",
		send: async (ctx) => sendDesignSystem(ctx.send, ctx.state, ctx.unit, ctx.local),
	},
	loop: {
		order: 2,
		pathOf: (path) => {
			const [folder, file, ...rest] = path.split("/");
			const key = folder === "loops" && rest.length === 0 ? withoutSuffix(file ?? "", ".json") : null;
			return key && SAFE_NAME.test(key) ? { key, describe: `Loop ${key}` } : null;
		},
		itemKeyOf: (item) => as("loop", item).name,
		send: async (ctx, key) => {
			const path = `loops/${key}.json`;
			const { source, query, fields } = parseJson(path, ctx.local.get(path));
			const item = ctx.unit.item;
			if (item) await ctx.send("loops/saveDraft", { loopId: as("loop", item).id, source, query, fields });
			else await ctx.send("loops/create", { name: key, source, query, fields });
		},
	},
	component: {
		order: 3,
		pathOf: (path) => {
			const [folder, file, ...rest] = path.split("/");
			const key =
				folder !== "components" || rest.length > 0
					? null
					: (withoutSuffix(file ?? "", ".wc.html") ?? withoutSuffix(file ?? "", ".json"));
			return key && SAFE_NAME.test(key) ? { key, describe: `Component ${key}` } : null;
		},
		itemKeyOf: (item) => as("component", item).name,
		send: async (ctx, key) => {
			const markupPath = `components/${key}.wc.html`;
			const propsPath = `components/${key}.json`;
			const markup = ctx.local.get(markupPath);
			const props = ctx.local.has(propsPath) ? parseJson(propsPath, ctx.local.get(propsPath)).props : undefined;
			const item = ctx.unit.item;
			if (item) {
				const component = as("component", item);
				const basedOn = ctx.force
					? undefined
					: (ctx.manifest.files[markupPath]?.version ?? ctx.manifest.files[propsPath]?.version);
				await ctx.send("components/saveMarkup", {
					componentId: component.id,
					markup: markupOf(markup ?? ctx.state.files.get(markupPath) ?? ""),
					...(props === undefined ? {} : { props }),
					...(basedOn === undefined ? {} : { basedOn }),
				});
			} else {
				const created = (await ctx.send("components/create", {
					name: key,
					...(props === undefined ? {} : { props }),
				})) as { component: { id: string } };
				if (markup !== undefined) {
					await ctx.send("components/saveMarkup", { componentId: created.component.id, markup: markupOf(markup) });
				}
			}
		},
	},
	template: {
		order: 4,
		pathOf: (path) => {
			const parts = path.split("/");
			if (parts[0] !== "templates") return null;
			if (parts.length === 2) {
				const kind = withoutSuffix(parts[1] ?? "", ".wc.html");
				if (kind === "site") return { key: "site", describe: "the Site template" };
				if (kind === "search") return { key: "search", describe: "the Search results template" };
				return null;
			}
			if (parts.length === 3 && (parts[1] === "entry" || parts[1] === "archive")) {
				const key = withoutSuffix(parts[2] ?? "", ".wc.html");
				return key && SAFE_NAME.test(key)
					? {
							key: `${parts[1]}:${key}`,
							describe: `the ${parts[1] === "entry" ? "Entry" : "Archive"} template of ${key}`,
						}
					: null;
			}
			return null;
		},
		itemKeyOf: (raw) => {
			const item = as("template", raw);
			return item.postType ? `${item.template}:${item.postType.key}` : item.template;
		},
		send: async (ctx, key) => {
			const [template, postTypeKey] = key.split(":");
			const path = postTypeKey ? `templates/${template}/${postTypeKey}.wc.html` : `templates/${template}.wc.html`;
			const markup = markupOf(ctx.local.get(path) ?? "");
			const base = ctx.manifest.files[path];
			const basedOn = ctx.force ? undefined : base ? (base.version ?? null) : null;
			const item = ctx.unit.item;
			const postTypeOnInstall = ctx.state.items.find((each) => each.kind === "postType" && each.key === postTypeKey);
			const postTypeId = item
				? as("template", item).postType?.id
				: postTypeOnInstall?.kind === "postType"
					? postTypeOnInstall.id
					: undefined;
			if (postTypeKey && !postTypeId) {
				throw new CliError(
					EXIT.usage,
					`${path}: there is no Post Type ${postTypeKey} on the Install. Add post-types/${postTypeKey}.json too.`,
				);
			}
			const input = { markup, ...(basedOn === undefined ? {} : { basedOn }) };
			if (template === "site") await ctx.send("templates/saveSiteTemplateMarkup", input);
			else if (template === "search") await ctx.send("templates/saveSearchTemplateMarkup", input);
			else if (template === "entry") await ctx.send("templates/saveEntryTemplateMarkup", { postTypeId, ...input });
			else await ctx.send("templates/saveArchiveTemplateMarkup", { postTypeId, ...input });
		},
	},
	form: {
		order: 6,
		pathOf: (path) => {
			const [folder, file, ...rest] = path.split("/");
			const key = folder === "forms" && rest.length === 0 ? withoutSuffix(file ?? "", ".json") : null;
			return key && SAFE_NAME.test(key) ? { key, describe: `Form ${key}` } : null;
		},
		itemKeyOf: (item) => as("form", item).key,
		send: async (ctx, key) => {
			const path = `forms/${key}.json`;
			const { name: title, ...form } = parseJson(path, ctx.local.get(path));
			const item = ctx.unit.item ? as("form", ctx.unit.item) : null;
			let formId: string;
			if (!item) {
				const created = (await ctx.send("forms/create", {
					name: typeof title === "string" ? title : key,
					key,
				})) as { form: { id: string } };
				formId = created.form.id;
			} else {
				formId = item.id;
				if (typeof title === "string" && title !== item.name) await ctx.send("forms/rename", { formId, name: title });
			}
			await ctx.send("forms/saveDraft", { formId, form });
		},
	},
	filter: {
		order: 7,
		pathOf: (path) => {
			const [folder, file, ...rest] = path.split("/");
			const key = folder === "filters" && rest.length === 0 ? withoutSuffix(file ?? "", ".json") : null;
			return key && SAFE_NAME.test(key) ? { key, describe: `Filter ${key}` } : null;
		},
		itemKeyOf: (item) => as("filter", item).name,
		send: async (ctx, key) => {
			const path = `filters/${key}.json`;
			const { loop, ...draft } = parseJson(path, ctx.local.get(path));
			const item = ctx.unit.item;
			if (item) {
				const filter = as("filter", item);
				const before = ctx.state.files.get(path);
				if (before && JSON.parse(before).loop !== loop) {
					throw new CliError(
						EXIT.usage,
						`${path}: a Filter's Loop can't change. Make a new Filter for the other Loop.`,
					);
				}
				await ctx.send("filters/saveDraft", { filterId: filter.id, ...draft });
			} else await ctx.send("filters/create", { name: key, loop, ...draft });
		},
	},
};

/** The unit a file belongs to, by its path. */
function unitOf(path: string): { key: string; order: number; describe: string } | null {
	for (const [kind, entry] of Object.entries(KINDS) as [StructureItem["kind"], Kind][]) {
		const found = entry.pathOf(path);
		if (found) return { key: found.key ? `${kind}:${found.key}` : kind, order: entry.order, describe: found.describe };
	}
	return null;
}

function itemKey(item: StructureItem): string {
	const suffix = KINDS[item.kind].itemKeyOf(item);
	return suffix ? `${item.kind}:${suffix}` : item.kind;
}

function itemOfPath(items: StructureItem[], path: string): StructureItem | null {
	const unit = unitOf(path);
	return unit ? (items.find((item) => itemKey(item) === unit.key) ?? null) : null;
}

/** Lines added and removed, counted as a person reads a change. */
function lineChanges(before: string | undefined, after: string): { added: number; removed: number } {
	const left = (before ?? "").split("\n");
	const right = after.split("\n");
	const counts = new Map<string, number>();
	for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of right) {
		const count = counts.get(line) ?? 0;
		if (count > 0) counts.set(line, count - 1);
		else added++;
	}
	const removed = [...counts.values()].reduce((sum, count) => sum + count, 0);
	return { added, removed };
}

type FileChange = { path: string; change: "changed" | "new"; added: number; removed: number };

async function push(context: RunContext, options: Options): Promise<number> {
	const { io } = context;
	const dir = resolve(io.cwd, options.dir);
	const manifest = await readManifest(dir);
	if (!manifest)
		throw new CliError(
			EXIT.usage,
			`There is no ${MANIFEST} in ${options.dir}: run webcraft structure pull --site-id <id> first.`,
		);
	const connection = await connect(context);
	if (manifest.install !== connection.url) {
		throw new CliError(
			EXIT.usage,
			`These files came from ${manifest.install}, not ${connection.url}. Push them with --install ${manifest.install}.`,
		);
	}
	const local = await readLocal(dir);
	const warn = (text: string) => io.stderr(`webcraft: ${text}\n`);
	const state = await readStructure(connection, manifest.site.id, warn);

	// What changed here since the pull, unit by unit.
	const changes: FileChange[] = [];
	const units = new Map<string, Unit>();
	for (const [path, content] of local) {
		const unit = unitOf(path);
		if (!unit) {
			warn(`${path} isn't a file structure push knows: it is left alone.`);
			continue;
		}
		const base = manifest.files[path];
		const server = state.files.get(path);
		const changed = base ? base.hash !== hashOf(content) : server !== content;
		if (!changed) continue;
		changes.push({
			path,
			change: base || server !== undefined ? "changed" : "new",
			...lineChanges(server ?? undefined, content),
		});
		const known = units.get(unit.key);
		const item = state.items.find((each) => itemKey(each) === unit.key) ?? null;
		units.set(unit.key, { ...unit, paths: [...(known?.paths ?? []), path], item });
	}
	// A unit is stale when the Install changed it since the pull: one of its files (or its Draft's version) moved.
	const stale: string[] = [];
	for (const unit of units.values()) {
		const paths = new Set([
			...unit.paths,
			...Object.keys(manifest.files).filter((path) => unitOf(path)?.key === unit.key),
			...[...state.files.keys()].filter((path) => unitOf(path)?.key === unit.key),
		]);
		for (const path of paths) {
			const base = manifest.files[path];
			const server = state.files.get(path);
			const moved = base
				? server === undefined || hashOf(server) !== base.hash
				: server !== undefined && server !== local.get(path);
			if (moved) {
				stale.push(path);
				break;
			}
		}
	}
	const removedHere = Object.keys(manifest.files).filter((path) => !local.has(path) && state.files.has(path));
	const changedThere = Object.entries(manifest.files)
		.filter(([path, base]) => {
			const server = state.files.get(path);
			return (
				local.has(path) && !units.has(unitOf(path)?.key ?? "") && server !== undefined && hashOf(server) !== base.hash
			);
		})
		.map(([path]) => path);

	const ordered = [...units.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
	if (context.options.json) {
		io.stdout(`${JSON.stringify({ changes, stale, removedHere, changedThere, dryRun: options.dryRun }, null, 2)}\n`);
	} else if (changes.length === 0) {
		io.stdout("Nothing to push: no file changed since the last pull.\n");
	} else {
		const lines = changes.map((each) => {
			const unit = unitOf(each.path);
			const note = unit?.key.startsWith("postType:") ? " (applies at once: Post Types have no Draft)" : "";
			const mark = stale.includes(each.path) ? "!" : each.change === "new" ? "+" : "~";
			return `  ${mark} ${each.path}  +${each.added} −${each.removed}${each.change === "new" ? ` (new: ${unit?.describe ?? ""})` : ""}${note}`;
		});
		io.stdout(
			`These changes go to ${state.site.name} on ${connection.url} as Drafts (nothing is published):\n${lines.join("\n")}\n`,
		);
	}
	if (!context.options.json) {
		if (removedHere.length > 0) {
			io.stderr(
				`Removed here, but never deleted on the Install by a push (delete them in the admin):\n${removedHere.map((path) => `  ${path}`).join("\n")}\n`,
			);
		}
		if (changedThere.length > 0) {
			io.stderr(
				`Changed on the Install since your pull (pull to get them):\n${changedThere.map((path) => `  ${path}`).join("\n")}\n`,
			);
		}
	}
	if (changes.length === 0) return EXIT.ok;
	if (stale.length > 0 && !options.force) {
		const items = [...new Set(stale.map((path) => unitOf(path)?.describe ?? path))];
		throw new CliError(
			EXIT.changedMeanwhile,
			`Nothing was sent: ${items.join(", ")} changed on the Install since your pull. Pull again and redo your change, or pass --force to overwrite what changed there.`,
		);
	}
	if (options.dryRun) return EXIT.ok;
	if (!context.options.yes) {
		if (!io.interactive) {
			io.stderr("Nothing was sent. Pass --yes to send these changes.\n");
			return EXIT.notConfirmed;
		}
		const answer = (await io.ask("Send these changes as Drafts? [y/N] ")).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") {
			io.stderr("Nothing was sent.\n");
			return EXIT.notConfirmed;
		}
	}

	const sent: string[] = [];
	try {
		for (const unit of ordered) {
			await sendUnit(connection, manifest, state, unit, local, options.force);
			sent.push(unit.key);
		}
	} finally {
		// What was sent is written back as the Install stored it, with its new base in the manifest,
		// and so is what a save changed besides (an inline style makes a Class) where nothing changed here.
		if (sent.length > 0) await refresh(connection, dir, manifest, sent, local, warn);
	}
	if (!context.options.json) {
		io.stdout(
			`Sent ${sent.length} change${sent.length === 1 ? "" : "s"} as Drafts. Publish them in the admin when they are ready.\n`,
		);
	}
	return EXIT.ok;
}

/**
 * Writes back the files of the units sent as the Install now has them, with their new bases, and the
 * files that were the same here as when pulled but changed there (a save can change another item: an
 * inline style makes a Class), so the next push of those isn't taken for stale.
 */
async function refresh(
	connection: Connection,
	dir: string,
	manifest: Manifest,
	sent: string[],
	local: Map<string, string>,
	warn: (text: string) => void,
) {
	const state = await readStructure(connection, manifest.site.id, warn);
	const files = new Map<string, string>();
	for (const [path, content] of state.files) {
		const wasSent = sent.includes(unitOf(path)?.key ?? "");
		const before = local.get(path);
		const base = manifest.files[path];
		// A file the same here as when pulled takes what the Install has now, and so does one the Install
		// made meanwhile that isn't here; one changed here is left alone.
		const untouchedHere =
			(base !== undefined && before !== undefined && hashOf(before) === base.hash) ||
			(base === undefined && before === undefined);
		if (!wasSent && (!untouchedHere || (base !== undefined && hashOf(content) === base.hash))) continue;
		files.set(path, content);
		manifest.files[path] = entryFor(state, path, content);
	}
	await writeFiles(dir, files);
	await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
}

function parseJson(path: string, text: string | undefined): Record<string, unknown> {
	try {
		const value = JSON.parse(text ?? "") as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// Said below.
	}
	throw new CliError(EXIT.usage, `${path} isn't a JSON object. Nothing more was sent.`);
}

/** Saves one unit's change on the Install, as a Draft (a Post Type applies at once), through `KINDS`. */
async function sendUnit(
	connection: Connection,
	manifest: Manifest,
	state: StructureState,
	unit: Unit,
	local: Map<string, string>,
	force: boolean,
): Promise<void> {
	const siteId = manifest.site.id;
	const send = (path: string, input: Record<string, unknown>) =>
		call(connection, { path, files: [] }, { siteId, ...input }) as Promise<Record<string, unknown>>;
	const [kind, ...rest] = unit.key.split(":") as [StructureItem["kind"], ...string[]];
	await KINDS[kind].send({ manifest, state, unit, local, force, send }, rest.join(":"));
}

/** The Design system's changed files as one Draft save (tokens imported first, as their own step). */
async function sendDesignSystem(
	send: (path: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
	state: StructureState,
	unit: Unit,
	local: Map<string, string>,
): Promise<void> {
	const changed = new Set(unit.paths);
	let draft: DesignSystemDraft = state.designSystem;
	if (changed.has("design-system/tokens.json")) {
		const tokens = parseJson("design-system/tokens.json", local.get("design-system/tokens.json"));
		const answered = (await send("designSystem/importTokens", { tokens })) as {
			designSystem: { draft: DesignSystemDraft };
		};
		draft = answered.designSystem.draft;
	}
	const change: Record<string, unknown> = {};
	const settingsPath = "design-system/design-system.json";
	const settings = local.has(settingsPath) ? parseJson(settingsPath, local.get(settingsPath)) : {};
	if (changed.has(settingsPath) && typeof settings.darkMode === "boolean" && settings.darkMode !== draft.darkMode) {
		change.darkMode = settings.darkMode;
	}
	if (changed.has("design-system/site.css")) change.customCss = local.get("design-system/site.css") ?? "";
	if (changed.has("design-system/base.css"))
		change.baseStyles = baseStylesOf(local.get("design-system/base.css") ?? "");
	const classesChanged =
		[...changed].some((path) => path.startsWith("design-system/classes/")) || changed.has(settingsPath);
	if (classesChanged) {
		const breakpoints = new Map(draft.tokens.breakpoints.map((breakpoint) => [breakpoint.name, breakpoint.id]));
		const order = Array.isArray(settings.classes)
			? (settings.classes as unknown[]).filter((name) => typeof name === "string")
			: [];
		const fileNames = [...local.keys()]
			.filter((path) => /^design-system\/classes\/[^/]+\.css$/.test(path))
			.map((path) => path.slice("design-system/classes/".length, -".css".length));
		const names = [...new Set([...(order as string[]), ...fileNames])];
		// A Class whose file is gone stays: a push never deletes.
		for (const each of draft.classes) if (!names.includes(each.name)) names.push(each.name);
		change.classes = names.map((name) => {
			const existing = draft.classes.find((each) => each.name === name);
			const path = `design-system/classes/${name}.css`;
			const text = local.get(path);
			if (text === undefined) {
				if (!existing) throw new CliError(EXIT.usage, `${settingsPath} lists the Class ${name}, which has no file.`);
				return { id: existing.id, name, styles: existing.styles, breakpoints: existing.breakpoints, css: existing.css };
			}
			return { ...(existing ? { id: existing.id } : {}), name, ...classOf(path, name, text, breakpoints) };
		});
	}
	if (Object.keys(change).length > 0) await send("designSystem/saveDraft", change);
}

/** A Class's file read back: its styles, each breakpoint's (by id) and its own CSS. */
function classOf(
	path: string,
	name: string,
	text: string,
	breakpoints: Map<string, string>,
): { styles: string; breakpoints: Record<string, string>; css: string } {
	const blocks = topLevelBlocks(text);
	const selector = `.${name}`;
	if (!blocks) throw new CliError(EXIT.usage, `${path}: a brace is left open or closed twice.`);
	const plain = blocks.filter((block) => block.prelude === selector);
	const others = blocks.filter((block) => block.prelude !== selector && !block.prelude.startsWith("@media"));
	if (plain.length > 2 || others.length > 0) {
		throw new CliError(
			EXIT.usage,
			`${path}: keep it as ${selector} { its styles }, then @media (--<breakpoint>) { ${selector} { … } } blocks, then ${selector} { its own CSS }.`,
		);
	}
	const byBreakpoint: Record<string, string> = {};
	for (const block of blocks.filter((each) => each.prelude.startsWith("@media"))) {
		const match = /^@media \(--([^)\s]+)\)$/.exec(block.prelude);
		const id = match ? breakpoints.get(match[1] ?? "") : undefined;
		if (!match || !id) {
			throw new CliError(
				EXIT.usage,
				`${path}: "${block.prelude}" names no breakpoint. Use @media (--<name>) with one of: ${[...breakpoints.keys()].join(", ")}.`,
			);
		}
		const inner = topLevelBlocks(block.body);
		if (inner?.length !== 1 || inner[0]?.prelude !== selector) {
			throw new CliError(EXIT.usage, `${path}: inside "${block.prelude}", write one ${selector} { … } block.`);
		}
		byBreakpoint[id] = dedent(inner[0].body);
	}
	return { styles: dedent(plain[0]?.body ?? ""), breakpoints: byBreakpoint, css: dedent(plain[1]?.body ?? "") };
}

/** The base styles' file read back: one block per element it styles. */
function baseStylesOf(text: string): Record<string, string> {
	const blocks = topLevelBlocks(text);
	if (!blocks) throw new CliError(EXIT.usage, "design-system/base.css: a brace is left open or closed twice.");
	return Object.fromEntries(blocks.map((block) => [block.prelude, dedent(block.body)]));
}
