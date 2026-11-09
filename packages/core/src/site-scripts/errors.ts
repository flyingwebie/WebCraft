/** There is no outside script with that id on the Site. */
export class OutsideScriptNotFoundError extends Error {
	override name = "OutsideScriptNotFoundError";
	constructor() {
		super("There is no such outside script on this Site.");
	}
}

/** There is no Library with that id on the Site. */
export class LibraryNotFoundError extends Error {
	override name = "LibraryNotFoundError";
	constructor() {
		super("There is no such Library on this Site.");
	}
}

/**
 * Why a Library couldn't be added or updated:
 * - `name`: not a package name;
 * - `version`: not a version, a partial version (`3.13`) or a tag (`latest`);
 * - `file`: not a path to a `.js` file inside a package;
 * - `url`: not an https address;
 * - `notFound`: the registry has no such package or version;
 * - `fileNotFound`: the package has no such file (or no file to serve, when none was given);
 * - `integrity`: what was downloaded doesn't match the hash the registry gives;
 * - `size`: the file (or the package) is larger than allowed;
 * - `empty`: the file is empty;
 * - `unreachable`: the registry or the address didn't answer, or refused;
 * - `limit`: the Site holds as many Libraries as it may.
 */
export type LibraryProblem =
	| "name"
	| "version"
	| "file"
	| "url"
	| "notFound"
	| "fileNotFound"
	| "integrity"
	| "size"
	| "empty"
	| "unreachable"
	| "limit";

const MESSAGES: Record<LibraryProblem, string> = {
	name: "That isn't a package name.",
	version: "Give an exact version (3.13.0), a partial one (3.13) or a tag (latest).",
	file: "Give the path of a .js file inside the package, such as dist/library.min.js.",
	url: "Give an https address of a script file.",
	notFound: "The registry has no such package or version.",
	fileNotFound: "The package has no such file. Give the path of the file to serve.",
	integrity: "What was downloaded doesn't match the package's integrity hash.",
	size: "The file is larger than a Library may be.",
	empty: "The file is empty.",
	unreachable: "The download didn't work. Try again later.",
	limit: "This Site holds as many Libraries as it may.",
};

export class LibraryRefusedError extends Error {
	override name = "LibraryRefusedError";
	readonly problem: LibraryProblem;
	constructor(problem: LibraryProblem, options?: ErrorOptions) {
		super(MESSAGES[problem], options);
		this.problem = problem;
	}
}
