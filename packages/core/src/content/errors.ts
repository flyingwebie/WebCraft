/**
 * One reason something was refused, and where: `urlPattern`, `parentId`, `fields[2].key`, or a value's path such
 * as `fields.team[1].name`. A value that breaks one of its Field's rules says which (`required`,
 * `min`, `max`, `minLength`, `maxLength`, `pattern`, `integer`, `email`, `options`, `url`,
 * `postTypes`), so the admin can word it in the person's language.
 */
export type ContentProblem = { at: string; message: string; rule?: string };

/** There is no such Post Type on the Site. */
export class PostTypeNotFoundError extends Error {
	override name = "PostTypeNotFoundError";
	constructor() {
		super("There is no such Post Type on this Site.");
	}
}

/** There is no such Entry on the Site. */
export class EntryNotFoundError extends Error {
	override name = "EntryNotFoundError";
	constructor() {
		super("There is no such Entry on this Site.");
	}
}

/** There is no such Page on the Site: no Entry of its Page Post Type with that id. */
export class PageNotFoundError extends Error {
	override name = "PageNotFoundError";
	constructor() {
		super("There is no such Page on this Site.");
	}
}

/**
 * A save named the version of the Draft it was based on, and the Draft has changed since: someone else
 * saved it meanwhile. Nothing was saved; `version` is the Draft's version now (null while there is
 * none), so the person can reload it, or save again over that version to overwrite it.
 */
export class DraftChangedError extends Error {
	override name = "DraftChangedError";
	readonly version: string | null;
	constructor(version: string | null) {
		super("Someone saved this Draft since you opened it: reload it, or overwrite it.");
		this.version = version;
	}
}

/** There is no such Template on the Site. */
export class TemplateNotFoundError extends Error {
	override name = "TemplateNotFoundError";
	constructor() {
		super("There is no such Template on this Site.");
	}
}

/** A Post Type's settings can't be saved: `problems` says what and where. */
export class PostTypeInvalidError extends Error {
	override name = "PostTypeInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Post Type can't be saved: ${describe(problems)}`);
		this.problems = problems;
	}
}

/** Another Post Type of the Site already has the key or the URL pattern. */
export class PostTypeTakenError extends Error {
	override name = "PostTypeTakenError";
	readonly field: "key" | "urlPattern";
	constructor(field: "key" | "urlPattern") {
		super(
			field === "key"
				? "Another Post Type of this Site already has this key."
				: "Another Post Type of this Site already has this URL pattern.",
		);
		this.field = field;
	}
}

/** An Entry's values can't be saved: `problems` says which and why. */
export class EntryInvalidError extends Error {
	override name = "EntryInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Entry can't be saved: ${describe(problems)}`);
		this.problems = problems;
	}
}

/** Another Entry of the Post Type (for a Page, another Page under the same parent) already has the slug. */
export class EntrySlugTakenError extends Error {
	override name = "EntrySlugTakenError";
	readonly slug: string;
	constructor(slug: string, among: "postType" | "siblingPages" = "postType") {
		super(
			among === "siblingPages"
				? `Another Page under the same parent already has the slug ${slug}.`
				: `Another Entry of this Post Type already has the slug ${slug}.`,
		);
		this.slug = slug;
	}
}

/**
 * Deleting the Entry is blocked: other Entries point at it through a required Relationship. Change
 * them first.
 */
export class EntryLinkedError extends Error {
	override name = "EntryLinkedError";
	readonly blockedBy: readonly { entryId: string; postTypeId: string; title: string; fields: readonly string[] }[];
	constructor(blockedBy: EntryLinkedError["blockedBy"]) {
		super(
			`The Entry can't be deleted: ${blockedBy.map((entry) => entry.title || entry.entryId).join(", ")} must point at it through a required Relationship.`,
		);
		this.blockedBy = blockedBy;
	}
}

/** The Globals' values can't be saved or published: `problems` says which and why. */
export class GlobalsInvalidError extends Error {
	override name = "GlobalsInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Globals can't be saved: ${describe(problems)}`);
		this.problems = problems;
	}
}

/** The Globals can't be published yet: required values are empty. */
export class GlobalsIncompleteError extends Error {
	override name = "GlobalsIncompleteError";
	readonly missing: readonly string[];
	constructor(missing: readonly string[]) {
		super(`The Globals can't be published until these have a value: ${missing.join(", ")}.`);
		this.missing = missing;
	}
}

