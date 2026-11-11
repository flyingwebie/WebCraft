/** Migrate current Placements by declaration identity. Historical snapshots are immutable. */
import { components, entries, templates } from "@webcraft/db/schema";
import {
	type AttributePart,
	boundRoot,
	type ComponentCatalogue,
	childListsOf,
	type ElementTree,
	isComponentInfo,
	mappedBindingPath,
	type PlacementNode,
	type PropBinding,
	placementsIn,
	type TreeNode,
} from "@webcraft/renderer";
import { eq } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { ComponentVersion } from "./component-versions.ts";
import type { FieldDefinition } from "./fields.ts";
import { sameJson } from "./json.ts";
import { listPostTypes } from "./post-types.ts";

function successor(field: FieldDefinition, next: readonly FieldDefinition[]) {
	return field.id ? next.find((f) => f.id === field.id) : next.find((f) => f.key === field.key);
}

/** Keep the pre-change types until publish, following only explicit, unambiguous renames. */
export function propBaseline(before: ComponentVersion, next: readonly FieldDefinition[]): FieldDefinition[] {
	function renamed(
		fields: readonly FieldDefinition[],
		old: readonly FieldDefinition[],
		newer: readonly FieldDefinition[],
	): FieldDefinition[] {
		return [...fields, ...old.filter((field) => !successor(field, fields))].map((field) => {
			const was = successor(field, old);
			const now = was && successor(was, newer);
			if (!was || !now) return field;
			return {
				...field,
				key: now.key,
				...("fields" in field && "fields" in was && "fields" in now
					? { fields: renamed(field.fields, was.fields, now.fields) }
					: {}),
			};
		});
	}
	const baseline = before.propBaseline ?? before.props;
	const all = [...baseline, ...before.props.filter((f) => !successor(f, baseline))];
	return renamed(all, before.props, next);
}

function losesFields(before: FieldDefinition, next: FieldDefinition): boolean {
	if (!("fields" in before) || !("fields" in next)) return false;
	return before.fields.some((field) => {
		const after = successor(field, next.fields);
		return !after || field.type !== after.type || losesFields(field, after);
	});
}

/** All identity-backed paths, including unchanged prefixes needed to compose nested renames. */
function declarationPaths(
	before: readonly FieldDefinition[],
	next: readonly FieldDefinition[],
	from = "",
	to = "",
): [string, string][] {
	const pairs: [string, string][] = [];
	for (const field of before) {
		const fresh = field.id && next.find((f) => f.id === field.id);
		if (!fresh) continue;
		const old = from + field.key;
		const current = to + fresh.key;
		pairs.push([old, current]);
		if ("fields" in field && "fields" in fresh)
			pairs.push(...declarationPaths(field.fields, fresh.fields, `${old}.`, `${current}.`));
	}
	return pairs;
}

/** Omit redundant descendants but keep exceptions to a mapped prefix (even identity exceptions). */
function compactPaths(entries: Iterable<readonly [string, string]>): Record<string, string> {
	const paths: Record<string, string> = Object.create(null);
	const all = [...new Map(entries)].sort(([a], [b]) => a.split(".").length - b.split(".").length || a.localeCompare(b));
	for (const [target, source] of all) if (mappedBindingPath(target, paths) !== source) paths[target] = source;
	return Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
}

