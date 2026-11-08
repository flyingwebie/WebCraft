/**
 * One reason something was refused, and where: `urlPattern`, `fields[2].key`, or a value's path such
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

/** Another Entry of the Post Type already has the slug. */
export class EntrySlugTakenError extends Error {
	override name = "EntrySlugTakenError";
	readonly slug: string;
	constructor(slug: string) {
		super(`Another Entry of this Post Type already has the slug ${slug}.`);
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

function describe(problems: readonly ContentProblem[]): string {
	return problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ");
}
