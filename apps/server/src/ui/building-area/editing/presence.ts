import type { Participant } from "@webcraft/core/draft-document";

import { LINK_REGION, PHOTO_REGION, TEXT_REGION } from "../agent/contract.ts";
import { fill, type Words } from "../api.ts";
import type { OverlayMark } from "../canvas/overlay.ts";

/**
 * Presence on the page (Co-editing, ADR 0025; SPEC 13.2 "Someone else is in it"): the region someone
 * else is in has an outline in their colour and their name on a chip, drawn by the overlay in the
 * shell's own document. Where each person is comes from the page's shared Drafts (`drafts.ts`): the
 * Draft (its item) and the value's key they are in.
 */

/**
 * What on the page holds a value someone can be in (Presence, and where a step of the Undo history
 * was made): typed text, a photo and a link (BA-35).
 */
export const VALUE_REGION = `${TEXT_REGION}, ${PHOTO_REGION}, ${LINK_REGION}`;

/** The colours people get (as the admin's and the editing bar's), each with white text that reads on it. */
export const PRESENCE_COLOURS = [
	"#0369a1",
	"#6d28d9",
	"#047857",
	"#b45309",
	"#be123c",
	"#0e7490",
	"#a21caf",
	"#4d7c0f",
] as const;

/** A participant's colour: the same for a person everywhere. */
export function colourOf(participant: Participant): string {
	return PRESENCE_COLOURS[participant.colour % PRESENCE_COLOURS.length] ?? PRESENCE_COLOURS[0];
}

/** A participant's name as people read it: the person, and the client they came through. */
export function displayName(participant: Participant, words: Words): string {
	const said = words.editing;
	const name = participant.name || said.someone;
	if (participant.translation) return fill(said.viaTranslation, { name });
	return participant.via ? fill(said.via, { name, client: participant.via }) : name;
}

/** Where a region is, for Presence: its item's Draft and its Field's key. A Loop item's regions have none here. */
export function regionPlace(region: Element): { item: string; at: string } | null {
	const item = region.getAttribute("data-wc-item") ?? "";
	if (item !== "globals" && !item.startsWith("entry:")) return null;
	return { item, at: (region.getAttribute("data-wc-field") ?? "").split(".")[0] ?? "" };
}

/**
 * The marks for everyone else in the page's Drafts: on each region someone is in, an outline in the
 * first one's colour and every name there on its chip (one name per person, however many tabs).
 */
export function presenceMarks(
	others: ReadonlyMap<string, readonly Participant[]>,
	regions: readonly Element[],
	words: Words,
): OverlayMark[] {
	const marks: OverlayMark[] = [];
	for (const region of regions) {
		const place = regionPlace(region);
		if (!place) continue;
		const found = peopleAt(others, place.item, place.at, words);
		if (found) marks.push({ kind: "person", element: region, ...found });
	}
	return marks;
}

/** The people in the page's Drafts, once each, by who they are (a person, through a client). */
export function peopleIn(others: ReadonlyMap<string, readonly Participant[]>): Map<string, Participant> {
	const people = new Map<string, Participant>();
	for (const participants of others.values()) {
		for (const participant of participants) {
			const key = `${participant.personId ?? participant.id}:${participant.via ?? ""}:${participant.translation ?? false}`;
			if (!people.has(key)) people.set(key, participant);
		}
	}
	return people;
}

/**
 * Presence on what isn't typed in (BA-35): the photo or link whose popover is open, the Loop item
 * selected. Each part claims the place it puts the person in; the last claim holds, and only the part
 * holding it says "nowhere" again. Typed text says where the person is itself (`editing.ts`), over any
 * claim, while it is edited: `quiet` drops a claim without saying anything then.
 */
const claims = new WeakMap<object, { owner: object | null }>();

export function claimPlace(
	editing: { drafts(): object; place(item: string | null, at: string | null): void },
	owner: object,
	place: { item: string; at: string } | null,
	quiet = false,
): void {
	const key = editing.drafts();
	const held = claims.get(key) ?? { owner: null };
	claims.set(key, held);
	if (place) {
		held.owner = owner;
		editing.place(place.item, place.at);
		return;
	}
	if (held.owner !== owner) return;
	held.owner = null;
	if (!quiet) editing.place(null, null);
}

/**
 * The Draft presence on a Loop's items goes through (the editing bar's way): the page's own Entry's,
 * else the Globals'. A Loop's item is named by its key there (`loop:<loop id>:<item id>`).
 */
export function itemPresenceDraft(pageItem: string | null): string {
	return pageItem?.startsWith("entry:") ? pageItem : "globals";
}

/** Who else is at `at` in an item's Draft: the first one's colour and every name (once per person). */
export function peopleAt(
	others: ReadonlyMap<string, readonly Participant[]>,
	item: string,
	at: string,
	words: Words,
): { colour: string; name: string } | null {
	const here = (others.get(item) ?? []).filter((participant) => participant.at === at);
	const first = here[0];
	if (!first) return null;
	return {
		colour: colourOf(first),
		name: [...new Set(here.map((participant) => displayName(participant, words)))].join(", "),
	};
}