type Value = { name: string; value: string | AttributePart[]; binding?: PropBinding };
function migrateValues(
	values: Value[],
	before: readonly FieldDefinition[],
	next: readonly FieldDefinition[],
	drop: boolean,
): { values: Value[]; lost: boolean } {
	let lost = false;
	function json(value: unknown, old: FieldDefinition, fresh: FieldDefinition): unknown {
		if (!("fields" in old) || !("fields" in fresh)) return value;
		if (old.type === "repeater" && Array.isArray(value))
			return value.map((row) => json(row, { ...old, type: "group" }, { ...fresh, type: "group" } as FieldDefinition));
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		const result: Record<string, unknown> = {};
		for (const [key, part] of Object.entries(value)) {
			const previous = old.fields.find((f) => f.key === key);
			const current = previous && successor(previous, fresh.fields);
			if (previous && (!current || current.type !== previous.type)) {
				lost = true;
				if (drop) continue;
			}
			result[current?.key ?? key] =
				previous && current && previous.type === current.type ? json(part, previous, current) : part;
		}
		return result;
	}
	const migrated: Value[] = [];
	for (const value of values) {
		const old = before.find((f) => f.key === value.name);
		if (!old) {
			migrated.push(value);
			continue;
		}
		const fresh = successor(old, next);
		if (!fresh || old.type !== fresh.type) {
			lost = true;
			if (drop) continue;
		}
		let written = value.value;
		// A binding reads someone else's Group/Repeater; never rewrite that Entry's values.
		if (fresh && Array.isArray(written) && written.some((part) => part.type === "value") && losesFields(old, fresh)) {
			lost = true;
			if (drop) continue;
		}
		if (fresh && "fields" in old && old.type === fresh.type) {
			const migrateText = (text: string) => {
				try {
					const original: unknown = JSON.parse(text);
					const updated = json(original, old, fresh);
					return sameJson(original, updated) ? text : JSON.stringify(updated);
				} catch {
					return text;
				}
			};
			if (typeof written === "string") written = migrateText(written);
			else if (written.every((p) => p.type === "text")) {
				const parts = written.filter((p) => p.type === "text");
				const languages = new Set(parts.flatMap((p) => Object.keys(p.translations ?? {})));
				const text = parts.map((p) => p.text).join("");
				const translations = Object.fromEntries(
					[...languages].map((language) => [
						language,
						migrateText(parts.map((p) => p.translations?.[language] ?? p.text).join("")),
					]),
				);
				const changed = migrateText(text);
				if (
					changed !== text ||
					parts.some((p) =>
						Object.entries(p.translations ?? {}).some(([language, value]) => translations[language] !== value),
					)
				) {
					written = [{ type: "text", text: changed, ...(languages.size ? { translations } : {}) }];
				}
			}
		}
		let binding = value.binding;
		const root = Array.isArray(written) ? boundRoot(written) : undefined;
		if (root && fresh && "fields" in old && "fields" in fresh) {
			const pairs = declarationPaths(old.fields, fresh.fields);
			const renames = Object.fromEntries(pairs.filter(([from, to]) => from !== to));
			const prior = binding?.paths ?? {};
			const paths = compactPaths([
				...Object.entries(prior).map(([key, source]) => [mappedBindingPath(key, renames), source] as const),
				...pairs.map(([from, to]) => [to, mappedBindingPath(from, prior)] as const),
			]);
			binding = Object.keys(paths).length ? { root, paths } : undefined;
		}
		const { binding: _, ...plain } = value;
		migrated.push({ ...plain, name: fresh?.key ?? value.name, value: written, ...(binding ? { binding } : {}) });
	}
	return { values: migrated, lost };
}

/**
 * The other side of a rename: this Component supplies a whole Group/Repeater to a nested Placement.
 * Project only an existing, unchanged binding; a fresh/replaced binding uses the new contract.
 * Keep paths relative to this immediate Component, so nested Components compose at render time.
 */
export function projectSourceBindings(
	tree: ElementTree,
	previous: ElementTree,
	before: readonly FieldDefinition[],
	next: readonly FieldDefinition[],
	catalogue: ComponentCatalogue,
): ElementTree {
	const renames = Object.fromEntries(declarationPaths(before, next, "props.", "props.").filter(([a, b]) => a !== b));
	if (!Object.keys(renames).length) return tree;
	const old = new Map(scopedPlacements(previous).map((placed) => [placed.node.id, placed]));
	const result = structuredClone(tree);
	for (const { node, resolve } of scopedPlacements(result)) {
		const was = old.get(node.id);
		if (!was || was.node.component !== node.component) continue;
		const component = catalogue.byId(node.component);
		if (!isComponentInfo(component)) continue;
		for (const value of node.props) {
			const prior = was.node.props.find((p) => p.name === value.name);
			const root = boundRoot(value.value);
			const oldRoot = prior && boundRoot(prior.value);
			const allowed = component.props.find((p) => p.key === value.name)?.bindingPaths;
			if (!root || !oldRoot || !allowed) continue;
			const sourceRoot = resolve(root);
			const previousRoot = was.resolve(oldRoot);
			if (sourceRoot !== previousRoot && sourceRoot !== mappedBindingPath(previousRoot, renames)) continue;
			const paths = compactPaths(
				[...new Set([...allowed, ...Object.keys(value.binding?.paths ?? {})])].map((target) => {
					const source = mappedBindingPath(target, value.binding?.paths ?? {});
					const renamed = mappedBindingPath(`${previousRoot}.${source}`, renames);
					return [
						target,
						renamed.startsWith(`${sourceRoot}.`) ? renamed.slice(sourceRoot.length + 1) : source,
					] as const;
				}),
			);
			if (Object.keys(paths).length) value.binding = { root, paths };
			else delete value.binding;
		}
	}
	return result;
}

