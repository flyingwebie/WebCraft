import type { ContentProblem } from "../content/errors.ts";

/** There is no such Filter on the Site. */
export class FilterNotFoundError extends Error {
	override name = "FilterNotFoundError";
	constructor() {
		super("There is no such Filter on this Site.");
	}
}

/**
 * A Filter can't be saved or published: `problems` says what and where (`name`, `loop`,
 * `controls[2].source.field`).
 */
export class FilterInvalidError extends Error {
	override name = "FilterInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Filter can't be saved: ${problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ")}`);
		this.problems = problems;
	}
}

/** Another Filter of the Site has the name: `{{@filter <name> for="…"}}` names one Filter. */
export class FilterNameTakenError extends Error {
	override name = "FilterNameTakenError";
	readonly filterName: string;
	constructor(filterName: string) {
		super(`Another Filter of this Site is named ${filterName}: choose another name.`);
		this.filterName = filterName;
	}
}
