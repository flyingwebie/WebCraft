import type { DesignUse } from "./usage.ts";

/** There is no Class with that id in the Design system's Draft. */
export class ClassNotFoundError extends Error {
	override name = "ClassNotFoundError";
	constructor() {
		super("There is no such Class in this Site's Design system.");
	}
}

/** A Class can't be deleted while something uses it: `usedBy` says where. */
export class ClassInUseError extends Error {
	override name = "ClassInUseError";
	readonly classId: string;
	readonly usedBy: readonly DesignUse[];
	constructor(classId: string, name: string, usedBy: readonly DesignUse[]) {
		super(`The Class ${name} can't be deleted: it is used in ${usedBy.length} place${usedBy.length === 1 ? "" : "s"}.`);
		this.classId = classId;
		this.usedBy = usedBy;
	}
}

/** A Design token can't be removed while something uses it: `usedBy` says where. */
export class TokenInUseError extends Error {
	override name = "TokenInUseError";
	readonly tokenId: string;
	readonly usedBy: readonly DesignUse[];
	constructor(tokenId: string, name: string, usedBy: readonly DesignUse[]) {
		super(`The token ${name} can't be removed: it is used in ${usedBy.length} place${usedBy.length === 1 ? "" : "s"}.`);
		this.tokenId = tokenId;
		this.usedBy = usedBy;
	}
}

/** The Design tokens file can't be imported: `problems` says what and where. */
export class TokensFileInvalidError extends Error {
	override name = "TokensFileInvalidError";
	readonly problems: readonly { at: string; message: string }[];
	constructor(problems: readonly { at: string; message: string }[]) {
		super(
			`The Design tokens can't be imported: ${problems
				.slice(0, 10)
				.map((problem) => `${problem.at || "file"}: ${problem.message}`)
				.join("; ")}`,
		);
		this.problems = problems;
	}
}

/** A Design system file can't be imported: `problems` says what and where in the file. */
export class DesignSystemFileInvalidError extends Error {
	override name = "DesignSystemFileInvalidError";
	readonly problems: readonly { at: string; message: string }[];
	constructor(problems: readonly { at: string; message: string }[]) {
		super(
			`The Design system file can't be imported: ${problems
				.slice(0, 10)
				.map((problem) => `${problem.at || "file"}: ${problem.message}`)
				.join("; ")}`,
		);
		this.problems = problems;
	}
}
