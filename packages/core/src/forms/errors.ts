import type { ContentProblem } from "../content/errors.ts";

/** There is no such Form on the Site. */
export class FormNotFoundError extends Error {
	override name = "FormNotFoundError";
	constructor() {
		super("There is no such Form on this Site.");
	}
}

/** A Form's name, key or Draft can't be saved: `problems` says what and where (`fields[2].options`). */
export class FormInvalidError extends Error {
	override name = "FormInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Form can't be saved: ${problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ")}`);
		this.problems = problems;
	}
}

/** Another Form of the Site has the key: `{{@form <key>}}` names one Form. */
export class FormKeyTakenError extends Error {
	override name = "FormKeyTakenError";
	readonly key: string;
	constructor(key: string) {
		super(`Another Form of this Site has the key ${key}: choose another.`);
		this.key = key;
	}
}

/** Where a Form is placed: a Template or Component whose Draft or published version holds `{{@form}}`. */
export type FormPlacement = {
	kind: "siteTemplate" | "entryTemplate" | "component";
	/** The Template's or Component's id. */
	id: string;
	/** The Component's name, or the Post Type's for an Entry template; null for the Site template. */
	name: string | null;
};

/** The Form is placed somewhere, so it can't be deleted: every page there would lose it. */
export class FormInUseError extends Error {
	override name = "FormInUseError";
	readonly usedIn: readonly FormPlacement[];
	constructor(usedIn: readonly FormPlacement[]) {
		super("The Form is placed in Templates or Components: take it out of them first.");
		this.usedIn = usedIn;
	}
}

/** A Form's CAPTCHA settings can't be saved: `problems` says what and where. */
export class CaptchaInvalidError extends Error {
	override name = "CaptchaInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The CAPTCHA can't be saved: ${problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ")}`);
		this.problems = problems;
	}
}
