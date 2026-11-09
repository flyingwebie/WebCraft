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

/**
 * An edit request named something that can't be changed in place: an item that isn't the Globals or
 * an Entry (`entry:<id>`), or a value that isn't a text or rich text Field (or the title).
 */
export class EditFieldInvalidError extends Error {
	override name = "EditFieldInvalidError";
	constructor() {
		super("Only the title and text and rich text Fields can be changed in place.");
	}
}
