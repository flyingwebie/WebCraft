import type { Participant } from "@webcraft/core/draft-document";

import { fill, type Words } from "../api.ts";
import type { OverlayMark } from "../canvas/overlay.ts";

/**
 * Presence on the page (Co-editing, ADR 0025; SPEC 13.2 "Someone else is in it"): the region someone
 * else is in has an outline in their colour and their name on a chip, drawn by the overlay in the
 * shell's own document. Where each person is comes from the page's shared Drafts (`drafts.ts`): the
 * Draft (its item) and the value's key they are in.
 */

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
		const here = (others.get(place.item) ?? []).filter((participant) => participant.at === place.at);
		const first = here[0];
		if (!first) continue;
		const names = [...new Set(here.map((participant) => displayName(participant, words)))];
		marks.push({ kind: "person", element: region, colour: colourOf(first), name: names.join(", ") });
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
