/** The Site has no address on its own domain yet (no sites domain, no Primary domain), so Edit mode can't open there. */
export class EditModeUnavailableError extends Error {
	override name = "EditModeUnavailableError";
	constructor() {
		super("The Site has no address to open in Edit mode yet.");
	}
}

/** The page asked for isn't a path on the Site, such as `/blog/fresh-bread`. */
export class EditPathInvalidError extends Error {
	override name = "EditPathInvalidError";
	constructor() {
		super("Edit mode opens a path on the Site, such as /blog/fresh-bread.");
	}
}
