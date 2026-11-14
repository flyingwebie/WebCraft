import type { DocumentPublish, PublishChange, PublishDraft } from "@webcraft/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { type EditRequests, fill, type Words } from "../api.ts";
import type { PublishSource } from "./sources.ts";

/** A date as JSON carries it. */
type Dated<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

/** What `publish/items` answers (`@webcraft/core` › `DocumentPublish`), its dates as JSON writes them. */
export type PublishData = Omit<DocumentPublish, "changes" | "drafts" | "reviews"> & {
	changes: Dated<PublishChange>[];
	drafts: Dated<PublishDraft>[];
	reviews: (Omit<DocumentPublish["reviews"][number], "at"> & { at: string })[];
};

export type ChangeRow = PublishData["changes"][number];
export type DraftRow = PublishData["drafts"][number];
export type PublishItem = PublishData["items"][number];

/** How long Publish waits after the last change before it reads what it covers again. */
const READ_DELAY_MS = 300;

/**
 * What the bar's Publish covers (`publish/items`): read for the page in the frame (`path`, null when it
 * shows none) and the `sources` the shell names, and read again `READ_DELAY_MS` after `changed` changes
 * (a save, a step taken back, the page's state read again) and whenever `read()` is called.
 */
export function usePublishData(
	request: EditRequests,
	path: string | null,
	sources: readonly PublishSource[],
	changed: unknown,
) {
	const [data, setData] = useState<PublishData | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const asked = useRef(0);
	const key = JSON.stringify({ path, sources });

	const read = useCallback(async (): Promise<PublishData | null> => {
		const ask = ++asked.current;
		const { path: page, sources: named } = JSON.parse(key) as { path: string | null; sources: PublishSource[] };
		const answer = await request<PublishData>("publish/items", { path: page, sources: named });
		if (ask !== asked.current) return null;
		if (!answer.ok) {
			setFailed(answer.code);
			return null;
		}
		setFailed(null);
		setData(answer.data);
		return answer.data;
	}, [request, key]);

	// Another page or other sources: what was read for the last ones is not shown meanwhile.
	// biome-ignore lint/correctness/useExhaustiveDependencies: cleared when what is asked about changes.
	useEffect(() => {
		setData(null);
	}, [key]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is what asks for a new read.
	useEffect(() => {
		const timer = setTimeout(() => void read(), READ_DELAY_MS);
		return () => clearTimeout(timer);
	}, [read, changed]);

	return { data, failed, read };
}

/** How many rows Publish publishes: the page's changes and the whole items the person may publish. */
export function countOf(data: PublishData | null): number {
	if (!data) return 0;
	const changes = data.changes.filter((change) => !change.structure || data.canCode).length;
	return changes + data.drafts.filter((draft) => draft.canPublish).length;
}

/** "4 min ago", "yesterday": when something changed, in the person's language. */
export function whenText(at: string | null, words: Words, language: string, now = Date.now()): string {
	if (!at) return "";
	const seconds = Math.round((new Date(at).getTime() - now) / 1000);
	if (Math.abs(seconds) < 60) return words.publishing.justNow;
	const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

/** Who changed something and when: "you · 4 min ago". */
export function whoText(
	by: { name: string; you: boolean } | null,
	at: string | null,
	words: Words,
	language: string,
): string {
	const when = whenText(at, words, language);
	const shown = words.publishing;
	if (!by) return fill(shown.byNobody, { when });
	return by.you ? fill(shown.byYou, { when }) : fill(shown.byName, { name: by.name, when });
}

/** What a page's change is called and what happened to it: "Intro: words changed". */
export function changeText(change: ChangeRow, words: Words): string {
	const shown = words.publishing;
	const builtIn = shown.builtIn as Record<string, string>;
	const name = change.key === "layout" ? builtIn.layout : (change.label ?? builtIn[change.key] ?? change.key);
	const what =
		change.type === "media"
			? shown.what.replaced
			: change.type === "loopItems"
				? shown.what.items
				: change.type === "pageLayout"
					? shown.what.layout
					: change.type === "text" || change.type === "richText" || change.type === "textarea"
						? shown.what.words
						: shown.what.changed;
	return fill(shown.change, { name: name ?? change.key, what });
}

/** What a whole item is called: "Entry template · Blog posts", "Component · Badge". */
export function draftName(draft: DraftRow, words: Words, member: boolean): string {
	const kinds = words.publishing.kinds;
	const name = draft.name ?? "";
	const postType = draft.postType?.name ?? "";
	switch (draft.item.kind) {
		case "template":
			if (draft.templateKind === "site") return kinds.siteTemplate;
			if (draft.templateKind === "search") return kinds.searchTemplate;
			if (draft.templateKind === "entry") return fill(kinds.entryTemplate, { postType });
			if (draft.templateKind === "archive") return fill(kinds.archiveTemplate, { postType });
			return kinds.template;
		case "component":
			return fill(kinds.component, { name });
		case "loop":
			return fill(kinds.loop, { name });
		case "script":
			return draft.scriptKind === "page" ? fill(kinds.pageScript, { name }) : kinds.siteScript;
		case "designSystem":
			return kinds.designSystem;
		case "globals":
			return member ? kinds.globalsForMembers : kinds.globals;
		default:
			return fill(kinds.other, { name: name || draft.item.kind });
	}
}

/** Why a publish (or a schedule) was refused, in the person's words. */
export function refusalText(error: unknown, words: Words): string {
	const reasons = words.publishing.reasons;
	const code = (error as { code?: unknown } | null)?.code;
	switch (code) {
		case undefined:
		case null:
			return reasons.network;
		case "FORBIDDEN":
			return reasons.forbidden;
		case "CONFIRMATION_INVALID":
		case "PUBLISH_ALL_INVALID":
			return reasons.changed;
		case "ALREADY_SCHEDULED":
			return reasons.scheduledAlready;
		case "PUBLISH_ALL_REFUSED": {
			const name = (error as { data?: { name?: unknown } }).data?.name;
			return fill(reasons.refused, { name: typeof name === "string" ? name : "" });
		}
		default:
			return fill(reasons.generic, { code: String(code) });
	}
}
