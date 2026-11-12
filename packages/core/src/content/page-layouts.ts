/** Page layouts are Content on the Page Entry, never a private copy of Component elements. */
import { entries, pageLayoutSettings } from "@webcraft/db/schema";
import type { ElementTree, PlacementNode } from "@webcraft/renderer";
import { eq } from "drizzle-orm";
import type { Json as DocumentJson } from "../co-editing/document.ts";
import { valueChanges } from "../co-editing/value-changes.ts";
import { nodeView } from "../co-editing/view.ts";
import { can, personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { listComponents, lockComponents, siteComponents } from "./components.ts";
import { listEntries } from "./entries.ts";
import { DraftChangedError, EntryInvalidError, PageNotFoundError } from "./errors.ts";
import { type FieldDefinition, type Json, MAX_ROWS } from "./field-types.ts";
import {
	defaultValues,
	type Languages,
	linksIn,
	randomRowId,
	readFields,
	type StoredValues,
	type WriteContext,
	withoutLinksTo,
	writeFields,
} from "./field-values.ts";
import { draftVersion, sameJson } from "./json.ts";
import { languagesFor, siteLanguages } from "./languages.ts";
import { type PlacementValues, reconcilePlacementValues } from "./page-layout-props.ts";
import { isPagePostType } from "./pages.ts";
import { getPostType, listPostTypes } from "./post-types.ts";
import { checkReferences } from "./relationships.ts";
import { type EntryVersion, storedVersion } from "./values.ts";

export type PagePlacement = {
	id: string;
	component: string;
	hidden?: boolean;
	locked?: boolean;
	/** Immutable source declarations: keys are not identities. */
	props: FieldDefinition[];
	values: StoredValues;
	retained?: PlacementValues[];
};
export type PageLayout = { placements: PagePlacement[] };
export const EMPTY_LAYOUT: PageLayout = { placements: [] };
export function layoutVersion(layout: PageLayout): string {
	return draftVersion(layout);
}
export function layoutView(layout: PageLayout): DocumentJson {
	return {
		placements: layout.placements.map((p) => ({
			id: p.id,
			component: p.component,
			props: p.props,
			...(p.hidden ? { hidden: true } : {}),
			...(p.locked ? { locked: true } : {}),
			values: (nodeView({ values: p.values }) as { values: DocumentJson }).values,
		})),
	} as DocumentJson;
}
export function layoutPermissions(scope: SiteScope) {
	const at = { level: "site", workspaceId: scope.site.workspaceId, siteId: scope.site.id } as const;
	return { structure: can(scope.access.actor, "structure.edit", at), edit: can(scope.access.actor, "entry.edit", at) };
}
export async function layoutSettings(scope: SiteScope) {
	const row = await scope.first(pageLayoutSettings);
	return { enabled: row?.enabled ?? false, allowedComponents: row?.allowedComponents ?? [] };
}
export async function configureLayout(scope: SiteScope, change: { enabled?: boolean; allowedComponents?: string[] }) {
	if (!layoutPermissions(scope).structure)
		throw new EntryInvalidError([
			{ at: "layout", message: "Changing Page layout settings requires Structure permission." },
		]);
	return scope.transaction(async (tx) => {
		await lockComponents(tx);
		const current = await layoutSettings(tx);
		const next = { ...current, ...change };
		const catalogue = await siteComponents(tx, "draft", tx.componentSources);
		for (const id of next.allowedComponents)
			if (!catalogue.version(id))
				throw new EntryInvalidError([{ at: "allowedComponents", message: "Choose a Component on this Site." }]);
		if (await tx.first(pageLayoutSettings)) await tx.update(pageLayoutSettings, next);
		else await tx.insert(pageLayoutSettings, next);
		await tx.audit("pageLayout.configure", next);
		return next;
	});
}
export async function getPageLayout(scope: SiteScope, entryId: string, language?: string) {
	const row = await scope.first(entries, eq(entries.id, entryId));
	if (!row || !isPagePostType(await getPostType(scope, row.postTypeId))) throw new PageNotFoundError();
	const layout = storedVersion(row.draft).layout ?? EMPTY_LAYOUT;
	const settings = await layoutSettings(scope);
	const permissions = layoutPermissions(scope);
	const site = await siteLanguages(scope);
	const languages = languagesFor(site, language);
	if (!languages) throw new EntryInvalidError([{ at: "language", message: "The Site does not have that language." }]);
	const catalogue = await siteComponents(scope, "published", scope.componentSources);
	const drafts = permissions.structure ? await siteComponents(scope, "draft", scope.componentSources) : null;
	const components = await listComponents(scope, scope.componentSources);
	const relationships: Record<
		string,
		{ name: string; entries: { id: string; title: string; status: "draft" | "published" | "changed" }[] }
	> = {};
	const referencedTypes = new Set<string>();
	function collect(fields: readonly FieldDefinition[]) {
		for (const field of fields) {
			if (field.type === "relationship") for (const key of field.postTypes) referencedTypes.add(key);
			if ("fields" in field) collect(field.fields);
		}
	}
	for (const placement of layout.placements) collect(placement.props);
	for (const type of (await listPostTypes(scope)).filter((type) => referencedTypes.has(type.key)))
		relationships[type.key] = {
			name: type.name,
			entries: (await listEntries(scope, type.id, languages.language)).map((e) => ({
				id: e.id,
				title: e.draft.title,
				status: e.status,
			})),
		};
	return {
		siteId: scope.site.id,
		relationships,
		layout: layoutView(layout) as unknown as PageLayout,
		version: layoutVersion(layout),
		settings,
		canArrange: permissions.edit && (permissions.structure || settings.enabled),
		canLock: permissions.structure,
		components: components
			.filter(
				(c) =>
					(permissions.structure || settings.allowedComponents.includes(c.id)) &&
					(catalogue.version(c.id) || drafts?.version(c.id)),
			)
			.map((c) => ({ id: c.id, name: c.name, props: (catalogue.version(c.id) ?? drafts?.version(c.id))?.props ?? [] })),
		placements: layout.placements.map((p) => ({
			id: p.id,
			component: p.component,
			componentName: catalogue.nameOf(p.component) ?? drafts?.nameOf(p.component) ?? "Component",
			label: placementLabel(p, catalogue.nameOf(p.component) ?? "Component", languages),
			props: p.props,
			values: readFields(p.values, p.props, languages),
			locked: p.locked ?? false,
			hidden: p.hidden ?? false,
		})),
		language: languages.language,
		defaultLanguage: languages.defaultLanguage,
	};
}
function placementLabel(p: PagePlacement, name: string, languages: Languages) {
	const first = p.props.find((f) => f.type === "text");
	const value = first ? readFields(p.values, p.props, languages)[first.key] : null;
	return name + (typeof value === "string" && value.trim() ? ` · ${value.trim().slice(0, 100)}` : "");
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new EntryInvalidError([{ at: "layout", message: "A Page layout must be an object." }]);
	return value as Record<string, unknown>;
}
function refuse(message: string): never {
	throw new EntryInvalidError([{ at: "layout", message }]);
}
/** Called by every Entry writer. The incoming values are the public shared-document values, without provenance. */
export async function writePageLayout(
	scope: SiteScope,
	before: PageLayout,
	input: unknown,
	basedOn?: string,
): Promise<PageLayout> {
	if (basedOn !== undefined && basedOn !== layoutVersion(before)) throw new DraftChangedError(layoutVersion(before));
	const own = object(input);
	if (Object.keys(own).some((k) => k !== "placements") || !Array.isArray(own.placements) || own.placements.length > 200)
		refuse("A Page layout holds at most 200 Placements, in one level.");
	const permissions = layoutPermissions(scope);
	const settings = await layoutSettings(scope);
	if (!permissions.edit || (!permissions.structure && !settings.enabled))
		refuse("Arranging Page layouts is not allowed on this Site.");
	const catalogue = await siteComponents(scope, "published", scope.componentSources);
	const drafts = permissions.structure ? await siteComponents(scope, "draft", scope.componentSources) : null;
	const site = await siteLanguages(scope);
	const activeModules = new Set(
		(await scope.componentSources.moduleComponentsAt(scope)).map((component) => component.id),
	);
	const retainedModules = new Set(
		(await scope.componentSources.retainedModuleComponentsAt(scope))
			.filter((component) => !activeModules.has(component.id))
			.map((component) => component.id),
	);
	const ids = new Set<string>();
	const placements: PagePlacement[] = [];
	for (const raw of own.placements) {
		const p = object(raw);
		if (
			Object.keys(p).some((k) => !["id", "component", "hidden", "locked", "props", "values"].includes(k)) ||
			typeof p.id !== "string" ||
			!/^[A-Za-z0-9_-]{1,64}$/.test(p.id) ||
			ids.has(p.id) ||
			typeof p.component !== "string"
		)
			refuse("A Placement has a unique id, Component and Props, never children or a name.");
		ids.add(p.id);
		for (const key of ["hidden", "locked"])
			if (p[key] !== undefined && typeof p[key] !== "boolean") refuse("Placement flags must be true or false.");
		const old = before.placements.find((v) => v.id === p.id);
		const version = catalogue.version(p.component) ?? drafts?.version(p.component);
		if (!version || (old && old.component !== p.component)) refuse("The Placement's Component cannot be replaced.");
		if (!old && !permissions.structure && !settings.allowedComponents.includes(p.component))
			refuse("Members may add only Allowed components.");
		if (!permissions.structure && !!p.locked !== !!old?.locked) refuse("Only Staff can lock a Placement.");
		if (old?.locked && !permissions.structure && !!p.hidden !== !!old.hidden)
			refuse("A locked Placement cannot be hidden.");
		if (
			retainedModules.has(p.component) &&
			(!old || !sameJson(p.values, (nodeView({ values: old.values }) as { values: DocumentJson }).values))
		)
			refuse("Restore the compatible source Module before adding its Placements or editing its Props.");
		const props = old?.props ?? version.props;
		if (!sameJson(p.props, props)) refuse("Prop declarations belong to the Component.");
		validateValues(object(p.values), props);
		const problems: import("./errors.ts").ContentProblem[] = [];
		const by = { kind: "person", personId: personIdOf(scope.access.actor) } as const;
		if (!by.personId) refuse("A person must edit Page layouts.");
		const context = { defaultLanguage: site.defaultLanguage, problems };
		const previous = old ? (nodeView({ values: old.values }) as { values: Record<string, DocumentJson> }).values : {};
		const changes = valueChanges(previous, object(p.values) as Record<string, DocumentJson>, props, context, "props.");
		let values =
			old?.values ??
			defaultValues(props, {
				language: site.defaultLanguage,
				defaultLanguage: site.defaultLanguage,
				by: { ...by, personId: by.personId },
			});
		for (const [language, fields] of [...changes].sort(([a], [b]) =>
			a === site.defaultLanguage ? -1 : b === site.defaultLanguage ? 1 : a.localeCompare(b),
		)) {
			if (!site.languages.some((l) => l.code === language)) refuse("The Site does not have that language.");
			const write: WriteContext = {
				...context,
				language,
				by: { ...by, personId: by.personId },
				references: [],
				newRowId: randomRowId,
			};
			values = writeFields(values, props, fields, write, "props.", "Placement");
			await checkReferences(
				scope,
				write.references.map((reference) => ({ ...reference, problems })),
				"refuse",
			);
		}
		if (problems.length) throw new EntryInvalidError(problems);
		placements.push({
			id: p.id,
			component: p.component,
			props,
			values,
			...(old?.retained ? { retained: old.retained } : {}),
			...(p.hidden ? { hidden: true } : {}),
			...(p.locked ? { locked: true } : {}),
		});
	}
	if (!permissions.structure)
		for (const locked of before.placements.filter((p) => p.locked)) {
			if (!ids.has(locked.id)) refuse("A locked Placement cannot be removed.");
			// Inserting/removing neighbours is allowed; crossing a locked row is not.
			const oldAt = before.placements.indexOf(locked);
			const nextAt = placements.findIndex((p) => p.id === locked.id);
			for (const p of before.placements) {
				const at = placements.findIndex((n) => n.id === p.id);
				if (at >= 0 && before.placements.indexOf(p) < oldAt !== at < nextAt)
					refuse("A locked Placement cannot be moved.");
			}
		}
	return { placements };
}
/** Render fixed Prop arguments through their source declarations. Values keep their types and language fallback. */
export function pageLayoutTree(version: EntryVersion, languages: Languages): ElementTree {
	return {
		version: 1,
		nodes: (version.layout?.placements ?? []).map((p) => {
			const values = readFields(p.values, p.props, languages);
			return {
				type: "component",
				id: p.id,
				component: p.component,
				...(p.hidden ? { hidden: true } : {}),
				props: p.props.map((f) => ({
					name: f.key,
					contract: f as unknown as Record<string, unknown>,
					value: [{ type: "text", text: propText(f, values[f.key] ?? null) }],
				})),
			} satisfies PlacementNode;
		}),
	};
}
function propText(field: FieldDefinition, value: Json): string {
	if (value === null) return "";
	if (field.type === "media") return `media:${value}`;
	if ((field.type === "select" || field.type === "relationship") && field.multiple && Array.isArray(value))
		return value.join(",");
	return typeof value === "object" ? JSON.stringify(propJson(field, value)) : String(value);
}

/** History supplies trusted historical contracts; clients cannot replace declarations or dormant values. */
export async function restorePageLayout(scope: SiteScope, layout: PageLayout): Promise<PageLayout> {
	const published = await siteComponents(scope, "published", scope.componentSources);
	const drafts = await siteComponents(scope, "draft", scope.componentSources);
	const { defaultLanguage } = await siteLanguages(scope);
	const personId = personIdOf(scope.access.actor);
	if (!personId) refuse("A person must restore Page layouts.");
	return {
		placements: layout.placements.map((p) => {
			const props = (published.version(p.component) ?? drafts.version(p.component))?.props;
			if (!props) return p;
			const { lost: _, ...values } = reconcilePlacementValues(p, props, false, {
				language: defaultLanguage,
				defaultLanguage,
				by: { kind: "person", personId },
			});
			return { ...p, ...values };
		}),
	};
}

function validateValues(values: Record<string, unknown>, fields: FieldDefinition[]): void {
	for (const [key, value] of Object.entries(values)) {
		const field = fields.find((f) => f.key === key);
		if (!field) refuse("The Component has no such Prop.");
		const node = object(value);
		if (field.type === "group") {
			if (Object.keys(node).some((k) => k !== "values")) refuse("A Group holds only its Fields.");
			validateValues(object(node.values), field.fields);
		} else if (field.type === "repeater") {
			if (Object.keys(node).some((k) => k !== "rows") || !Array.isArray(node.rows) || node.rows.length > MAX_ROWS)
				refuse(`A Repeater holds at most ${MAX_ROWS} rows.`);
			const ids = new Set<string>();
			for (const raw of node.rows) {
				const row = object(raw);
				if (
					Object.keys(row).some((k) => k !== "id" && k !== "values") ||
					typeof row.id !== "string" ||
					!/^[A-Za-z0-9_-]{1,64}$/.test(row.id) ||
					ids.has(row.id)
				)
					refuse("Repeater rows have distinct stable ids.");
				ids.add(row.id);
				validateValues(object(row.values), field.fields);
			}
		}
	}
}

export function layoutLinks(layout: PageLayout | undefined) {
	return (layout?.placements ?? []).flatMap((p) => linksIn(p.values, p.props, `layout.${p.id}.`));
}
export function unlinkLayout(layout: PageLayout | undefined, entryId: string): PageLayout | undefined {
	return layout
		? {
				placements: layout.placements.map((p) => ({
					...p,
					values: withoutLinksTo(p.values, p.props, entryId),
					...(p.retained
						? { retained: p.retained.map((s) => ({ ...s, values: withoutLinksTo(s.values, s.props, entryId) })) }
						: {}),
				})),
			}
		: undefined;
}

/** Repeater row identities are Content metadata, never an undeclared Component Prop. */
function propJson(field: FieldDefinition, value: Json): Json {
	if (field.type === "group" && value && typeof value === "object" && !Array.isArray(value))
		return Object.fromEntries(field.fields.map((f) => [f.key, propJson(f, value[f.key] ?? null)]));
	if (field.type === "repeater" && Array.isArray(value))
		return value.map((row) => propJson({ ...field, type: "group" }, row));
	return value;
}
