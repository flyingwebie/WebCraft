import { popups } from "@webcraft/db/schema";
import { sitePopups } from "../popups/catalogue.ts";
/**
 * Components (GLOSSARY.md): reusable element trees with Props, built by Staff and placed in
 * Templates and other Components (later in Page layouts and Body fields). A Component is Structure
 * with a Draft and a published version, each holding its Props (declared with the Field types) and
 * its element tree, published together as one item. A Placement stores only the Component's id and
 * its own Prop values, so editing the Component changes every copy, and no copy's internals can be
 * edited on their own.
 *
 * Components a Module declares are Components like any other, but come from the Module's definition
 * rather than the Site's `components` table, and can be placed only on Sites where the Module runs.
 *
 * Seams: Component custom CSS (#64) is published with the Component, beside its Props and tree in
 * `ComponentVersion`; Allowed components and Page layouts (#75) and Components in a Body (#79) place
 * Components with the same Placement node and render them through `placementRenderer`.
 */

import { accessibilityStatements, components, entries, globals, templates } from "@webcraft/db/schema";
import {
	type ComponentCatalogue,
	componentsPlacedIn,
	type DesignSystem,
	type ElementTree,
	ElementTreeInvalidError,
	EXPRESSION_KEYWORDS,
	expansionProblem,
	type LoopCatalogue,
	type MarkupNotice,
	type PropInfo,
	parseElementTree,
	parseTemplateMarkup,
	placementProblems,
	printTemplateMarkup,
	refuseSiteTemplateCommands,
} from "@webcraft/renderer";
import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";

import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { type ClassCatalogue, ClassRaceError, classCatalogue, saveCreatedClasses } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { NO_FILTERS, type SiteFilters, siteFilters } from "../filters/filters.ts";
import { NO_FORMS, type SiteForms, siteForms } from "../forms/forms.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { isUuid } from "../ids.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { publishedArchives } from "./archives.ts";
import { type ComponentVersion, EMPTY_TREE, storedComponentVersion } from "./component-versions.ts";
import {
	ComponentFromModuleError,
	ComponentInUseError,
	ComponentInvalidError,
	ComponentNameTakenError,
	ComponentNotFoundError,
	type ComponentUse,
	type ContentProblem,
	DraftChangedError,
} from "./errors.ts";
import { type FieldDefinition, type FieldInput, parseFields, storedFields } from "./fields.ts";
import { draftVersion, type SaveBase, sameJson } from "./json.ts";
import { loopCatalogue } from "./loops.ts";
import { isPagePostType } from "./pages.ts";
import { listPostTypes, type PostType } from "./post-types.ts";
import { readPropText } from "./props.ts";
import { componentKnownValues } from "./render-values.ts";
import { checkRetainedModulePlacements } from "./retained-module-props.ts";

export type { ComponentVersion } from "./component-versions.ts";

/** Where a Component stands: never published, published as it is, or changed since. */
export type ComponentStatus = "draft" | "published" | "changed";

