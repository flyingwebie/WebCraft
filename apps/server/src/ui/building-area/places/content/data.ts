import type { BuildingAreaApiClient } from "@webcraft/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type GoToData, managementApi, type PostTypeRow } from "../../management.ts";
import type { ListedEntry } from "./view.ts";

/** An Entry as `entries.list` answers it. */
export type EntryRow = Awaited<ReturnType<BuildingAreaApiClient["entries"]["list"]>>["entries"][number];

/** The Site's Globals as `globals.get` answers them. */
export type GlobalsData = Awaited<ReturnType<BuildingAreaApiClient["globals"]["get"]>>["globals"];

/** An Entry as the Content place lists it: what the list filters and sorts by, and the row itself. */
export type ContentEntry = ListedEntry & { id: string; row: EntryRow };

/** What the Content place shows, read through the Management API on the Site's address. */
export type ContentData = {
	/** Whether the person may change Structure (Staff): the Staff's place, else the Members'. */
	staff: boolean;
	/** The Post Types, Pages first. */
	postTypes: readonly PostTypeRow[];
	/** Each Post Type's Entries, by its id, once read. */
	entries: ReadonlyMap<string, readonly ContentEntry[]>;
	globals: GlobalsData | null;
};

/** What reading the Content place's data gives: the data (null until read), a failure, and reading again. */
export type ContentState = {
	data: ContentData | null;
	failed: string | null;
	/** Reads the Entries again (after one is made), answering the Draft addresses Go to knows. */
	reload(): Promise<ReadonlyMap<string, string>>;
	/** Takes the Globals as a save answered them. */
	setGlobals(globals: GlobalsData): void;
	/** Takes a Post Type as a save answered it (its Fields or settings changed). */
	setPostType(postType: PostTypeRow): void;
	api: BuildingAreaApiClient;
};

/** The reason a call failed, as the person reads it (its code). */
export function reasonOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/**
 * Where each Entry is on the Site: Go to's addresses (`builder.commandMenu`), which name a Draft's
 * address before it is published, for the newest Entries of each Post Type.
 */
function addressesOf(goTo: GoToData): Map<string, string> {
	const addresses = new Map<string, string>();
	for (const page of goTo.pages) addresses.set(page.id, page.path);
	for (const postType of goTo.postTypes) for (const entry of postType.entries) addresses.set(entry.id, entry.path);
	return addresses;
}

/** An Entry as the list reads it. */
function listed(row: EntryRow, addresses: ReadonlyMap<string, string>): ContentEntry {
	return {
		id: row.id,
		row,
		title: row.draft.title,
		slug: row.draft.slug,
		address: row.path ?? addresses.get(row.id) ?? "",
		status: row.status,
		inReview: row.review?.status === "inReview",
		hiddenLanguages: row.draft.hiddenLanguages,
		author: row.author?.name ?? "",
		updatedAt: new Date(row.updatedAt).getTime(),
	};
}

/**
 * Reads what the Content place shows when it opens: the person's Permissions on the Site and Go to's
 * addresses (`builder.commandMenu`), the Post Types, every Post Type's Entries and the Globals. Read
 * again each time the place opens, so a list is never staler than the place.
 */
export function useContentData(token: string, siteId: string): ContentState {
	const api = useMemo(() => managementApi(token), [token]);
	const [data, setData] = useState<ContentData | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const alive = useRef(true);

	const read = useCallback(async () => {
		const [goTo, { postTypes }, { globals }] = await Promise.all([
			api.builder.commandMenu({ siteId }),
			api.postTypes.list({ siteId }),
			api.globals.get({ siteId }),
		]);
		const addresses = addressesOf(goTo);
		const ordered = [...postTypes].sort((a, b) => Number(b.builtIn === "page") - Number(a.builtIn === "page"));
		const lists = await Promise.all(
			ordered.map(async (postType) => {
				const { entries } = await api.entries.list({ siteId, postTypeId: postType.id });
				return [postType.id, entries.map((row) => listed(row, addresses))] as const;
			}),
		);
		if (!alive.current) return addresses;
		setData({
			staff: goTo.permissions.includes("structure.edit"),
			postTypes: ordered,
			entries: new Map(lists),
			globals,
		});
		setFailed(null);
		return addresses;
	}, [api, siteId]);

	useEffect(() => {
		alive.current = true;
		read().catch((error: unknown) => {
			if (alive.current) setFailed(reasonOf(error));
		});
		return () => {
			alive.current = false;
		};
	}, [read]);

	const setGlobals = useCallback((globals: GlobalsData) => {
		setData((current) => (current ? { ...current, globals } : current));
	}, []);

	const setPostType = useCallback((postType: PostTypeRow) => {
		setData((current) =>
			current
				? { ...current, postTypes: current.postTypes.map((each) => (each.id === postType.id ? postType : each)) }
				: current,
		);
	}, []);

	return { data, failed, reload: read, setGlobals, setPostType, api };
}
