/** Migrate current Placements by declaration identity. Historical snapshots are immutable. */
import { components, entries, templates } from "@webcraft/db/schema";
import {
	type AttributePart,
	boundRoot,
	type ComponentCatalogue,
	childListsOf,
	type ElementTree,
	ElementTreeInvalidError,
	isComponentInfo,
	mappedBindingPath,
	type PlacementNode,
	type PropBinding,
	placementsIn,
	RETAINED_KEY,
	type RetainedJsonValue,
	retainedPropProblem,
	retainedPropsProblem,
	retainedValueIdentity,
	retainedValues,
	type TreeNode,
	textProblem,
} from "@webcraft/renderer";
import { eq, sql } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { isUuid } from "../ids.ts";
import { actingPerson, personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ComponentVersion, storedComponentVersion } from "./component-versions.ts";
import type { SiteComponents } from "./components.ts";
import { ComponentInvalidError } from "./errors.ts";
import { linksIn } from "./field-values.ts";
import type { FieldDefinition } from "./fields.ts";
import { sameJson } from "./json.ts";
import { siteLanguages } from "./languages.ts";
import { reconcilePlacementValues } from "./page-layout-props.ts";
import { layoutLinks } from "./page-layouts.ts";
import { getPostType, listPostTypes } from "./post-types.ts";
import { readRetainedContract } from "./prop-contracts.ts";
import { saveLinks } from "./relationships.ts";
import { storedVersion } from "./values.ts";

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

/** Legacy values use baseline types. Marked values use current types plus deleted identities. */
export function retainedContract(
	current: readonly FieldDefinition[],
	baseline: readonly FieldDefinition[] = [],
	legacyTypes = true,
): FieldDefinition[] {
	return [
		...current.map((field) => {
			const old = successor(field, baseline);
			if (!old) return field;
			return {
				...(legacyTypes ? old : field),
				key: field.key,
				...("fields" in field && "fields" in old
					? { fields: retainedContract(field.fields, old.fields, legacyTypes) }
					: {}),
			};
		}),
		...baseline.filter((field) => !successor(field, current)),
	];
}

function losesFields(before: FieldDefinition, next: FieldDefinition): boolean {
	if (!("fields" in before) || !("fields" in next)) return false;
	return before.fields.some((field) => {
		const after = successor(field, next.fields);
		return !after || field.type !== after.type || losesFields(field, after);
	});
}

