/**
 * Code mode was asked for a Template or Component the page doesn't show: a reference no element of
 * the page carries (a Placement that isn't there any more, a page with no Entry template).
 */
export class CodeSourceNotFoundError extends Error {
	override name = "CodeSourceNotFoundError";
	constructor() {
		super("This page shows no such Template or Component.");
	}
}