/** The Entry can't be published yet: required values are empty. */
export class EntryIncompleteError extends Error {
	override name = "EntryIncompleteError";
	/** The paths of the empty values: `title`, `slug`, Field keys, `address.city`, `team[0].name`. */
	readonly missing: readonly string[];
	constructor(missing: readonly string[]) {
		super(`The Entry can't be published until these have a value: ${missing.join(", ")}.`);
		this.missing = missing;
	}
}

/** What holds a path on a Site: a Post Type's URL pattern, or a published Page. */
export type PathHolder =
	| { kind: "postType"; id: string; name: string; urlPattern: string }
	| { kind: "page"; id: string; title: string };

/**
 * A path already belongs elsewhere: a Post Type's URL pattern owns every path it matches, and Pages
 * live outside them, so a path never belongs to both.
 */
export class PathTakenError extends Error {
	override name = "PathTakenError";
	readonly path: string;
	readonly by: PathHolder;
	constructor(path: string, by: PathHolder) {
		super(
			by.kind === "postType"
				? `The path ${path} belongs to ${by.name} (${by.urlPattern}): choose another slug or parent Page.`
				: `The URL pattern takes ${path}, where the Page ${by.title} is published: choose another pattern.`,
		);
		this.path = path;
		this.by = by;
	}
}

/** Pages are arranged with a Page layout, so the Page Post Type has no Entry template. */
export class PagesHaveNoEntryTemplateError extends Error {
	override name = "PagesHaveNoEntryTemplateError";
	constructor() {
		super("Pages are arranged with a Page layout, not an Entry template.");
	}
}

/** A Page with Pages under it can't be deleted: they would point at nothing. */
export class PageHasChildrenError extends Error {
	override name = "PageHasChildrenError";
	/** How many Pages name it as their parent, in their Drafts or published. */
	readonly children: number;
	constructor(children: number) {
		super("Pages are nested under this Page: move or delete them first.");
		this.children = children;
	}
}

/** A Page can't be published while its parent Page isn't: its address starts with its parent's. */
export class PageParentUnpublishedError extends Error {
	override name = "PageParentUnpublishedError";
	constructor() {
		super("Publish the parent Page first: a Page's address starts with its parent's.");
	}
}

/** There is no such Component on the Site (nor one a Module running there declares). */
export class ComponentNotFoundError extends Error {
	override name = "ComponentNotFoundError";
	constructor() {
		super("There is no such Component on this Site.");
	}
}

/** A Component's name or Props can't be saved: `problems` says what and where (`name`, `props[1].options`). */
export class ComponentInvalidError extends Error {
	override name = "ComponentInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Component can't be saved: ${describe(problems)}`);
		this.problems = problems;
	}
}

/** What already has a Component's name: another Component of the Site, or a Module's Component. */
export type ComponentNameHolder = { kind: "component"; id: string } | { kind: "module"; moduleId: string };

/** Another Component already has the name: a tag names one Component. */
export class ComponentNameTakenError extends Error {
	override name = "ComponentNameTakenError";
	readonly componentName: string;
	readonly by: ComponentNameHolder;
	constructor(componentName: string, by: ComponentNameHolder) {
		super(
			by.kind === "module"
				? `The Module ${by.moduleId} has a Component named ${componentName}: choose another name.`
				: `Another Component of this Site is named ${componentName}: choose another name.`,
		);
		this.componentName = componentName;
		this.by = by;
	}
}

/** Where a Component is placed: a Template's or another Component's Draft or published version. */
export type ComponentUse =
	| {
			kind: "template";
			id: string;
			templateKind: "entry" | "site";
			/** The Post Type an Entry template renders; null for the Site template. */
			postTypeId: string | null;
			versions: ("draft" | "published")[];
	  }
	| { kind: "component"; id: string; name: string; versions: ("draft" | "published")[] };

/** A Component that is placed somewhere can't be deleted: `usedIn` says where. */
export class ComponentInUseError extends Error {
	override name = "ComponentInUseError";
	readonly usedIn: readonly ComponentUse[];
	constructor(usedIn: readonly ComponentUse[]) {
		super(`The Component is placed in ${usedIn.length} Template(s) or Component(s): remove those Placements first.`);
		this.usedIn = usedIn;
	}
}

/** A Module's Component is changed by its Module, never on a Site. */
export class ComponentFromModuleError extends Error {
	override name = "ComponentFromModuleError";
	constructor() {
		super("This Component comes from a Module: it changes with the Module, not on the Site.");
	}
}

function describe(problems: readonly ContentProblem[]): string {
	return problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ");
}
