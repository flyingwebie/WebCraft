import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { CliError, EXIT } from "../exit-codes.ts";
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
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const [flag, inline] = arg.includes("=")
			? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
			: [arg, undefined];
		const value = () => {
			const found = inline ?? args[++index];
			if (!found) throw new CliError(EXIT.usage, `${flag} needs a value.`);
			return found;
		};
		if (flag === "--site-id" && command === "pull") options.siteId = value();
		else if (flag === "--dir") options.dir = value();
		else if (flag === "--force") options.force = true;
		else if (flag === "--dry-run" && command === "push") options.dryRun = true;
		else
			throw new CliError(
				EXIT.usage,
				`webcraft structure ${command} has no option ${arg}. See webcraft structure ${command} --help.`,
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

/** The unit a file belongs to, by its path. */
function unitOf(path: string): { key: string; order: number; describe: string } | null {
	const parts = path.split("/");
	const name = (file: string, suffix: string) => (file.endsWith(suffix) ? file.slice(0, -suffix.length) : null);
	if (parts[0] === "post-types" && parts.length === 2) {
		const key = name(parts[1] ?? "", ".json");
		return key && SAFE_NAME.test(key) ? { key: `postType:${key}`, order: 0, describe: `Post Type ${key}` } : null;
	}
	if (parts[0] === "design-system") return { key: "designSystem", order: 1, describe: "the Design system" };
	if (parts[0] === "loops" && parts.length === 2) {
		const loop = name(parts[1] ?? "", ".json");
		return loop && SAFE_NAME.test(loop) ? { key: `loop:${loop}`, order: 2, describe: `Loop ${loop}` } : null;
	}
	if (parts[0] === "components" && parts.length === 2) {
		const component = name(parts[1] ?? "", ".wc.html") ?? name(parts[1] ?? "", ".json");
		return component && SAFE_NAME.test(component)
			? { key: `component:${component}`, order: 3, describe: `Component ${component}` }
			: null;
	}
	if (parts[0] === "templates") {
		if (parts.length === 2) {
			const kind = name(parts[1] ?? "", ".wc.html");
			if (kind === "site" || kind === "search") {
				return {
					key: `template:${kind}`,
					order: 4,
					describe: kind === "site" ? "the Site template" : "the Search results template",
				};
			}
		}
		if (parts.length === 3 && (parts[1] === "entry" || parts[1] === "archive")) {
			const key = name(parts[2] ?? "", ".wc.html");
			if (key && SAFE_NAME.test(key)) {
				return {
					key: `template:${parts[1]}:${key}`,
					order: 5,
					describe: `the ${parts[1] === "entry" ? "Entry" : "Archive"} template of ${key}`,
				};
			}
		}
		return null;
	}
	if (parts[0] === "forms" && parts.length === 2) {
		const key = name(parts[1] ?? "", ".json");
		return key && SAFE_NAME.test(key) ? { key: `form:${key}`, order: 6, describe: `Form ${key}` } : null;
	}
	if (parts[0] === "filters" && parts.length === 2) {
		const filter = name(parts[1] ?? "", ".json");
		return filter && SAFE_NAME.test(filter)
			? { key: `filter:${filter}`, order: 7, describe: `Filter ${filter}` }
			: null;
	}
	return null;
}

function itemKey(item: StructureItem): string {
	switch (item.kind) {
		case "template":
			return item.postType ? `template:${item.template}:${item.postType.key}` : `template:${item.template}`;
		case "component":
			return `component:${item.name}`;
		case "designSystem":
			return "designSystem";
		case "postType":
			return `postType:${item.key}`;
		case "loop":
			return `loop:${item.name}`;
		case "form":
			return `form:${item.key}`;
		case "filter":
			return `filter:${item.name}`;
	}
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

/** Saves one unit's change on the Install, as a Draft (a Post Type applies at once). */
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
	const [kind, ...rest] = unit.key.split(":");
	const name = rest.join(":");
	const item = unit.item;

	if (kind === "postType") {
		const path = `post-types/${name}.json`;
		const file = parseJson(path, local.get(path));
		if (item?.kind === "postType") await send("postTypes/update", { postTypeId: item.id, ...file });
		else await send("postTypes/create", { key: name, ...file });
		return;
	}
	if (kind === "loop") {
		const path = `loops/${name}.json`;
		const { source, query, fields } = parseJson(path, local.get(path));
		if (item?.kind === "loop") await send("loops/saveDraft", { loopId: item.id, source, query, fields });
		else await send("loops/create", { name, source, query, fields });
		return;
	}
	if (kind === "form") {
		const path = `forms/${name}.json`;
		const { name: title, ...form } = parseJson(path, local.get(path));
		let formId = item?.kind === "form" ? item.id : null;
		if (!formId) {
			const created = (await send("forms/create", { name: typeof title === "string" ? title : name, key: name })) as {
				form: { id: string };
			};
			formId = created.form.id;
		} else if (item?.kind === "form" && typeof title === "string" && title !== item.name) {
			await send("forms/rename", { formId, name: title });
		}
		await send("forms/saveDraft", { formId, form });
		return;
	}
	if (kind === "filter") {
		const path = `filters/${name}.json`;
		const { loop, ...draft } = parseJson(path, local.get(path));
		if (item?.kind === "filter") {
			const before = state.files.get(path);
			if (before && JSON.parse(before).loop !== loop) {
				throw new CliError(EXIT.usage, `${path}: a Filter's Loop can't change. Make a new Filter for the other Loop.`);
			}
			await send("filters/saveDraft", { filterId: item.id, ...draft });
		} else await send("filters/create", { name, loop, ...draft });
		return;
	}
	if (kind === "component") {
		const markupPath = `components/${name}.wc.html`;
		const propsPath = `components/${name}.json`;
		const markup = local.get(markupPath);
		const props = local.has(propsPath) ? parseJson(propsPath, local.get(propsPath)).props : undefined;
		if (item?.kind === "component") {
			const basedOn = force ? undefined : (manifest.files[markupPath]?.version ?? manifest.files[propsPath]?.version);
			await send("components/saveMarkup", {
				componentId: item.id,
				markup: markupOf(markup ?? state.files.get(markupPath) ?? ""),
				...(props === undefined ? {} : { props }),
				...(basedOn === undefined ? {} : { basedOn }),
			});
		} else {
			const created = (await send("components/create", { name, ...(props === undefined ? {} : { props }) })) as {
				component: { id: string };
			};
			if (markup !== undefined) {
				await send("components/saveMarkup", { componentId: created.component.id, markup: markupOf(markup) });
			}
		}
		return;
	}
	if (kind === "template") {
		const [template, postTypeKey] = rest;
		const path = postTypeKey ? `templates/${template}/${postTypeKey}.wc.html` : `templates/${template}.wc.html`;
		const markup = markupOf(local.get(path) ?? "");
		const base = manifest.files[path];
		const basedOn = force ? undefined : base ? (base.version ?? null) : null;
		const postTypeOnInstall = state.items.find((each) => each.kind === "postType" && each.key === postTypeKey);
		const postTypeId =
			item?.kind === "template"
				? item.postType?.id
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
		if (template === "site") await send("templates/saveSiteTemplateMarkup", input);
		else if (template === "search") await send("templates/saveSearchTemplateMarkup", input);
		else if (template === "entry") await send("templates/saveEntryTemplateMarkup", { postTypeId, ...input });
		else await send("templates/saveArchiveTemplateMarkup", { postTypeId, ...input });
		return;
	}
	if (kind === "designSystem") await sendDesignSystem(send, state, unit, local);
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
