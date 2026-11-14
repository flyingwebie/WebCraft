/** The rail's places (SPEC 2), in the rail's order. */
export const PLACE_KEYS = ["content", "templates", "media", "styles", "loops", "components"] as const;

export type PlaceKey = (typeof PLACE_KEYS)[number];

/** The rail's place an address's `wc-place` belongs to (`content/pages` is Content's), or null. */
export function placeKeyOf(place: string | null): PlaceKey | null {
	if (!place) return null;
	const head = place.split("/")[0];
	return PLACE_KEYS.find((key) => key === head) ?? null;
}
