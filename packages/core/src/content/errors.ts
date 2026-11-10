/**
 * One reason something was refused, and where: `urlPattern`, `parentId`, `fields[2].key`, or a value's path such
 * as `fields.team[1].name`. A value that breaks one of its Field's rules says which (`required`,
 * `min`, `max`, `minLength`, `maxLength`, `pattern`, `integer`, `email`, `options`, `url`,
 * `postTypes`, `media`: `VALUE_RULES`), and a refused setting of a Post Type, a Field or the Globals
 * says why (`SETTING_RULES`, with `params` to fill in), so the admin can word it in the person's
 * language. `message` is the English wording API clients read.
 */
export type ContentProblem = {
	at: string;
	message: string;
	rule?: string;
	/** What fills in the wording of a setting's `rule`, such as the key or the largest number allowed. */
	params?: Readonly<Record<string, string | number>>;
	/** The language of the value it is about, when it isn't the Default language's (or a shared) value. */
	language?: string;
};

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

/** There is no such script on the Site: no Site script or page script with that id. */
export class ScriptNotFoundError extends Error {
	override name = "ScriptNotFoundError";
	constructor() {
		super("There is no such script on this Site.");
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

/**
 * Another Entry of the Post Type (for a Page, another Page under the same parent) already has the
 * slug in the language.
 */
export class EntrySlugTakenError extends Error {
	override name = "EntrySlugTakenError";
	readonly slug: string;
	readonly language: string | null;
	constructor(
		slug: string,
		among: "postType" | "siblingPages" = "postType",
		languages: { language: string; defaultLanguage: string } | null = null,
	) {
		const language = languages?.language ?? null;
		// The Default language goes without saying.
		const where = language && language !== languages?.defaultLanguage ? ` in ${language}` : "";
		super(
			among === "siblingPages"
				? `Another Page under the same parent already has the slug ${slug}${where}.`
				: `Another Entry of this Post Type already has the slug ${slug}${where}.`,
		);
		this.slug = slug;
		this.language = language;
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

/**
 * What holds a path on a Site: a Post Type's URL pattern, a published Page, or a language, whose
 * prefix starts its pages' paths.
 */
export type PathHolder =
	| { kind: "postType"; id: string; name: string; urlPattern: string }
	| { kind: "page"; id: string; title: string }
	| { kind: "language"; code: string; name: string }
	/** A Post Type's published Archive template, at its URL pattern's fixed address. */
	| { kind: "archive"; postTypeId: string; name: string };

/**
 * A path already belongs elsewhere: a Post Type's URL pattern owns every path it matches, Pages live
 * outside them, and each language other than the Default language owns every path under its prefix,
 * so a path never belongs to two of them.
 */
export class PathTakenError extends Error {
	override name = "PathTakenError";
	readonly path: string;
	readonly by: PathHolder;
	/** `taking` says what wanted the path: a URL pattern or a Page (the default), or an Archive template. */
	constructor(path: string, by: PathHolder, taking: "pathOrPattern" | "archive" = "pathOrPattern") {
		super(
			taking === "archive"
				? by.kind === "page"
					? `The Archive template's address ${path} is where the Page ${by.title} is published: move the Page or change the URL pattern.`
					: `The Archive template's address ${path} belongs elsewhere: change the URL pattern.`
				: by.kind === "postType"
					? `The path ${path} belongs to ${by.name} (${by.urlPattern}): choose another slug or parent Page.`
					: by.kind === "page"
						? `The URL pattern takes ${path}, where the Page ${by.title} is published: choose another pattern.`
						: by.kind === "archive"
							? `The path ${path} is where the Archive template of ${by.name} is published: choose another one.`
							: `The path ${path} starts with the prefix of the Site's ${by.name} pages: choose another one.`,
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
			templateKind: "entry" | "site" | "archive";
			/** The Post Type an Entry or Archive template belongs to; null for the Site template. */
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

/** A language's settings can't be saved: `problems` says what and where (`code`, `name`, `direction`, `domain`). */
export class LanguageInvalidError extends Error {
	override name = "LanguageInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The language can't be saved: ${describe(problems)}`);
		this.problems = problems;
	}
}

/** The Site already has the language, or another language on the Install already has the domain. */
export class LanguageTakenError extends Error {
	override name = "LanguageTakenError";
	readonly field: "code" | "domain";
	constructor(field: "code" | "domain") {
		super(
			field === "code"
				? "The Site already has this language."
				: "Another language on this Install already has this domain.",
		);
		this.field = field;
	}
}

/** The Site has no such language. */
export class LanguageNotFoundError extends Error {
	override name = "LanguageNotFoundError";
	constructor() {
		super("The Site has no such language.");
	}
}

/** The Site has no such Loop. */
export class LoopNotFoundError extends Error {
	override name = "LoopNotFoundError";
	constructor() {
		super("There is no such Loop on this Site.");
	}
}

/**
 * A Loop can't be saved or published: `problems` says what and where (`name`, `query.filters[1].value`,
 * `fields[0].type`, `items[2].day`).
 */
export class LoopInvalidError extends Error {
	override name = "LoopInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Loop can't be saved: ${describe(problems)}`);
		this.problems = problems;
	}
}

/** A Loop can't be published yet: required values of its Loop items are empty. */
export class LoopIncompleteError extends Error {
	override name = "LoopIncompleteError";
	readonly missing: readonly string[];
	constructor(missing: readonly string[]) {
		super(`The Loop can't be published until these have a value: ${missing.join(", ")}.`);
		this.missing = missing;
	}
}

/** Another Loop of the Site already has the name: Template markup names one Loop by it. */
export class LoopNameTakenError extends Error {
	override name = "LoopNameTakenError";
	readonly loopName: string;
	constructor(loopName: string) {
		super(`Another Loop of this Site is named ${loopName}: choose another name.`);
		this.loopName = loopName;
	}
}

/**
 * A Post Type has no Archive template: the Page Post Type (`pages`: Pages are arranged with a Page
 * layout), or one whose URL pattern starts with `{slug}`, leaving no fixed address to list from (`address`).
 */
export class ArchiveUnavailableError extends Error {
	override name = "ArchiveUnavailableError";
	readonly reason: "pages" | "address";
	constructor(reason: "pages" | "address") {
		super(
			reason === "pages"
				? "Pages have no Archive template: list them with a Loop."
				: "An Archive template answers at its URL pattern's fixed parts before {slug}, and this one starts with {slug}.",
		);
		this.reason = reason;
	}
}

/**
 * The Site's home page can't be unpublished (nor a Page above it, which would take it along): `/`
 * would answer 410 Gone. Choose another home page first.
 */
export class HomePageUnpublishError extends Error {
	override name = "HomePageUnpublishError";
	constructor() {
		super("The home page can't be unpublished: choose another home page first.");
	}
}

/**
 * Why something can't be submitted for Review, or a Review can't be decided that way:
 * - `notReviewable`: only Content Authors can't publish is reviewed (Entries, the Globals, the Consent
 *   banner's words);
 * - `nothingToReview`: its Draft is what visitors see already;
 * - `commentRequired`: sending back needs a comment saying why.
 */
export type ReviewProblem = "notReviewable" | "nothingToReview" | "commentRequired";

export class ReviewInvalidError extends Error {
	override name = "ReviewInvalidError";
	readonly reason: ReviewProblem;
	readonly item: unknown;
	constructor(reason: ReviewProblem, item: unknown = null) {
		super(
			reason === "notReviewable"
				? "Only Entries, the Globals and the Consent banner's words are reviewed."
				: reason === "nothingToReview"
					? "Its Draft is what visitors see already: there is nothing to review."
					: "Say why it is sent back: a comment is needed.",
		);
		this.reason = reason;
		this.item = item;
	}
}

/** The item waits in a Review already: one Review at a time. */
export class ItemInReviewError extends Error {
	override name = "ItemInReviewError";
	readonly item: unknown;
	readonly reviewId: string;
	constructor(item: unknown, reviewId: string) {
		super("It is In review already.");
		this.item = item;
		this.reviewId = reviewId;
	}
}

/** No Review of the Site has this id. */
export class ReviewNotFoundError extends Error {
	override name = "ReviewNotFoundError";
	constructor() {
		super("No such Review.");
	}
}

/** The Review was decided already (withdrawn, sent back, published or scheduled): it no longer waits. */
export class ReviewDecidedError extends Error {
	override name = "ReviewDecidedError";
	readonly status: string;
	constructor(status: string) {
		super("It isn't In review any more.");
		this.status = status;
	}
}

/** Only the person who submitted a Review withdraws it; those who may publish it send it back instead. */
export class ReviewNotYoursError extends Error {
	override name = "ReviewNotYoursError";
	constructor() {
		super("Only the person who submitted it can withdraw it.");
	}
}
