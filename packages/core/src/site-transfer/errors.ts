import type { ArchiveRefusalReason } from "./format.ts";

/** No Site export with that id on the Site, or its download link doesn't hold (wrong, expired, gone). */
export class SiteExportNotFoundError extends Error {
	override name = "SiteExportNotFoundError";
	constructor() {
		super("There is no such Site export, or its download link has expired.");
	}
}

/** The Site is being exported already: one export of a Site at a time. */
export class SiteExportRunningError extends Error {
	override name = "SiteExportRunningError";
	constructor() {
		super("This Site is being exported already. Wait for that export to finish.");
	}
}

/** No Site import with that id in the Workspace (or not one you uploaded). */
export class SiteImportNotFoundError extends Error {
	override name = "SiteImportNotFoundError";
	constructor() {
		super("There is no such Site import in this Workspace.");
	}
}

/**
 * A part of an upload, or the upload, was refused: `hash` (send the part again), `offset` (go on from
 * `receivedBytes`), `part` (not the size it should be), `size` (too large), `status` (not the step it
 * is at).
 */
export type SiteImportUploadProblem = "hash" | "offset" | "part" | "size" | "status";

export class SiteImportUploadRefusedError extends Error {
	override name = "SiteImportUploadRefusedError";
	readonly reason: SiteImportUploadProblem;
	readonly details: Record<string, unknown>;
	constructor(reason: SiteImportUploadProblem, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.reason = reason;
		this.details = details;
	}
}

/** The archive uploaded isn't a Site export this Install takes (see `ArchiveRefusalReason`). */
export class SiteImportRefusedError extends Error {
	override name = "SiteImportRefusedError";
	readonly reason: ArchiveRefusalReason;
	readonly details: Record<string, unknown>;
	constructor(reason: ArchiveRefusalReason, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.reason = reason;
		this.details = details;
	}
}

/** The import can't start in the state it is in (still uploading, refused, started already). */
export class SiteImportStateError extends Error {
	override name = "SiteImportStateError";
	readonly status: string;
	constructor(status: string) {
		super("This Site import can't be started now: it isn't a whole, readable export waiting to be imported.");
		this.status = status;
	}
}
