import { type PlaceKey, placeKeyOf } from "./keys.ts";

/**
 * Where each place was left in this tab (SPEC 2: reopening a place returns to the same list and
 * scroll): its address and view, and how far each list was scrolled. Kept in memory only; the
 * address carries the place and its view across a reload.
 */
const left = new Map<PlaceKey, { place: string; view: string | null }>();
const scrolled = new Map<string, number>();

/** Remembers the place shown (a place calls it as its address changes). */
export function rememberPlace(place: string, view: string | null): void {
	const key = placeKeyOf(place);
	if (key) left.set(key, { place, view });
}

/** Where a place was left in this tab, if it was opened before. */
export function leftAt(key: PlaceKey): { place: string; view: string | null } | null {
	return left.get(key) ?? null;
}

/** Remembers how far a place's list is scrolled, by its address and view. */
export function rememberScroll(place: string, view: string | null, top: number): void {
	scrolled.set(`${place}?${view ?? ""}`, top);
}

/** How far a place's list was scrolled when it was left (0 the first time). */
export function scrollOf(place: string, view: string | null): number {
	return scrolled.get(`${place}?${view ?? ""}`) ?? 0;
}
