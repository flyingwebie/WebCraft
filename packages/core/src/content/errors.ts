/** One reason something was refused, and where: a Field key, `urlPattern`, `fields[2].key`, `parentId`. */
export type ContentProblem = { at: string; message: string };

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

/** The Entry can't be published yet: required values are empty. */
export class EntryIncompleteError extends Error {
	override name = "EntryIncompleteError";
	/** The keys of the empty values: `title`, `slug` or Field keys. */
	readonly missing: readonly string[];
	constructor(missing: readonly string[]) {
		super(`The Entry can't be published until these have a value: ${missing.join(", ")}.`);
		this.missing = missing;
	}
}

/** Pages are arranged with a Page layout, so the Page Post Type has no Entry template. */
export class PagesHaveNoEntryTemplateError extends Error {
	override name = "PagesHaveNoEntryTemplateError";
	constructor() {
		super("Pages are arranged with a Page layout, not an Entry template.");
	}
}

/** A Page can't be published while its parent Page isn't: its address starts with its parent's. */
export class PageParentUnpublishedError extends Error {
	override name = "PageParentUnpublishedError";
	constructor() {
		super("Publish the parent Page first: a Page's address starts with its parent's.");
	}
}

function describe(problems: readonly ContentProblem[]): string {
	return problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ");
}
