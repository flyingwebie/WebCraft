import type { PublishSource } from "@webcraft/core";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { BuildingDocument } from "../documents.ts";

export type { PublishSource };

/**
 * What the bar's Publish covers besides the page in the frame (plan BA-12): the open document when
 * it is a Template or a Component, and what the place in view has open. A place says what it has open
 * with `usePublishSources` (Styles: the Design system; Loops: the open Loop; Components: the chosen
 * one; the Content place's Globals form: the Globals), for as long as it is open.
 */

/** The id of one of the Site's own items. */
const OWN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let placeSources: readonly PublishSource[] = [];
const listeners = new Set<() => void>();

function set(next: readonly PublishSource[]): void {
	if (JSON.stringify(next) === JSON.stringify(placeSources)) return;
	placeSources = next;
	for (const listener of listeners) listener();
}

/**
 * The place in view says what it has open, which the bar's Publish then covers; none once the place
 * closes. `sources` is compared by value, so a new array each render is fine.
 */
export function usePublishSources(sources: readonly PublishSource[]): void {
	// A Module's Component has no Draft of the Site's own: only the Site's own items are named.
	const key = JSON.stringify(sources.filter((source) => !("id" in source) || OWN_ID.test(source.id)));
	useEffect(() => {
		set(JSON.parse(key) as PublishSource[]);
		return () => set([]);
	}, [key]);
}

/** What the place in view has open, as it said. */
export function usePlaceSources(): readonly PublishSource[] {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => placeSources,
		() => placeSources,
	);
}

/** The open document, as Publish names it: a Template or a Component (a page is named by its path). */
export function documentSource(document: BuildingDocument | null): PublishSource | null {
	switch (document?.kind) {
		case "siteTemplate":
			return { kind: "siteTemplate" };
		case "searchTemplate":
			return { kind: "searchTemplate" };
		case "entryTemplate":
			return { kind: "entryTemplate", postTypeId: document.postTypeId };
		case "archiveTemplate":
			return { kind: "archiveTemplate", postTypeId: document.postTypeId };
		case "component":
			return { kind: "component", id: document.componentId };
		default:
			return null;
	}
}

/**
 * The event the bar's Publish sends on the shell's document once something is published, its detail
 * the items (`{ items: PublishItem[] }`): a place that shows a status reads it again.
 */
export const PUBLISHED_EVENT = "webcraft:published";

/**
 * The event that opens Publish's sheet, as ⌘↵ does: the page's agent hands its keys to the shell, which
 * sends this on the shell's document for ⌘↵ typed in the page (`editing/editing.ts`).
 */
export const PUBLISH_OPEN_EVENT = "webcraft:publish-open";

/** Calls `then` each time the bar's Publish has published something (a place reads its statuses again). */
export function useOnPublished(then: () => void): void {
	const latest = useRef(then);
	latest.current = then;
	useEffect(() => {
		const onPublished = () => latest.current();
		document.addEventListener(PUBLISHED_EVENT, onPublished);
		return () => document.removeEventListener(PUBLISHED_EVENT, onPublished);
	}, []);
}