/** A Component, as the content store hands it out. */
export type Component = {
	/** A UUID for the Site's own; `<module id>:<Name>` for a Module's. */
	id: string;
	siteId: string;
	/** Its PascalCase tag in Template markup, such as `PostCard`. */
	name: string;
	/** The Module that declares it; null for the Site's own. */
	module: { id: string; blockType?: boolean; label?: Readonly<Record<string, string>> } | null;
	status: ComponentStatus;
	draft: ComponentVersion;
	/** What visitors see; null until it is first published. A Module's is always published. */
	published: ComponentVersion | null;
	createdAt: Date | null;
	updatedAt: Date | null;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

/** Where a Component is placed, and on how many published pages visitors see it. */
export type ComponentUsage = {
	/**
	 * The published pages that show it, through published Templates and Components: every page when
	 * the Site template places it, else the published Entries of the Post Types whose Entry template
	 * places it.
	 */
	pages: number;
	/** The Templates and Components whose Draft or published version places it directly. */
	usedIn: ComponentUse[];
};

/** A Component's Draft and published version as Template markup. */
export type ComponentMarkup = { draft: string; published: string | null };

/** A Component a Module declares: always published, the same on every Site where the Module runs. */
export type ModuleComponent = {
	/** `<module id>:<Name>`. */
	id: string;
	moduleId: string;
	blockType?: boolean;
	label?: Readonly<Record<string, string>>;
	localizedProps?: Readonly<Record<string, FieldDefinition[]>>;
	name: string;
	props: FieldDefinition[];
	tree: ElementTree;
};

/** Data-only source declarations: retained types never bring executable Module markup with them. */
export type ModuleComponentProps = Pick<ModuleComponent, "id" | "props">;

/** A checked Site read, including the caller's current transaction. */
type ComponentReadScope = Pick<SiteScope, "site" | "db" | "where">;

/** Where the content store finds Modules' Components (the Module host). */
export type ComponentSources = {
	/** Every Component the Install's Modules declare, wherever they run: their names are taken. */
	allModuleComponents(): readonly ModuleComponent[];
	/** The Components of the Modules that run on a Site: only those may be placed there. */
	moduleComponentsAt(scope: ComponentReadScope): Promise<readonly ModuleComponent[]>;
	/** Source Prop contracts kept with imported Sites, including missing or incompatible Modules. */
	retainedModuleComponentsAt(scope: ComponentReadScope): Promise<readonly ModuleComponentProps[]>;
};

/** No Module declares a Component. */
export const NO_MODULE_COMPONENTS: ComponentSources = {
	allModuleComponents: () => [],
	moduleComponentsAt: async () => [],
	retainedModuleComponentsAt: async () => [],
};

export type NewComponent = { name: string; props?: FieldInput[] };

/** A change to a Component's Draft: its Props (the full list, in order) and its tree. */
export type ComponentDraftChange = { props?: FieldInput[]; tree?: unknown };

/** A Component's Draft saved from Template markup, with its markup as stored now and notices. */
export type SavedComponentMarkup = {
	component: Component;
	markup: string;
	/** The Draft's version, which the next save names as `basedOn`. */
	version: string;
	notices: MarkupNotice[];
	usage: ComponentUsage;
};

/** What deleting a Component did: asked for a confirmation, or deleted it. */
export type ComponentDeletion = { deleted: false; confirmation: Confirmation } | { deleted: true };

/** A Component's name: a PascalCase tag (a capital first, then letters and digits, at least one lower-case). */
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** Whether `name` can name a Component: Template markup reads PascalCase tags as Components. */
export function isComponentName(name: string): boolean {
	return COMPONENT_NAME.test(name) && /[a-z]/.test(name);
}

/** Prop keys a Component can't use: the words Conditions' tests use, which a path can't end in. */
export const RESERVED_PROP_KEYS: ReadonlySet<string> = new Set(
	[...EXPRESSION_KEYWORDS].map((word) => word.toLowerCase()),
);

type ComponentRow = typeof components.$inferSelect;

// ---------------------------------------------------------------------------------------------------
// Creating, reading and saving

/**
 * Creates a Component on the scope's Site (open it with `structure.edit`): its name and Props, with
 * an empty tree, as a Draft. Visitors see nothing of it until it is published and placed.
 */
export async function createComponent(
	scope: SiteScope,
	input: NewComponent,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Component> {
	const problems: ContentProblem[] = [];
	const name = checkName(input.name, problems);
	const props = await parseProps(scope, input.props ?? [], [], problems);
	if (problems.length > 0) throw new ComponentInvalidError(problems);
	await checkNameFree(scope, name, sources);
	return naming(scope, name, () =>
		scope.transaction(async (tx) => {
			await lockComponents(tx);
			await checkNameUnused(tx, name);
			const now = tx.now();
			const draft: ComponentVersion = { props, tree: EMPTY_TREE };
			const row = await tx.insert(components, {
				name,
				draft,
				createdAt: now,
				updatedAt: now,
				updatedBy: personIdOf(tx.access.actor),
				updatedVia: clientNameOf(tx.access.via),
			});
			await tx.audit("component.create", { componentId: row.id, name });
			return toComponent(row);
		}),
	);
}

/** The Components of the scope's Site (its own, then those of the Modules running there), by name. */
export async function listComponents(
	scope: SiteScope,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<(Component & { usage: ComponentUsage })[]> {
	const rows = await scope.select(components, undefined, { orderBy: [asc(components.name)] });
	const own = rows.map(toComponent);
	const fromModules = (await sources.moduleComponentsAt(scope)).map((component) =>
		moduleComponent(scope.site.id, component),
	);
	const usageOf = await usages(scope);
	return [...own, ...fromModules].map((component) => ({ ...component, usage: usageOf(component.id) }));
}

/** One Component of the scope's Site, or of a Module running there; `ComponentNotFoundError` otherwise. */
export async function getComponent(
	scope: SiteScope,
	componentId: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ component: Component; usage: ComponentUsage }> {
	const component = await findComponent(scope, componentId, sources);
	return { component, usage: (await usages(scope))(component.id) };
}

/**
 * Saves a Component's Draft (open the Site with `structure.edit`): its Props (the full list, in
 * order) and its tree, either or both. The tree is checked against the Props it will have: it reads
 * them as `props.x`, and the Globals as `site.x`. Visitors see nothing until it is published.
 */
export async function saveComponentDraft(
	scope: SiteScope,
	componentId: string,
	change: ComponentDraftChange,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Component> {
	return scope.transaction(async (tx) => {
		await lockComponents(tx);
		const row = await lockComponent(tx, componentId, sources);
		const props = await nextProps(tx, row, change.props);
		const context = await readContext(tx);
		const catalogue = await siteComponents(tx, "draft", sources, { self: row.id });
		const { ids } = classCatalogue(await draftDesignSystem(tx));
		const tree = parseElementTree(change.tree ?? storedComponentVersion(row.draft).tree, {
			...componentTreeRules(props, context, catalogue),
			classIds: ids,
		});
		return writeDraft(tx, row, { props, tree });
	});
}

/**
 * Saves a Component's Draft from Template markup (open the Site with `structure.edit`), with new
 * Props when given (else its Draft's). Inline styles become generated Classes, in the same
 * transaction. Throws `TemplateMarkupInvalidError` with each problem's line and column.
 */
export async function saveComponentMarkup(
	scope: SiteScope,
	componentId: string,
	input: { markup: string; props?: FieldInput[] },
	sources: ComponentSources = NO_MODULE_COMPONENTS,
	base: SaveBase = {},
): Promise<SavedComponentMarkup> {
	const saved = await retryOnClassRace(() =>
		scope.transaction(async (tx) => {
			await lockComponents(tx);
			const row = await lockComponent(tx, componentId, sources);
			if (base.basedOn !== undefined) {
				const version = componentVersion(storedComponentVersion(row.draft));
				if (version !== base.basedOn) throw new DraftChangedError(version);
			}
			const props = await nextProps(tx, row, input.props);
			const context = await readContext(tx);
			const catalogue = await siteComponents(tx, "draft", sources, { self: row.id });
			const classes = classCatalogue(await draftDesignSystem(tx));
			const { tree, notices } = parseTemplateMarkup(input.markup, {
				...componentTreeRules(props, context, catalogue),
				classNamed: classes.named,
				classForStyle: classes.forStyle,
			});
			await saveCreatedClasses(tx, classes);
			const component = await writeDraft(tx, row, { props, tree });
			return {
				component,
				markup: printMarkup(tree, classes, catalogue),
				version: componentVersion(component.draft),
				notices,
			};
		}),
	);
	return { ...saved, usage: (await usages(scope))(saved.component.id) };
}

/**
 * Reads Template markup as saving a Component's Draft would (with its Draft's Props), without saving
 * anything: the tree, notices, and the Design system's Draft with the generated Classes its inline
 * styles would add. Code mode previews unsaved markup with it. Throws `TemplateMarkupInvalidError`.
 */
export async function readComponentMarkup(
	scope: SiteScope,
	componentId: string,
	markup: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ tree: ElementTree; notices: MarkupNotice[]; designSystem: DesignSystem; version: ComponentVersion }> {
	const component = await findComponent(scope, componentId, sources);
	if (component.module) throw new ComponentFromModuleError();
	const { props } = component.draft;
	const catalogue = await siteComponents(scope, "draft", sources, { self: component.id });
	const designSystem = await draftDesignSystem(scope);
	const classes = classCatalogue(designSystem);
	const { tree, notices } = parseTemplateMarkup(markup, {
		...componentTreeRules(props, await readContext(scope), catalogue),
		classNamed: classes.named,
		classForStyle: classes.forStyle,
	});
	return {
		tree,
		notices,
		designSystem: { ...designSystem, classes: [...designSystem.classes, ...classes.created] },
		version: { props, tree },
	};
}

/**
 * One of the Site's own Components as the visual builder opens it (open the Site with
 * `structure.edit`): the Component, the Props its Draft will have (its Draft's, or `props` checked
 * as saving checks them: `ComponentInvalidError`), and what its tree may hold with them, placing the
 * Drafts of the Components it may place (never one placing it). A Module's Component changes with
 * its Module (`ComponentFromModuleError`).
 */
export async function componentSource(
	scope: SiteScope,
	componentId: string,
	props: readonly FieldInput[] | undefined,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{
	component: Component;
	props: FieldDefinition[];
	catalogue: SiteComponents;
	rules: ReturnType<typeof componentTreeRules>;
}> {
	const component = await findComponent(scope, componentId, sources);
	if (component.module) throw new ComponentFromModuleError();
	const row = await scope.first(components, eq(components.id, component.id));
	if (!row) throw new ComponentNotFoundError();
	const willHave = await nextProps(scope, row, props);
	const catalogue = await siteComponents(scope, "draft", sources, { self: component.id });
	return {
		component,
		props: willHave,
		catalogue,
		rules: componentTreeRules(willHave, await readContext(scope), catalogue),
	};
}

/** A Component's Draft's version, from its Props and tree as stored (`draftVersion`). */
export function componentVersion(draft: ComponentVersion): string {
	return draftVersion(draft);
}

/** A Component as Template markup: its Draft and its published version (null until the first publish). */
export async function getComponentMarkup(
	scope: SiteScope,
	componentId: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ component: Component; markup: ComponentMarkup; version: string; usage: ComponentUsage }> {
	const component = await findComponent(scope, componentId, sources);
	const classes = classCatalogue(await draftDesignSystem(scope));
	const names = await siteComponents(scope, "draft", sources);
	return {
		component,
		version: componentVersion(component.draft),
		markup: {
			draft: printMarkup(component.draft.tree, classes, names),
			published: component.published ? printMarkup(component.published.tree, classes, names) : null,
		},
		usage: (await usages(scope))(component.id),
	};
}

/**
 * Renames a Component (open the Site with `structure.edit`). Templates and Components place it by
 * id, so every one of them writes the new name in Template markup at once; visitors see no change.
 */
export async function renameComponent(
	scope: SiteScope,
	componentId: string,
	input: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Component> {
	const problems: ContentProblem[] = [];
	const name = checkName(input, problems);
	if (problems.length > 0) throw new ComponentInvalidError(problems);
	return naming(scope, name, () =>
		scope.transaction(async (tx) => {
			await lockComponents(tx);
			const row = await lockComponent(tx, componentId, sources);
			if (row.name === name) return toComponent(row);
			await checkNameFree(tx, name, sources);
			await checkNameUnused(tx, name);
			const [updated] = await tx.update(components, { name, updatedAt: tx.now() }, eq(components.id, row.id));
			if (!updated) throw new ComponentNotFoundError();
			await tx.audit("component.rename", { componentId: row.id, from: row.name, to: name });
			return toComponent(updated);
		}),
	);
}

/**
 * Deletes a Component (open the Site with `structure.edit`), in two steps: without a confirmation
 * it deletes nothing and answers a confirmation id; with that id it deletes it. Refused while any
 * Template or Component places it, in its Draft or published version (`ComponentInUseError` lists
 * them): every Placement would show nothing.
 */
export async function deleteComponent(
	scope: SiteScope,
	componentId: string,
	confirmation: string | undefined,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<ComponentDeletion> {
	return scope.transaction(async (tx) => {
		await lockComponents(tx);
		const row = await lockComponent(tx, componentId, sources);
		const { usedIn } = (await usages(tx))(row.id);
		if (usedIn.length > 0) throw new ComponentInUseError(usedIn);
		const request = { action: "component.delete", target: row.id, preview: { name: row.name } };
		if (confirmation === undefined) return { deleted: false, confirmation: await askConfirmation(tx, request) };
		await useConfirmation(tx, confirmation, request);
		await tx.delete(components, eq(components.id, row.id));
		await tx.audit("component.delete", { componentId: row.id, name: row.name });
		return { deleted: true };
	});
}

/** The Props a Draft will have: the change's, checked (a Prop keeps its type), or the Draft's own. */
async function nextProps(
	scope: SiteScope,
	row: ComponentRow,
	inputs: readonly FieldInput[] | undefined,
): Promise<FieldDefinition[]> {
	const draft = storedComponentVersion(row.draft);
	if (inputs === undefined) return draft.props;
	// A Prop keeps the type it has in the Draft or the published version.
	const published = row.published === null ? [] : storedComponentVersion(row.published).props;
	const existing = [...draft.props, ...published.filter((prop) => !draft.props.some((own) => own.key === prop.key))];
	const problems: ContentProblem[] = [];
	const props = await parseProps(scope, inputs, existing, problems);
	if (problems.length > 0) throw new ComponentInvalidError(problems);
	return props;
}

async function writeDraft(scope: SiteScope, row: ComponentRow, draft: ComponentVersion): Promise<Component> {
	await checkRetainedModulePlacements(scope, draft.tree, storedComponentVersion(row.draft).tree);
	const [updated] = await scope.update(
		components,
		{
			draft,
			updatedAt: scope.now(),
			updatedBy: personIdOf(scope.access.actor),
			updatedVia: clientNameOf(scope.access.via),
		},
		eq(components.id, row.id),
	);
	if (!updated) throw new ComponentNotFoundError();
	await noteDraftChange(
		scope,
		{ kind: "component", id: row.id },
		{ content: row.draft, changedAt: row.updatedAt, changedBy: row.updatedBy, since: row.createdAt },
		draft,
	);
	for (const popup of await scope.select(popups, eq(popups.componentId, row.id))) {
		await scope.update(
			popups,
			{ updatedAt: scope.now(), updatedBy: personIdOf(scope.access.actor), updatedVia: clientNameOf(scope.access.via) },
			eq(popups.id, popup.id),
		);
		await noteDraftChange(
			scope,
			{ kind: "popup", id: popup.id },
			{
				content: { settings: popup.draft, component: row.draft },
				changedAt: popup.updatedAt,
				changedBy: popup.updatedBy,
				since: popup.createdAt,
			},
			{ settings: popup.draft, component: draft },
		);
	}
	return toComponent(updated);
}

/** A Component of the Site, or of a Module running there. */
async function findComponent(scope: SiteScope, componentId: string, sources: ComponentSources): Promise<Component> {
	if (isUuid(componentId)) {
		const row = await scope.first(components, eq(components.id, componentId));
		if (!row) throw new ComponentNotFoundError();
		return toComponent(row);
	}
	const found = (await sources.moduleComponentsAt(scope)).find((component) => component.id === componentId);
	if (!found) throw new ComponentNotFoundError();
	return moduleComponent(scope.site.id, found);
}

/**
 * Reads one of the Site's own Components to change it, holding it until the transaction ends. A
 * Module's Component changes with its Module (`ComponentFromModuleError`).
 */
export async function lockComponent(
	scope: SiteScope,
	componentId: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<ComponentRow> {
	if (!isUuid(componentId)) {
		const fromModule = sources.allModuleComponents().some((component) => component.id === componentId);
		throw fromModule ? new ComponentFromModuleError() : new ComponentNotFoundError();
	}
	const [row] = await scope.db
		.select()
		.from(components)
		.where(scope.where(components, eq(components.id, componentId)))
		.for("update");
	if (!row) throw new ComponentNotFoundError();
	return row;
}

/** Checks and reads a list of Props, as Fields are: a Prop keeps its type once declared. */
async function parseProps(
	scope: SiteScope,
	inputs: readonly FieldInput[],
	existing: readonly FieldDefinition[],
	problems: ContentProblem[],
): Promise<FieldDefinition[]> {
	const postTypeKeys = new Set((await listPostTypes(scope)).map((postType) => postType.key));
	return parseFields(
		inputs,
		problems,
		{ postTypeKeys, owner: "component", reservedKeys: RESERVED_PROP_KEYS, listName: "props" },
		existing,
	);
}

function checkName(input: string, problems: ContentProblem[]): string {
	const name = input.trim();
	if (!isComponentName(name)) {
		problems.push({
			at: "name",
			message:
				"A Component's name is its tag in Template markup: a capital letter, then letters and digits (at most 64, at least one lower-case), such as PostCard.",
		});
	}
	return name;
}

/** Installed and retained Module Components keep their names so stored Placements remain readable. */
async function checkNameFree(scope: SiteScope, name: string, sources: ComponentSources): Promise<void> {
	const taken = sources.allModuleComponents().find((component) => component.name === name);
	if (taken) throw new ComponentNameTakenError(name, { kind: "module", moduleId: taken.moduleId });
	const retained = (await sources.retainedModuleComponentsAt(scope)).find(
		(component) => component.id.slice(component.id.indexOf(":") + 1) === name,
	);
	if (retained)
		throw new ComponentNameTakenError(name, {
			kind: "module",
			moduleId: retained.id.slice(0, retained.id.indexOf(":")),
		});
}

/** Refuses a name another Component of the Site has. */
async function checkNameUnused(scope: SiteScope, name: string): Promise<void> {
	const other = await scope.first(components, eq(components.name, name));
	if (other) throw new ComponentNameTakenError(name, { kind: "component", id: other.id });
}

/**
 * Runs a save, turning another Component's name into `ComponentNameTakenError`. The save's
 * transaction has rolled back by then, so the Component that took the name meanwhile can be read.
 */
async function naming<Result>(scope: SiteScope, name: string, save: () => Promise<Result>): Promise<Result> {
	try {
		return await save();
	} catch (error) {
		if (isUniqueViolation(error, "components_site_id_name_unique")) {
			await checkNameUnused(scope, name);
			throw new ComponentNameTakenError(name, { kind: "component", id: "" });
		}
		throw error;
	}
}

/** Runs a save again when someone else made the same generated Class at the same moment. */
async function retryOnClassRace<T>(save: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await save();
		} catch (error) {
			if (!(error instanceof ClassRaceError) || attempt >= 3) throw error;
		}
	}
}

/**
 * Holds the Site's Components (and what places them) until the transaction ends: saves, publishes
 * and deletes check which Components place which, so they take turns.
 */
export async function lockComponents(scope: Pick<SiteScope, "db" | "site">): Promise<void> {
	await scope.db.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`webcraft:site-components:${scope.site.id}`}, 0))`,
	);
}

// ---------------------------------------------------------------------------------------------------
// What a Component's tree may hold

/** What a Component's tree may read besides its Props: the Post Types (for Relationship Props) and the Globals. */
export type ComponentReadContext = {
	postTypes: readonly PostType[];
	globalFields: readonly FieldDefinition[];
	/** The Loops of the Site its tree may name (`{{@loop latest-posts}}`). */
	loops: LoopCatalogue;
};

/** What a Component's tree reads: the Loops' Drafts for a Draft being saved, their published versions for a publish. */
export async function readContext(
	scope: Pick<SiteScope, "select" | "first">,
	version: "draft" | "published" = "draft",
): Promise<ComponentReadContext> {
	return {
		postTypes: await listPostTypes(scope),
		globalFields: storedFields((await scope.first(globals))?.fields),
		loops: await loopCatalogue(scope, version),
	};
}

/**
 * What a Component's tree may hold: its Props as `props.x` and the Globals as `site.x` (nothing of
 * the Entry it is placed on: that comes in through Props), other Components (never in a loop back
 * to itself), and neither `<main>` nor `{{@outlet}}`: it goes inside pages.
 */
export function componentTreeRules(
	props: readonly FieldDefinition[],
	context: ComponentReadContext,
	catalogue: SiteComponents,
) {
	return {
		isKnownValue: componentKnownValues({ props, postTypes: context.postTypes, globalFields: context.globalFields }),
		unknownValue: (path: string) => unknownInComponent(path, props),
		refuseElement: (tag: string) =>
			tag === "main"
				? "A Component goes inside pages, so it holds no <main>: the Site template has the page's one."
				: undefined,
		refuseCommand: refuseSiteTemplateCommands,
		components: catalogue,
		forms: catalogue.forms,
		popups: catalogue.popups,
		filters: catalogue.filters,
		loops: context.loops,
		// A Component's tree is itself placed: what it places sits one level deeper.
		placedDepth: 1,
	};
}

/**
 * What a Module's Component's markup may hold: its Props as `props.x` and nothing else to read (the
 * Globals differ on every Site); no Classes, inline styles or Components (each Site has its own);
 * neither `<main>` nor `{{@outlet}}`.
 */
export function moduleComponentTreeRules(props: readonly FieldDefinition[]) {
	const known = componentKnownValues({ props, postTypes: [], globalFields: [] });
	return {
		isKnownValue: (path: string) => path.startsWith("props.") && known(path),
		unknownValue: (path: string) =>
			path.startsWith("props.")
				? unknownInComponent(path, props)
				: `${path}: A Module's Component reads only its Props (props.x): the Globals differ on every Site.`,
		refuseElement: (tag: string) =>
			tag === "main" ? "A Component goes inside pages, so it holds no <main>." : undefined,
		refuseCommand: refuseSiteTemplateCommands,
		forms: NO_FORMS,
		filters: NO_FILTERS,
		placedDepth: 1,
	};
}

/** Why a Component can't read `path`. */
function unknownInComponent(path: string, props: readonly FieldDefinition[]): string {
	const [head, key = "", ...rest] = path.split(".");
	if (head === "props") {
		if (!props.some((prop) => prop.key === key)) return `There is no Prop named ${key} on this Component.`;
		return `${path}: the Prop ${key} has no part named ${rest.join(".")}.`;
	}
	if (head === "site") return `There is no Global named ${path.slice(5)} on this Site.`;
	return `${path}: a Component reads only its Props (props.x) and the Globals (site.x). Give it a Prop, and pass the value in where it is placed.`;
}

function printMarkup(tree: ElementTree, classes: ClassCatalogue, names: SiteComponents): string {
	return printTemplateMarkup(tree, {
		className: classes.nameOf,
		componentName: names.nameOf,
		formKey: names.forms.keyOf,
		popupKey: names.popups.keyOf,
		filterName: names.filters.nameOf,
	});
}

// ---------------------------------------------------------------------------------------------------
// The Site's Components, as trees placing them see them

/** The Site's Components in one version, for reading, checking, printing and rendering trees that place them. */
export type SiteComponents = ComponentCatalogue & {
	/** The PascalCase name of a Component of the Site (or of a Module running there). */
	nameOf(componentId: string): string | undefined;
	/** The version a Placement shows: the Component's Props and tree in this version. */
	version(componentId: string): ComponentVersion | undefined;
	/** Whether a Component's tree places another, directly or through other Components. */
	reaches(from: string, target: string): boolean;
	/** The Site's Forms in the same version, which trees place with `{{@form <key>}}`. */
	forms: SiteForms;
	popups: Awaited<ReturnType<typeof sitePopups>>;
	/** The Site's Filters in the same version, which trees place with `{{@filter <name> for="…"}}`. */
	filters: SiteFilters;
};

type CatalogueEntry = {
	id: string;
	name: string;
	version: ComponentVersion | null;
	/** Why it can't be placed on this Site at all: its Module doesn't run here. */
	away?: string;
};

/**
 * The Site's own Components and those of the Modules running on it, in one version: Drafts (what
 * Drafts of Templates and Components place) or published (what published ones place; a Component
 * never published can't be placed there yet). Checking `self`'s tree, a Component that places it
 * (directly or through others) is refused: Components never place themselves.
 */
export async function siteComponents(
	scope: Pick<SiteScope | VisitorScope, "select" | "site" | "db" | "where">,
	which: "draft" | "published",
	sources: ComponentSources,
	options: {
		self?: string;
		/** A version to see in place of one Component's: the one about to be published. */
		replace?: { id: string; version: ComponentVersion };
	} = {},
): Promise<SiteComponents> {
	const rows = await scope.select(components);
	const versionOf = (row: ComponentRow): ComponentVersion | null => {
		if (row.id === options.replace?.id) return options.replace.version;
		if (which === "draft") return storedComponentVersion(row.draft);
		return row.published === null ? null : storedComponentVersion(row.published);
	};
	const entries: CatalogueEntry[] = rows.map((row) => ({ id: row.id, name: row.name, version: versionOf(row) }));
	const running = new Set((await sources.moduleComponentsAt(scope)).map((component) => component.id));
	const retained = new Map(
		(await sources.retainedModuleComponentsAt(scope)).map((component) => [component.id, component]),
	);
	for (const component of sources.allModuleComponents()) {
		// The Site's own Component keeps a name a Module's Component took later.
		if (entries.some((entry) => entry.name === component.name)) continue;
		const source = retained.get(component.id);
		retained.delete(component.id);
		entries.push(
			running.has(component.id)
				? { id: component.id, name: component.name, version: { props: component.props, tree: component.tree } }
				: source
					? { id: component.id, name: component.name, version: { props: source.props, tree: EMPTY_TREE } }
					: {
							id: component.id,
							name: component.name,
							version: null,
							away: `${component.name} comes from the Module ${component.moduleId}, which isn't on for this Site.`,
						},
		);
	}
	// Source-only entries let unchanged Placements round-trip through markup. They render nothing;
	// the shared Draft writes refuse new or changed Props until a compatible Module is available.
	for (const component of retained.values()) {
		const name = component.id.slice(component.id.indexOf(":") + 1);
		if (entries.some((entry) => entry.name === name)) continue;
		entries.push({ id: component.id, name, version: { props: component.props, tree: EMPTY_TREE } });
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const placed = new Map<string, string[]>();
	const placedBy = (id: string) => {
		let ids = placed.get(id);
		if (!ids) {
			const version = byId.get(id)?.version;
			ids = version ? componentsPlacedIn(version.tree) : [];
			placed.set(id, ids);
		}
		return ids;
	};
	/** Whether `from`'s tree places `target`, directly or through other Components. */
	const reaches = (from: string, target: string): boolean => {
		const seen = new Set<string>();
		const stack = [from];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (id === target) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			stack.push(...placedBy(id));
		}
		return false;
	};
	const infos = new Map<string, ReturnType<ComponentCatalogue["byId"]>>();
	const infoOf = (entry: CatalogueEntry | undefined): ReturnType<ComponentCatalogue["byId"]> => {
		if (!entry) return undefined;
		const known = infos.has(entry.id);
		if (known) return infos.get(entry.id);
		let found: ReturnType<ComponentCatalogue["byId"]>;
		if (entry.away) {
			found = { refused: entry.away };
		} else if (!entry.version) {
			found = { refused: `${entry.name} isn't published yet: publish it first.` };
		} else if (options.self !== undefined && entry.id === options.self) {
			found = { refused: `A Component can't place itself: ${entry.name} would never end.` };
		} else if (options.self !== undefined && reaches(entry.id, options.self)) {
			found = { refused: `${entry.name} places this Component, so placing it here would never end.` };
		} else {
			found = { id: entry.id, name: entry.name, props: propInfos(entry.version.props), tree: entry.version.tree };
		}
		infos.set(entry.id, found);
		return found;
	};
	return {
		named: (name) => infoOf(byName.get(name)),
		byId: (id) => infoOf(byId.get(id)),
		nameOf: (id) => byId.get(id)?.name,
		version: (id) => byId.get(id)?.version ?? undefined,
		reaches,
		forms: await siteForms(scope, which),
		popups: await sitePopups(scope, which),
		filters: await siteFilters(scope, which),
	};
}

/**
 * Checks, before a Component's new version is published, that every published Template and
 * Component placing it (directly or through others) still holds HTML a browser keeps as it is, and
 * stays within the size limits, once the new version shows there. Throws `ElementTreeInvalidError`
 * saying where.
 */
export async function checkPublishedPlacements(
	scope: SiteScope,
	componentId: string,
	next: ComponentVersion,
	sources: ComponentSources,
): Promise<void> {
	const catalogue = await siteComponents(scope, "published", sources, { replace: { id: componentId, version: next } });
	const postTypes = new Map((await listPostTypes(scope)).map((postType) => [postType.id, postType.name]));
	const holders = [
		...(await scope.select(templates))
			.filter((row) => row.published !== null)
			.map((row) => ({
				where:
					row.kind === "site"
						? "the Site template"
						: `the ${row.kind === "archive" ? "Archive" : "Entry"} template of ${postTypes.get(row.postTypeId ?? "")}`,
				tree: row.published as ElementTree,
				placedDepth: 0,
			})),
		...(await scope.select(components))
			.filter((row) => row.published !== null && row.id !== componentId)
			.map((row) => ({
				where: `the Component ${row.name}`,
				tree: storedComponentVersion(row.published).tree,
				placedDepth: 1,
			})),
	];
	const showsIt = (placed: string) => placed === componentId || catalogue.reaches(placed, componentId);
	const problems: { at: string; message: string }[] = [];
	for (const holder of holders) {
		if (!componentsPlacedIn(holder.tree).some(showsIt)) continue;
		for (const { node, message } of placementProblems(holder.tree.nodes, catalogue.byId, holder.placedDepth)) {
			if (showsIt(node.component)) problems.push({ at: "", message: `In ${holder.where}: ${message}` });
		}
		const tooBig = expansionProblem(holder.tree.nodes, catalogue.byId);
		if (tooBig) problems.push({ at: "", message: `In ${holder.where}: ${tooBig.message}` });
	}
	if (problems.length > 0) throw new ElementTreeInvalidError(problems);
}

/** What reading and checking Placements needs to know about a Component's Props. */
function propInfos(props: readonly FieldDefinition[]): PropInfo[] {
	return props.map((prop) => ({
		key: prop.key,
		required: prop.required && (prop.default === null || prop.default === undefined),
		check(text) {
			const read = readPropText(prop, text);
			return "problem" in read ? read.problem : undefined;
		},
	}));
}

// ---------------------------------------------------------------------------------------------------
// Where Components are used

/** A tree of the Site that can place Components or hold Classes, with what it is. */
type Holder = { use: ComponentUse; draft: ElementTree; published: ElementTree | null };

/**
 * The Site's trees (every Template's and Component's Draft and published version, and the
 * accessibility statement's page) and how many published pages show what some of them hold.
 */
async function pageGraph(
	scope: SiteScope,
): Promise<{
	holders: Holder[];
	pagesShowing(seed: readonly Holder[]): number;
	placers(componentId: string): Holder[];
}> {
	const templateRows = await scope.select(templates);
	const componentRows = await scope.select(components);
	const holders: Holder[] = [
		...templateRows.map((row) => ({
			use: {
				kind: "template" as const,
				id: row.id,
				templateKind: row.kind as "site" | "entry" | "archive",
				postTypeId: row.postTypeId,
				versions: [],
			},
			draft: row.draft as ElementTree,
			published: row.published as ElementTree | null,
		})),
		...componentRows.map((row) => ({
			use: { kind: "component" as const, id: row.id, name: row.name, versions: [] },
			draft: storedComponentVersion(row.draft).tree,
			published: row.published === null ? null : storedComponentVersion(row.published).tree,
		})),
	];
	const statement = await scope.first(accessibilityStatements);
	const statementPage = statement ? await scope.first(entries, eq(entries.id, statement.pageId)) : undefined;
	if (statement && statementPage) {
		const tree: ElementTree = {
			version: 1,
			nodes: [{ type: "component", id: "accessibility-statement", component: statement.componentId, props: [] }],
		};
		holders.push({
			use: { kind: "entry", id: statementPage.id, postTypeId: statementPage.postTypeId, versions: [] },
			draft: tree,
			published: statementPage.published ? tree : null,
		});
	}
	/** Which published trees place a Component directly: holders by the Component's id. */
	const publishedPlacers = new Map<string, Holder[]>();
	for (const holder of holders) {
		for (const id of new Set(holder.published ? componentsPlacedIn(holder.published) : [])) {
			publishedPlacers.set(id, [...(publishedPlacers.get(id) ?? []), holder]);
		}
	}

	const postTypes = await listPostTypes(scope);
	const publishedEntries = new Map(
		(
			await scope.db
				.select({ postTypeId: entries.postTypeId, entries: count() })
				.from(entries)
				.where(and(scope.where(entries), isNotNull(entries.published)))
				.groupBy(entries.postTypeId)
		).map((row) => [row.postTypeId, row.entries]),
	);
	const withEntryTemplate = new Set(
		templateRows.filter((row) => row.kind === "entry" && row.published !== null).map((row) => row.postTypeId),
	);
	/** Post Types whose published Archive template has an address: one more page each. */
	const withArchive = new Set((await publishedArchives(scope, postTypes)).map((archive) => archive.postType.id));
	/** Every published page: Entries whose Entry template is published, Pages, and Archive pages. */
	const allPages =
		postTypes
			.filter((postType) => isPagePostType(postType) || withEntryTemplate.has(postType.id))
			.reduce((sum, postType) => sum + (publishedEntries.get(postType.id) ?? 0), 0) + withArchive.size;

	/**
	 * How many published pages show what `seed` (published trees) hold: through the Components and
	 * Templates that place those trees, every page when the Site template does.
	 */
	const pagesShowing = (seed: readonly Holder[]): number => {
		const seen = new Set<string>();
		const stack = [...seed];
		const postTypeIds = new Set<string>();
		const archives = new Set<string>();
		const individualPages = new Set<string>();
		while (stack.length > 0) {
			const holder = stack.pop() as Holder;
			if (holder.use.kind === "component" || holder.use.kind === "popup") {
				if (!seen.has(holder.use.id)) {
					seen.add(holder.use.id);
					stack.push(...(publishedPlacers.get(holder.use.id) ?? []));
				}
			} else if (holder.use.kind === "entry") {
				individualPages.add(holder.use.id);
			} else if (holder.use.templateKind === "site") {
				return allPages;
			} else if (holder.use.templateKind === "archive" && holder.use.postTypeId) {
				if (withArchive.has(holder.use.postTypeId)) archives.add(holder.use.postTypeId);
			} else if (holder.use.postTypeId) {
				postTypeIds.add(holder.use.postTypeId);
			}
		}
		return (
			[...postTypeIds].reduce((sum, postTypeId) => sum + (publishedEntries.get(postTypeId) ?? 0), 0) +
			archives.size +
			individualPages.size
		);
	};
	return { holders, pagesShowing, placers: (componentId) => publishedPlacers.get(componentId) ?? [] };
}

/**
 * How many published pages show an element of a published tree that `holds` accepts, counted as a
 * Component's pages are: a Class's own uses, through the Templates and Components that place them.
 */
export async function publishedPagesShowing(
	scope: SiteScope,
): Promise<(holds: (tree: ElementTree) => boolean) => number> {
	const { holders, pagesShowing } = await pageGraph(scope);
	return (holds) => pagesShowing(holders.filter((holder) => holder.published && holds(holder.published)));
}

/**
 * Where each Component of the Site is placed and on how many published pages it shows, worked out
 * from every Template's and Component's Draft and published version.
 */
async function usages(scope: SiteScope): Promise<(componentId: string) => ComponentUsage> {
	const { holders, pagesShowing, placers } = await pageGraph(scope);
	const directUses = new Map<string, ComponentUse[]>();
	for (const holder of holders) {
		const inDraft = new Set(componentsPlacedIn(holder.draft));
		const inPublished = new Set(holder.published ? componentsPlacedIn(holder.published) : []);
		for (const id of new Set([...inDraft, ...inPublished])) {
			const versions = [
				...(inDraft.has(id) ? (["draft"] as const) : []),
				...(inPublished.has(id) ? (["published"] as const) : []),
			];
			directUses.set(id, [...(directUses.get(id) ?? []), { ...holder.use, versions }]);
		}
	}
	for (const row of await scope.select(popups)) {
		const uses = directUses.get(row.componentId) ?? [];
		uses.push({
			kind: "popup",
			id: row.id,
			name: row.name,
			versions: row.published ? ["draft", "published"] : ["draft"],
		});
		directUses.set(row.componentId, uses);
	}
	return (componentId) => ({ pages: pagesShowing(placers(componentId)), usedIn: directUses.get(componentId) ?? [] });
}

// ---------------------------------------------------------------------------------------------------
// Rows

export function toComponent(row: ComponentRow): Component {
	return {
		id: row.id,
		siteId: row.siteId,
		name: row.name,
		module: null,
		status: row.published === null ? "draft" : sameJson(row.draft, row.published) ? "published" : "changed",
		draft: storedComponentVersion(row.draft),
		published: row.published === null ? null : storedComponentVersion(row.published),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}

function moduleComponent(siteId: string, component: ModuleComponent): Component {
	const version = { props: component.props, tree: component.tree };
	return {
		id: component.id,
		siteId,
		name: component.name,
		module: { id: component.moduleId, ...(component.blockType ? { blockType: true, label: component.label } : {}) },
		status: "published",
		draft: version,
		published: version,
		createdAt: null,
		updatedAt: null,
		publishedAt: null,
		lastPublishedAt: null,
	};
}
