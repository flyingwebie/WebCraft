/**
 * The places (SPEC 2): the rail's six, in the rail's order, then those behind its "more" (the places
 * Modules add: Forms, SPEC 15.2).
 */
export const PLACE_KEYS = ["content", "templates", "media", "styles", "loops", "components", "forms"] as const;

/** The places behind the rail's "more", rather than a button of their own. */
export const MORE_PLACE_KEYS = ["forms"] as const satisfies readonly (typeof PLACE_KEYS)[number][];

export type PlaceKey = (typeof PLACE_KEYS)[number];

/** The rail's place an address's `wc-place` belongs to (`content/pages` is Content's), or null. */
export function placeKeyOf(place: string | null): PlaceKey | null {
	if (!place) return null;
	const head = place.split("/")[0];
	return PLACE_KEYS.find((key) => key === head) ?? null;
}
