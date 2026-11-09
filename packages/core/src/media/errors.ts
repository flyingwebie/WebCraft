/** One reason a Media change was refused, and where: `language`, `alt`. */
export type MediaProblem = { at: string; message: string };

/** There is no such Media item on the Site. */
export class MediaNotFoundError extends Error {
	override name = "MediaNotFoundError";
	constructor() {
		super("There is no such file in this Site's Media library.");
	}
}

/** There is no such folder in the Site's Media library. */
export class MediaFolderNotFoundError extends Error {
	override name = "MediaFolderNotFoundError";
	constructor() {
		super("There is no such folder in this Site's Media library.");
	}
}

/** Another folder of the Site's Media library has the name. */
export class MediaFolderTakenError extends Error {
	override name = "MediaFolderTakenError";
	constructor() {
		super("Another folder of this Media library has this name.");
	}
}

/**
 * A file WebCraft doesn't take: `unknown` (not an image, SVG, document, video or audio file WebCraft
 * knows, whatever its name says).
 */
export class MediaTypeRefusedError extends Error {
	override name = "MediaTypeRefusedError";
	readonly reason: "unknown";
	constructor(reason: "unknown") {
		super("This file isn't an image, document, video or audio file the Media library takes.");
		this.reason = reason;
	}
}

/** A file over the size limit. */
export class MediaTooLargeError extends Error {
	override name = "MediaTooLargeError";
	readonly maxBytes: number;
	constructor(maxBytes: number) {
		super(`Files can be at most ${Math.round(maxBytes / (1024 * 1024))} MB.`);
		this.maxBytes = maxBytes;
	}
}

/** The file is in the Trash: restore it before changing it. */
export class MediaInTrashError extends Error {
	override name = "MediaInTrashError";
	constructor() {
		super("This file is in the Trash; restore it first.");
	}
}

/** The file isn't in the Trash, so it can't be restored or deleted for good. */
export class MediaNotInTrashError extends Error {
	override name = "MediaNotInTrashError";
	constructor() {
		super("This file isn't in the Trash.");
	}
}

/** Replace file refused the new file: `kind` (it isn't the same kind of file: an image for an image). */
export class MediaReplaceRefusedError extends Error {
	override name = "MediaReplaceRefusedError";
	readonly reason: "kind";
	constructor(reason: "kind") {
		super("A file is replaced by one of the same kind: an image by an image, a document by a document.");
		this.reason = reason;
	}
}

/** The file would take the Workspace's Media past its storage quota. */
export class MediaQuotaFullError extends Error {
	override name = "MediaQuotaFullError";
	readonly usedBytes: number;
	readonly quotaBytes: number;
	constructor(usedBytes: number, quotaBytes: number) {
		super("This Workspace's Media storage is full: the file would take it past its quota.");
		this.usedBytes = usedBytes;
		this.quotaBytes = quotaBytes;
	}
}

/** A change to a Media item can't be saved: `problems` says what and where. */
export class MediaInvalidError extends Error {
	override name = "MediaInvalidError";
	readonly problems: readonly MediaProblem[];
	constructor(problems: readonly MediaProblem[]) {
		super(`The change can't be saved: ${problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ")}`);
		this.problems = problems;
	}
}

/** The storage settings couldn't be used: WebCraft couldn't write, read and remove a file there. */
export class StorageUnreachableError extends Error {
	override name = "StorageUnreachableError";
	readonly problem: string;
	constructor(problem: string) {
		super(`The storage can't be used: ${problem}`);
		this.problem = problem;
	}
}
