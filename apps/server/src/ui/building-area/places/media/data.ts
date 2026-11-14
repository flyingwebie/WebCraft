import { useCallback, useEffect, useRef, useState } from "react";

import type { MediaApi, MediaUse } from "../../../media/host.tsx";
import type { ListedMediaItem, MediaItem } from "../../../media/preview.ts";
import { reasonOf } from "../content/data.ts";
import { listQuery, type MediaPart, type MediaView } from "./view.ts";

export type MediaListData = Awaited<ReturnType<MediaApi["list"]>>;
export type MediaFoldersData = Awaited<ReturnType<MediaApi["folders"]["list"]>>;
export type MediaOverviewData = Awaited<ReturnType<MediaApi["overview"]>>;
export type { ListedMediaItem, MediaItem };

/** The most files the place lists at once; a search or a folder finds the rest. */
export const MEDIA_PAGE = 200;

/** What the Media place shows: the files of its part of the library, the folders, and what the library holds. */
export type MediaData = {
	list: MediaListData;
	folders: MediaFoldersData;
	overview: MediaOverviewData;
};

export type MediaState = {
	data: MediaData | null;
	failed: string | null;
	/** Reads everything again (after a change), answering once it is read. */
	reload(): Promise<void>;
};

/**
 * Reads what the Media place shows through the Management API on the Site's address: the files of the
 * part of the library it shows (searched and filtered as its view says), the folders with their
 * counts, and what the library holds. While a file shown is being processed by the worker, reads again
 * every 2 seconds for the first minute, then every 15, as the admin's Media screen does.
 */
export function useMediaData(api: MediaApi, siteId: string, part: MediaPart, view: MediaView): MediaState {
	const [data, setData] = useState<MediaData | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const alive = useRef(true);
	const query = JSON.stringify(listQuery(part, view));
	const latest = useRef(query);
	latest.current = query;

	const read = useCallback(async () => {
		const asked = query;
		try {
			const [list, folders, overview] = await Promise.all([
				api.list({ siteId, ...JSON.parse(asked), limit: MEDIA_PAGE }),
				api.folders.list({ siteId }),
				api.overview({ siteId }),
			]);
			// A read that an older view asked for never replaces what a newer one shows.
			if (!alive.current || latest.current !== asked) return;
			setData({ list, folders, overview });
			setFailed(null);
		} catch (error) {
			if (alive.current && latest.current === asked) setFailed(reasonOf(error));
		}
	}, [api, siteId, query]);

	useEffect(() => {
		alive.current = true;
		void read();
		return () => {
			alive.current = false;
		};
	}, [read]);

	const processing = data?.list.items.some((item) => item.status === "processing" || item.replacing) ?? false;
	const reread = useRef(read);
	reread.current = read;
	useEffect(() => {
		if (!processing) return;
		let looks = 0;
		let timer: ReturnType<typeof setTimeout>;
		const look = () => {
			timer = setTimeout(
				async () => {
					looks++;
					await reread.current();
					look();
				},
				looks < 30 ? 2000 : 15_000,
			);
		};
		look();
		return () => clearTimeout(timer);
	}, [processing]);

	return { data, failed, reload: read };
}

/** The file open in place: its texts in each of the Site's languages, and where it is used. */
export type OpenFile = {
	/** The file, with its texts in the Site's Default language. */
	item: MediaItem;
	/** Its texts by language (every one of the Site's languages). */
	texts: ReadonlyMap<string, { alt: string | null; title: string | null; caption: string | null }>;
	usedIn: MediaUse[];
};

/**
 * Reads the file open in place: the file in each of the Site's languages (so the language tabs know
 * which have no alt text) and where it is used. Reads again when `version` changes (after a save).
 */
export function useOpenFile(
	api: MediaApi,
	siteId: string,
	fileId: string | null,
	languages: readonly string[],
	version: unknown,
): { file: OpenFile | null; failed: string | null; reload(): Promise<void> } {
	const [file, setFile] = useState<OpenFile | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const asking = useRef(fileId);
	asking.current = fileId;
	const all = languages.join(",");

	const read = useCallback(async () => {
		if (!fileId) {
			setFile(null);
			return;
		}
		try {
			const codes = all.split(",");
			const [each, { usedIn }] = await Promise.all([
				Promise.all(codes.map((language) => api.get({ siteId, mediaId: fileId, language }))),
				api.usage({ siteId, mediaId: fileId }),
			]);
			if (asking.current !== fileId) return;
			const first = each[0]?.media;
			if (!first) return;
			const texts = new Map(
				each.map(({ media }) => [media.language, { alt: media.alt, title: media.title, caption: media.caption }]),
			);
			setFile({ item: first, texts, usedIn });
			setFailed(null);
		} catch (error) {
			if (asking.current === fileId) setFailed(reasonOf(error));
		}
	}, [api, siteId, fileId, all]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for the file again after a change.
	useEffect(() => {
		void read();
	}, [read, version]);

	return { file: file && file.item.id === fileId ? file : null, failed, reload: read };
}
