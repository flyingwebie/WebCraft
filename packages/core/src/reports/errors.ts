/** No such Report on this Dashboard, or one the person isn't shown. */
export class ReportNotFoundError extends Error {
	override name = "ReportNotFoundError";
	constructor() {
		super("There is no such Report here.");
	}
}

/** What can be wrong with a Report: its `name`, `schedule`, `language`, `recipients`, AI `text`, or too many `reports`. */
export type ReportField = "name" | "schedule" | "language" | "recipients" | "text" | "reports";

export class ReportInvalidError extends Error {
	override name = "ReportInvalidError";
	readonly field: ReportField;
	constructor(field: ReportField, message: string) {
		super(message);
		this.field = field;
	}
}

/** No such entry in a Report's history. */
export class ReportSendNotFoundError extends Error {
	override name = "ReportSendNotFoundError";
	constructor() {
		super("There is no such Report in the history.");
	}
}

/**
 * What can't be done to an entry of a Report's history now: `notHeld` (only one waiting for review is
 * edited, approved or discarded), `notSent` (only one sent, or failed, is sent again), `noPdf` (its PDF
 * isn't kept: it wasn't made, or is too old), `noRecipients` (the Report goes to nobody).
 */
export type ReportSendRefusal = "notHeld" | "notSent" | "noPdf" | "noRecipients";

export class ReportSendRefusedError extends Error {
	override name = "ReportSendRefusedError";
	readonly reason: ReportSendRefusal;
	constructor(reason: ReportSendRefusal) {
		super(
			{
				notHeld: "Only a Report waiting for review can be edited, approved or discarded.",
				notSent: "Only a Report that was sent, or failed, can be sent again.",
				noPdf: "This Report's PDF isn't kept.",
				noRecipients: "This Report goes to nobody: add recipients first.",
			}[reason],
		);
		this.reason = reason;
	}
}

/** No such Share link on this Dashboard. */
export class ShareLinkNotFoundError extends Error {
	override name = "ShareLinkNotFoundError";
	constructor() {
		super("There is no such Share link here.");
	}
}

/** What can be wrong with a Share link: its `name`, `password` (8 to 200 characters), `expiresAt` (in the future), `language`, or too many `links`. */
export type ShareLinkField = "name" | "password" | "expiresAt" | "language" | "links";

export class ShareLinkInvalidError extends Error {
	override name = "ShareLinkInvalidError";
	readonly field: ShareLinkField;
	constructor(field: ShareLinkField, message: string) {
		super(message);
		this.field = field;
	}
}

/** The Install has no sites domain, so there is nowhere to serve Share links. */
export class ShareLinksUnavailableError extends Error {
	override name = "ShareLinksUnavailableError";
	constructor() {
		super("Share links need the Install's sites domain (WEBCRAFT_SITES_DOMAIN): they are served under it.");
	}
}

/** What can be wrong with branding: a `logo` (PNG, JPEG or WebP, at most 256 KB), an `accentColour` (#rrggbb) or a `name`. */
export type BrandingField = "logo" | "accentColour" | "name";

export class BrandingInvalidError extends Error {
	override name = "BrandingInvalidError";
	readonly field: BrandingField;
	constructor(field: BrandingField, message: string) {
		super(message);
		this.field = field;
	}
}

/** The Services list can't be saved: too many services, or one without a name. */
export class ServicesListInvalidError extends Error {
	override name = "ServicesListInvalidError";
}