/** Loop aliases still refer to this Component's contract; metadata keeps the written bound root. */
function scopedPlacements(tree: ElementTree) {
	const found: { node: PlacementNode; resolve: (path: string) => string }[] = [];
	const visit = (nodes: readonly TreeNode[], aliases: Readonly<Record<string, string>>) => {
		const resolve = (path: string) => mappedBindingPath(path, aliases);
		for (const node of nodes) {
			if (node.type === "component") found.push({ node, resolve });
			else if (node.type === "loop") {
				visit(node.children, { ...aliases, [node.alias]: resolve(node.source) });
				if (node.empty) visit(node.empty, aliases);
			} else for (const children of childListsOf(node)) visit(children, aliases);
		}
	};
	visit(tree.nodes, {});
	return found;
}

/** Legacy/shared clients may omit metadata. Keep it only on the same Placement and bound root. */
export function retainPropBindings(tree: ElementTree, previous: ElementTree): ElementTree {
	const old = new Map([...placementsIn(previous.nodes)].map((node) => [node.id, node]));
	const result = structuredClone(tree);
	for (const node of placementsIn(result.nodes)) {
		const was = old.get(node.id);
		if (!was || was.component !== node.component) continue;
		for (const value of node.props) {
			const prior = was.props.find((p) => p.name === value.name);
			if (!value.binding && prior?.binding && boundRoot(value.value) === prior.binding.root)
				value.binding = structuredClone(prior.binding);
		}
	}
	return result;
}

function migrateTree(
	tree: ElementTree,
	componentId: string,
	before: readonly FieldDefinition[],
	next: readonly FieldDefinition[],
	drop: boolean,
	lose: (id: string) => void,
) {
	const visit = (nodes: TreeNode[]) => {
		for (const node of nodes) {
			if (node.type === "component" && node.component === componentId) {
				const result = migrateValues(node.props, before, next, drop);
				node.props = result.values as typeof node.props;
				if (result.lost) lose(node.id);
			}
			for (const list of childListsOf(node)) visit(list as TreeNode[]);
		}
	};
	visit(tree.nodes);
}

export type PropImpact = { placements: number; message: string | null };
/** Draft renames now; destructive changes and live renames only on publish. Counts deduplicate Draft/live copies. */
export async function migratePropPlacements(
	scope: SiteScope,
	componentId: string,
	before: ComponentVersion,
	next: ComponentVersion,
	mode: "rename" | "publish" | "preview",
	published: ComponentVersion | null = null,
): Promise<PropImpact> {
	const losing = new Set<string>();
	const drop = mode !== "rename";
	for (const [table, kind] of [
		[templates, "template"],
		[components, "component"],
	] as const) {
		const rows =
			mode === "preview"
				? await scope.select(table)
				: await scope.db.select().from(table).where(scope.where(table)).orderBy(table.id).for("update");
		for (const row of rows) {
			if (kind === "component" && row.id === componentId) continue;
			const change: { draft?: unknown; published?: unknown } = {};
			for (const which of ["draft", "published"] as const) {
				if (row[which] === null || (mode === "rename" && which === "published")) continue;
				if (mode === "publish" && which === "draft" && !sameJson(before.props, next.props)) continue;
				const version = structuredClone(row[which]);
				const tree = (kind === "template" ? version : (version as ComponentVersion).tree) as ElementTree;
				const from =
					which === "published"
						? (published?.props ?? before.props)
						: mode === "rename"
							? before.props
							: (before.propBaseline ?? before.props);
				migrateTree(tree, componentId, from, next.props, drop, (id) => losing.add(`${kind}:${row.id}:${id}`));
				if (!sameJson(version, row[which])) change[which] = version;
			}
			if (mode !== "preview" && Object.keys(change).length) {
				await scope.update(
					table,
					{
						...change,
						...(change.draft
							? {
									updatedAt: scope.now(),
									updatedBy: personIdOf(scope.access.actor),
									updatedVia: clientNameOf(scope.access.via),
								}
							: {}),
					},
					eq(table.id, row.id),
				);
				if (change.draft)
					await noteDraftChange(
						scope,
						{ kind, id: row.id },
						{ content: row.draft, changedAt: row.updatedAt, changedBy: row.updatedBy, since: row.createdAt },
						change.draft,
					);
			}
		}
	}
	// Bodies always use the published Prop contract, including in an Entry Draft.
	if (mode !== "rename") {
		const types = await listPostTypes(scope);
		const rows =
			mode === "preview"
				? await scope.select(entries)
				: await scope.db.select().from(entries).where(scope.where(entries)).orderBy(entries.id).for("update");
		for (const row of rows) {
			const body = types.find((t) => t.id === row.postTypeId)?.fields.find((f) => f.type === "body");
			if (!body) continue;
			const change: { draft?: unknown; published?: unknown } = {};
			for (const which of ["draft", "published"] as const) {
				if (!row[which]) continue;
				const version = structuredClone(row[which]) as {
					values: Record<string, Record<string, { value?: unknown; source?: unknown }>>;
				};
				for (const [language, leaf] of Object.entries(version.values[body.key] ?? {})) {
					for (const key of ["value", "source"] as const) {
						if (!Array.isArray(leaf[key])) continue;
						for (const block of leaf[key]) {
							if (block.type !== "component" || block.component !== componentId) continue;
							const result = migrateValues(block.props, published?.props ?? before.props, next.props, true);
							block.props = result.values;
							if (key === "value" && result.lost) losing.add(`entry:${row.id}:${language}:${block.id}`);
						}
					}
				}
				if (!sameJson(version, row[which])) change[which] = version;
			}
			if (mode !== "preview" && Object.keys(change).length) {
				await scope.update(
					entries,
					{
						...change,
						...(change.draft
							? {
									updatedAt: scope.now(),
									updatedBy: personIdOf(scope.access.actor),
									updatedVia: clientNameOf(scope.access.via),
								}
							: {}),
					},
					eq(entries.id, row.id),
				);
				if (change.draft)
					await noteDraftChange(
						scope,
						{ kind: "entry", id: row.id },
						{ content: row.draft, changedAt: row.updatedAt, changedBy: row.updatedBy, since: row.createdAt },
						change.draft,
					);
			}
		}
	}
	return {
		placements: losing.size,
		message: losing.size ? `${losing.size} Placement${losing.size === 1 ? " loses its" : "s lose their"} value` : null,
	};
}