/** Only deletion is safely projected out of a bound value; type changes still invalidate it. */
function changesFieldTypes(before: FieldDefinition, next: FieldDefinition): boolean {
	if (!("fields" in before) || !("fields" in next)) return false;
	return before.fields.some((field) => {
		const current = successor(field, next.fields);
		return current && (current.type !== field.type || changesFieldTypes(field, current));
	});
}
function reusesNames(before: readonly FieldDefinition[], next: readonly FieldDefinition[]): boolean {
	const old = identityPaths(before);
	const fresh = identityPaths(next);
	return old.some((field) => !fresh.some((f) => f.id === field.id) && fresh.some((f) => f.path === field.path));
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

/** Flat, identity-addressed nested declarations, including retained identities with reused names. */
function identityPaths(fields: readonly FieldDefinition[], prefix = ""): { id: string; path: string }[] {
	return fields.flatMap((field) => [
		...(field.id ? [{ id: field.id, path: prefix + field.key }] : []),
		...("fields" in field ? identityPaths(field.fields, `${prefix}${field.key}.`) : []),
	]);
}

/** Omit redundant descendants but keep exceptions to a mapped prefix (even identity exceptions). */
function compactPaths(entries: Iterable<readonly [string, string]>): Record<string, string> {
	const paths: Record<string, string> = Object.create(null);
	const all = [...new Map(entries)].sort(([a], [b]) => a.split(".").length - b.split(".").length || a.localeCompare(b));
	for (const [target, source] of all) if (mappedBindingPath(target, paths) !== source) paths[target] = source;
	return Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
}

function checkStoredContract(contract: Record<string, unknown>, id: string): void {
	try {
		readRetainedContract(contract, id);
	} catch (error) {
		throw new ComponentInvalidError([{ at: "props", message: (error as Error).message }]);
	}
}

type Value = {
	name: string;
	value: string | AttributePart[];
	binding?: PropBinding;
	retained?: string;
	contract?: Record<string, unknown>;
};
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
		const held: RetainedJsonValue[] = [];
		const object = value as Record<string, unknown>;
		const parts = [
			...Object.entries(object)
				.filter(([key]) => key !== RETAINED_KEY)
				.map(([name, value]) => ({ name, value, id: undefined as string | undefined })),
			...retainedValues(object[RETAINED_KEY]),
		];
		for (const part of parts) {
			const previous =
				"contract" in part && part.contract && part.id
					? readRetainedContract(part.contract, part.id)
					: old.fields.find((f) => (part.id ? f.id === part.id : f.key === part.name));
			const current = previous && successor(previous, fresh.fields);
			if (previous && (!current || current.type !== previous.type)) {
				lost = true;
				if (drop) continue;
			}
			if (
				previous?.id &&
				((current && current.type !== previous.type) ||
					(!current && (part.id || fresh.fields.some((f) => f.key === part.name))))
			) {
				held.push({
					id: previous.id,
					name: part.name,
					value: part.value,
					...(current?.type !== previous.type || ("contract" in part && part.contract) ? { contract: previous } : {}),
				});
			} else {
				result[current?.key ?? part.name] =
					previous && current && previous.type === current.type ? json(part.value, previous, current) : part.value;
			}
		}
		if (held.length > 256)
			throw new ComponentInvalidError([
				{ at: "props", message: "At most 256 retained values per Group or Repeater row." },
			]);
		for (const value of held) if (value.contract) checkStoredContract(value.contract, value.id);
		if (held.length) result[RETAINED_KEY] = held;
		return result;
	}
	const migrated: Value[] = [];
	for (const value of values) {
		const old = value.contract
			? readRetainedContract(value.contract, value.retained ?? String(value.contract.id))
			: before.find((f) => (value.retained ? f.id === value.retained : f.key === value.name));
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
			if (
				drop &&
				!(
					"fields" in old &&
					"fields" in fresh &&
					reusesNames(old.fields, fresh.fields) &&
					!changesFieldTypes(old, fresh)
				)
			)
				continue;
		}
		if (fresh && "fields" in old && old.type === fresh.type) {
			const migrateText = (text: string) => {
				let original: unknown;
				try {
					original = JSON.parse(text);
				} catch {
					return text;
				}
				const updated = json(original, old, fresh);
				const written = sameJson(original, updated) ? text : JSON.stringify(updated);
				const problem = textProblem(written);
				if (problem) throw new ComponentInvalidError([{ at: "props", message: problem }]);
				return written;
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
		if (root && fresh && "fields" in old && "fields" in fresh && !changesFieldTypes(old, fresh)) {
			const pairs = declarationPaths(old.fields, fresh.fields);
			const prior = binding?.paths ?? {};
			const retained: Record<string, string> = Object.assign(Object.create(null), binding?.retained);
			const was = identityPaths(old.fields);
			const now = identityPaths(fresh.fields);
			for (const field of was) {
				if (!now.some((f) => f.id === field.id) && now.some((f) => f.path === field.path) && !retained[field.id])
					retained[field.id] = mappedBindingPath(field.path, prior);
			}
			const paths = compactPaths(
				pairs.map(([from, to]) => {
					const identity = now.find((f) => f.path === to)?.id;
					return [to, (identity && retained[identity]) || mappedBindingPath(from, prior)] as const;
				}),
			);
			for (const field of now) delete retained[field.id];
			if (drop) for (const id of Object.keys(retained)) delete retained[id];
			const missing =
				binding?.missing && pairs.filter(([from]) => binding?.missing?.includes(from)).map(([, to]) => to);
			const sources =
				binding?.sources &&
				Object.fromEntries(
					pairs.flatMap(([from, to]) => (binding?.sources?.[from] ? [[to, binding.sources[from]]] : [])),
				);
			binding =
				Object.keys(paths).length ||
				Object.keys(retained).length ||
				(sources && Object.keys(sources).length) ||
				missing?.length
					? {
							root,
							paths,
							...(Object.keys(retained).length ? { retained } : {}),
							...(missing?.length ? { missing } : {}),
							...(sources && Object.keys(sources).length ? { sources } : {}),
						}
					: undefined;
		}
		const { binding: _, retained: __, contract: ___, ...plain } = value;
		const collision = !fresh && next.some((field) => field.key === value.name);
		const incompatible = fresh && (old.type !== fresh.type || (root && changesFieldTypes(old, fresh)));
		const retained = incompatible || (!fresh && (value.retained || value.contract || collision)) ? old.id : undefined;
		migrated.push({
			...plain,
			name: fresh?.key ?? value.name,
			value: written,
			...(binding ? { binding } : {}),
			...(retained ? { retained, ...(incompatible || value.contract ? { contract: old } : {}) } : {}),
		});
	}
	if (values.some((value) => value.retained))
		migrated.sort((a, b) => {
			const rank = (value: Value) => (value.retained ? next.length : next.findIndex((f) => f.key === value.name));
			return rank(a) - rank(b);
		});
	migrated.sort((a, b) => Number(Boolean(a.retained)) - Number(Boolean(b.retained)));
	const held = migrated.filter((p) => p.retained);
	const retentionProblem = retainedPropsProblem(held);
	if (retentionProblem) throw new ComponentInvalidError([{ at: "props", message: retentionProblem }]);
	for (const value of held) {
		if (value.contract && value.retained) checkStoredContract(value.contract, value.retained);
		const problem = retainedPropProblem(value);
		if (problem) throw new ComponentInvalidError([{ at: "props", message: problem }]);
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
	if (sameJson(before, next)) return tree;
	const old = new Map(scopedPlacements(previous).map((placed) => [placed.node.id, placed]));
	const result = structuredClone(tree);
	for (const { node, resolve } of scopedPlacements(result)) {
		const was = old.get(node.id);
		if (!was || was.node.component !== node.component) continue;
		const component = catalogue.byId(node.component);
		if (!isComponentInfo(component)) continue;
		for (const value of node.props) {
			const prior = was.node.props.find((p) => p.name === value.name && p.retained === value.retained);
			const root = boundRoot(value.value);
			const oldRoot = prior && boundRoot(prior.value);
			const allowed = (
				value.retained
					? component.retainedProps?.find((p) => p.id === value.retained)
					: component.props.find((p) => p.key === value.name)
			)?.bindingPaths;
			if (!root || !oldRoot || !allowed) continue;
			const sourceRoot = resolve(root);
			const previousRoot = was.resolve(oldRoot);
			if (sourceRoot !== previousRoot && sourceRoot !== mappedBindingPath(previousRoot, renames)) continue;
			const wasFields = identityPaths(before, "props.");
			const nowFields = identityPaths(next, "props.");
			const collision = wasFields.some(
				(field) => !nowFields.some((f) => f.id === field.id) && nowFields.some((f) => f.path === field.path),
			);
			const sources: Record<string, string> = Object.assign(
				Object.create(null),
				prior.binding?.sources,
				value.binding?.sources,
			);
			const missing: string[] = [];
			const paths = compactPaths(
				[...new Set([...allowed, ...Object.keys(value.binding?.paths ?? {})])].map((target) => {
					const source = mappedBindingPath(target, value.binding?.paths ?? {});
					const absolute = `${previousRoot}.${source}`;
					const id = sources[target] ?? wasFields.find((f) => f.path === absolute)?.id;
					const byIdentity = id && nowFields.find((f) => f.id === id)?.path;
					// Remember a source from its first deletion, before a later save can reuse its name.
					if (id && (!byIdentity || collision || Object.keys(sources).length)) sources[target] = id;
					if (id && !byIdentity && sources[target]) missing.push(target);
					const renamed = byIdentity || mappedBindingPath(absolute, renames);
					return [
						target,
						renamed.startsWith(`${sourceRoot}.`) ? renamed.slice(sourceRoot.length + 1) : source,
					] as const;
				}),
			);
			if (Object.keys(paths).length || Object.keys(sources).length || missing.length || value.binding?.retained)
				value.binding = {
					root,
					paths,
					...(missing.length ? { missing } : {}),
					...(value.binding?.retained ? { retained: value.binding.retained } : {}),
					...(Object.keys(sources).length ? { sources } : {}),
				};
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
		for (const held of was.props.filter((p) => p.retained))
			if (
				!node.props.some(
					(p) =>
						p.retained === held.retained &&
						retainedValueIdentity(String(p.retained), p.contract) ===
							retainedValueIdentity(String(held.retained), held.contract),
				)
			)
				node.props.push(structuredClone(held));
		const retentionProblem = retainedPropsProblem(node.props);
		if (retentionProblem) throw new ComponentInvalidError([{ at: "props", message: retentionProblem }]);
		for (const value of node.props) {
			const prior = was.props.find(
				(p) =>
					p.name === value.name &&
					p.retained === value.retained &&
					(!value.retained ||
						retainedValueIdentity(value.retained, value.contract) ===
							retainedValueIdentity(value.retained, p.contract)),
			);
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
						: retainedContract(before.props, before.propBaseline, before.propValueVersion !== 1);
				migrateTree(tree, componentId, from, next.props, drop, (id) => losing.add(`${kind}:${row.id}:${id}`));
				if (!sameJson(version, row[which])) change[which] = version;
			}
			if (mode !== "preview" && Object.keys(change).length) await saveMigratedVersions(scope, table, kind, row, change);
		}
	}
	// Page layouts are Content: like Body placements they follow published Structure.
	if (mode !== "rename") {
		const { defaultLanguage } = await siteLanguages(scope);
		const context = {
			language: defaultLanguage,
			defaultLanguage,
			by: { kind: "person" as const, personId: actingPerson(scope.access.actor) },
		};
		const rows =
			mode === "preview"
				? await scope.select(entries)
				: await scope.db.select().from(entries).where(scope.where(entries)).orderBy(entries.id).for("update");
		for (const row of rows) {
			const change: { draft?: unknown; published?: unknown } = {};
			for (const which of ["draft", "published"] as const) {
				if (!row[which]) continue;
				const version = structuredClone(storedVersion(row[which]));
				if (!version.layout) continue;
				version.layout.placements = version.layout.placements.map((p) => {
					if (p.component !== componentId) return p;
					const { lost, ...values } = reconcilePlacementValues(p, next.props, true, context);
					if (lost) losing.add(`entry:${row.id}:layout:${p.id}`);
					const { retained: _, ...placement } = p;
					return { ...placement, ...values };
				});
				if (!sameJson(version, row[which])) change[which] = version;
			}
			if (mode !== "preview" && Object.keys(change).length) {
				await saveMigratedVersions(scope, entries, "entry", row, change);
				const postType = await getPostType(scope, row.postTypeId);
				for (const which of ["draft", "published"] as const) {
					if (!change[which]) continue;
					const version = storedVersion(change[which]);
					await saveLinks(scope, row.id, which, [
						...linksIn(version.values, postType.fields),
						...layoutLinks(version.layout),
					]);
				}
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
			if (mode !== "preview" && Object.keys(change).length)
				await saveMigratedVersions(scope, entries, "entry", row, change);
		}
	}
	return {
		placements: losing.size,
		message: losing.size ? `${losing.size} Placement${losing.size === 1 ? " loses its" : "s lose their"} value` : null,
	};
}

/** Upgrade ambiguous legacy storage by its documented baseline before accepting current-type input.
 * Call under the Site Component lock, in the same transaction as the authoritative save.
 * Immutable history stays unmarked and continues to use its historical baseline contract.
 */
export async function upgradePropValueContracts(scope: SiteScope): Promise<void> {
	const rows = await scope.db
		.select({ id: components.id })
		.from(components)
		.where(
			scope.where(
				components,
				sql`${components.draft}->'propBaseline' <> '[]'::jsonb AND (${components.draft}->>'propValueVersion') IS DISTINCT FROM '1'`,
			),
		)
		.orderBy(components.id);
	for (const candidate of rows) {
		const [row] = await scope.db
			.select()
			.from(components)
			.where(scope.where(components, eq(components.id, candidate.id)))
			.for("update");
		if (!row) continue;
		const before = storedComponentVersion(row.draft);
		const draft: ComponentVersion = { ...before, propValueVersion: 1 };
		await migratePropPlacements(scope, row.id, before, draft, "rename");
		// Another legacy Component may place this one; read the tree after all migrations above.
		const current = await scope.first(components, eq(components.id, row.id));
		if (!current) continue;
		await saveMigratedVersions(scope, components, "component", current, {
			draft: { ...storedComponentVersion(current.draft), propValueVersion: 1 },
		});
	}
}

/** Attribute and checkpoint migrated tree and Body values in the same way. */
async function saveMigratedVersions(
	scope: SiteScope,
	table: typeof templates | typeof components | typeof entries,
	kind: "template" | "component" | "entry",
	row: Pick<typeof templates.$inferSelect, "id" | "draft" | "updatedAt" | "updatedBy" | "createdAt">,
	change: { draft?: unknown; published?: unknown },
): Promise<void> {
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
	const paths = Object.fromEntries(names);
	const result = structuredClone(tree);
	const visit = (value: unknown, aliases: Readonly<Record<string, string>> = {}) => {
		const renamed = (written: string) => {
			const root = written.split(".")[0] ?? "";
			const source = aliases[root];
			if (!source) return mappedBindingPath(written, paths);
			const mapped = mappedBindingPath(source + written.slice(root.length), paths);
			const nextRoot = mappedBindingPath(source, paths);
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

/** Capture active source contracts when a new history copy is created; never rewrite old copies. */
export async function snapshotPropContracts(
	scope: SiteScope,
	kind: string,
	input: unknown,
	which: "draft" | "published",
): Promise<unknown> {
	return capturePropContracts(kind, input, async (id) => {
		const [source] = await scope.db
			.select({
				version: sql`jsonb_build_object('props', ${components[which]}->'props', 'propBaseline', ${components[which]}->'propBaseline', 'propValueVersion', ${components[which]}->'propValueVersion')`,
			})
			.from(components)
			.where(scope.where(components, eq(components.id, id)));
		if (!source) return undefined;
		const version = storedComponentVersion(source.version);
		return retainedContract(version.props, version.propBaseline, version.propValueVersion !== 1);
	});
}

/** Shared by new history copies and import's last-live copy; reads one holder's contracts at a time. */
export async function capturePropContracts(
	kind: string,
	input: unknown,
	fieldsOf: (id: string) => Promise<FieldDefinition[] | undefined>,
): Promise<unknown> {
	if (!["template", "component", "popup"].includes(kind) || !input) return input;
	const content = structuredClone(input);
	const tree = (
		kind === "template"
			? content
			: kind === "popup"
				? (content as { component: ComponentVersion }).component?.tree
				: (content as ComponentVersion).tree
	) as ElementTree | undefined;
	if (!tree?.nodes) return content;
	const contracts = new Map<string, FieldDefinition[]>();
	for (const node of placementsIn(tree.nodes)) {
		if (!isUuid(node.component) || !node.props.some((value) => !value.contract)) continue;
		let fields = contracts.get(node.component);
		if (!fields) {
			fields = await fieldsOf(node.component);
			if (!fields) continue;
			contracts.set(node.component, fields);
		}
		for (const value of node.props) {
			if (value.contract) continue;
			const field = fields.find((field) => (value.retained ? field.id === value.retained : field.key === value.name));
			if (field) {
				checkStoredContract(field, String(field.id));
				value.contract = structuredClone(field);
			}
		}
		const problem = retainedPropsProblem(node.props);
		if (problem) throw new ComponentInvalidError([{ at: "props", message: problem }]);
	}
	return content;
}

/** A restored snapshot carries its own active contract; reconcile it before saving a current Draft. */
export function restorePropContracts(tree: ElementTree, catalogue: SiteComponents): ElementTree {
	const result = structuredClone(tree);
	for (const node of placementsIn(result.nodes)) {
		if (!node.props.some((value) => value.contract && !value.retained)) continue;
		const fields = catalogue.version(node.component)?.props;
		if (fields) node.props = migrateValues(node.props, fields, fields, false).values as typeof node.props;
		// A compatible historical type becomes current input; its old constraints cannot bypass
		// today's validation. Incompatible retained values still use their own dormant contract.
		const info = catalogue.byId(node.component);
		if (!isComponentInfo(info)) continue;
		for (const value of node.props) {
			if (value.retained || !value.value.every((part) => part.type === "text")) continue;
			const prop = info.props.find((candidate) => candidate.key === value.name);
			const parts = value.value.filter((part) => part.type === "text");
			const languages = new Set(["", ...parts.flatMap((part) => Object.keys(part.translations ?? {}))]);
			for (const language of languages) {
				const problem = prop?.check(parts.map((part) => part.translations?.[language] ?? part.text).join(""));
				if (problem) throw new ElementTreeInvalidError([{ at: `props.${value.name}`, message: problem }]);
			}
		}
	}
	return result;
}
