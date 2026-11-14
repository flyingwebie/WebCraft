import type { ComponentType } from "react";

import type { ShellConfig, Words } from "../api.ts";
import type { BuildingDocument, Documents } from "../documents.ts";
import { ContentPlace } from "./content/ContentPlace.tsx";
import { type PlaceKey, placeKeyOf } from "./keys.ts";
import { MediaPlace } from "./media/MediaPlace.tsx";
import { leftAt } from "./memory.ts";
import { StylesPlace } from "./styles/StylesPlace.tsx";

export { PLACE_KEYS } from "./keys.ts";
export { type PlaceKey, placeKeyOf };

/**
 * The places (SPEC 2 and 8, plan BA-20): what opens over the working area from the rail, replacing the
 * canvas and the docks and keeping the rail and the bottom bar. Each has an address of its own in
 * `wc-place` (`content/pages`, `media/<folder>`, …; `documents.ts`), and the rail reads this registry:
 * a rail button whose place isn't here yet stays "not available yet".
 */

/** What a place is given by the shell. */
export type PlaceProps = {
	config: ShellConfig;
	words: Words;
	/** The place's address (`content/pages`), and its view (search, filters and sorting; null: the default). */
	place: string;
	view: string | null;
	documents: Documents;
	/** The open document's name, for a Member's back button ("Back to {page}"). */
	documentName: string;
	/** Leaves the place: back to the canvas, its selection and its panels as they were. */
	leave(): void;
	/** Opens a document on the canvas (the place closes, as opening any document does). */
	open(document: BuildingDocument): void;
	announce(text: string, urgent?: boolean): void;
	/** What the place is saving, for the Draft state beside Publish. */
	onSaving(status: "saving" | "saved" | "failed"): void;
};

/** One place: how the rail opens it, and what draws it. */
export type PlaceEntry = {
	key: PlaceKey;
	/** Its address when the rail opens it for the first time in this tab. */
	first: string;
	component: ComponentType<PlaceProps>;
};

/** The places that exist so far: the rail offers these, and says "not available yet" of the rest. */
const PLACES: Partial<Record<PlaceKey, PlaceEntry>> = {
	content: { key: "content", first: "content/pages", component: ContentPlace },
	media: { key: "media", first: "media", component: MediaPlace },
	styles: { key: "styles", first: "styles/classes", component: StylesPlace },
};

/** The place registered for a rail button, if it exists yet. */
export function placeEntry(key: PlaceKey): PlaceEntry | null {
	return PLACES[key] ?? null;
}

/** Where the rail opens a place: where it was left in this tab, else its first address. */
export function reopenPlace(key: PlaceKey): { place: string; view: string | null } | null {
	const entry = placeEntry(key);
	if (!entry) return null;
	return leftAt(key) ?? { place: entry.first, view: null };
}

/**
 * The event the Command menu (BA-10) sends on the shell's document to open a place or leave the open
 * one: `new CustomEvent("webcraft:place", { detail: { place: "content" } })`, `{ place: null }` to leave.
 */
export const PLACE_EVENT = "webcraft:place";