/** Settings edits rename the Component's own bindings; literal strings never stand for paths. */
export function renamePropBindings(
	tree: ElementTree,
	before: readonly FieldDefinition[],
	next: readonly FieldDefinition[],
): ElementTree {
	const names = new Map<string, string>();
	const collect = (old: readonly FieldDefinition[], fresh: readonly FieldDefinition[], prefix: string, to: string) => {
		for (const field of old) {
			const current = successor(field, fresh);
			if (!current) continue;
			const from = `${prefix}.${field.key}`;
			const target = `${to}.${current.key}`;
			if (from !== target) names.set(from, target);
			if ("fields" in field && "fields" in current) collect(field.fields, current.fields, from, target);
		}
	};
	collect(before, next, "props", "props");
	const paths = [...names].sort(([a], [b]) => b.length - a.length);
	const path = (value: string) => {
		const match = paths.find(([from]) => value === from || value.startsWith(`${from}.`));
		return match ? match[1] + value.slice(match[0].length) : value;
	};
	const result = structuredClone(tree);
	const visit = (value: unknown, aliases: Readonly<Record<string, string>> = {}) => {
		const renamed = (written: string) => {
			const root = written.split(".")[0] ?? "";
			const source = aliases[root];
			if (!source) return path(written);
			const mapped = path(source + written.slice(root.length));
			const nextRoot = path(source);
			return mapped === nextRoot || mapped.startsWith(`${nextRoot}.`) ? root + mapped.slice(nextRoot.length) : written;
		};
		if (Array.isArray(value)) {
			for (const child of value) visit(child, aliases);
			return;
		}
		if (!value || typeof value !== "object") return;
		const node = value as Record<string, unknown>;
		if (node.type === "component") {
			for (const prop of (node as unknown as PlacementNode).props)
				if (prop.binding) prop.binding.root = renamed(prop.binding.root);
		}
		if (node.type === "value" && typeof node.path === "string") node.path = renamed(node.path);
		if (node.type === "loop" && typeof node.source === "string" && typeof node.alias === "string") {
			const source = mappedBindingPath(node.source, aliases);
			node.source = renamed(node.source);
			visit(node.children, { ...aliases, [node.alias]: source });
			visit(node.empty, aliases);
			return;
		}
		for (const child of Object.values(node)) visit(child, aliases);
	};
	visit(result);
	return result;
}
