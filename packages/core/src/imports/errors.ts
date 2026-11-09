/** No such Import on the Site. */
export class ImportNotFoundError extends Error {
	override name = "ImportNotFoundError";
	constructor() {
		super("There is no such Import on this Site.");
	}
}

/** No such Import run on the Site (or its report was purged, 90 days after it ended). */
export class ImportRunNotFoundError extends Error {
	override name = "ImportRunNotFoundError";
	constructor() {
		super("There is no such Import run on this Site, or its report was purged.");
	}
}

/** No such uploaded file: never uploaded by you, taken by a run, or deleted a day after it was uploaded. */
export class ImportFileNotFoundError extends Error {
	override name = "ImportFileNotFoundError";
	constructor() {
		super("There is no such file: upload it again.");
	}
}

/** One problem with an Import's settings, at its place (`mapping.columns[2].to`), with its rule. */
export type ImportSettingProblem = { at: string; rule: string; message: string; params?: Record<string, unknown> };

/** An Import's settings don't fit the Site: a Post Type, Field or language it doesn't have. */
export class ImportInvalidError extends Error {
	override name = "ImportInvalidError";
	readonly problems: ImportSettingProblem[];
	constructor(problems: ImportSettingProblem[]) {
		super(problems.map((problem) => `${problem.at}: ${problem.message}`).join(" "));
		this.problems = problems;
	}
}

/**
 * An Import that keeps track of Entries it brought in keeps its Post Type: a run matches rows to them
 * by their Source ids, which would otherwise find Entries of the Post Type it had before. Undo its
 * runs, or start a new Import.
 */
export class ImportPostTypeFixedError extends Error {
	override name = "ImportPostTypeFixedError";
	constructor() {
		super("This Import brought Entries in, so it keeps its Post Type: undo its runs, or start a new Import.");
	}
}

/** Another run of the Import hasn't ended yet: one run at a time. */
export class ImportRunningError extends Error {
	override name = "ImportRunningError";
	readonly runId: string;
	constructor(runId: string) {
		super("A run of this Import hasn't ended yet: wait for it, or stop it.");
		this.runId = runId;
	}
}

/**
 * Why a run can't be undone:
 * - `status`: it hasn't ended, or was undone already;
 * - `published`: something it brought in was published since;
 * - `edited`: something it brought in was edited since (by a person, or by a later run);
 * - `linked`: an Entry outside the run must point at one it created (a required Relationship).
 */
export type UndoRefusal = "status" | "published" | "edited" | "linked";

/** The run can't be undone; `entries` names the Entries in the way. */
export class ImportUndoRefusedError extends Error {
	override name = "ImportUndoRefusedError";
	readonly reason: UndoRefusal;
	readonly entries: { id: string; title: string }[];
	constructor(reason: UndoRefusal, entries: { id: string; title: string }[] = []) {
		super(
			reason === "status"
				? "Only a run that ended, and wasn't undone, can be undone."
				: reason === "published"
					? "Something this run brought in was published since, so it can't be undone."
					: reason === "edited"
						? "Something this run brought in was edited since, so it can't be undone."
						: "Another Entry must point at an Entry this run created, so it can't be undone.",
		);
		this.reason = reason;
		this.entries = entries;
	}
}
