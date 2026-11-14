import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BUILDING_STAND_IN_PREFIX } from "./agent/contract.ts";
import { type EditAnswer, fill, type ShellConfig } from "./api.ts";
import type { PreviewEntry } from "./bottom-bar/DocumentNav.tsx";
import { type DocumentTitle, documentTitle, type Switchable, titleText } from "./DocumentSwitcher.tsx";
import {
	type BuildingDocument,
	type CameFrom,
	type Documents,
	readAddress,
	type ShellAddress,
	sameDocument,
	shellDocuments,
} from "./documents.ts";
import { type GoToData, managementApi, type PostTypeRow } from "./management.ts";
import { type Shown, whereShown } from "./opening.ts";

/** What the `state` edit request says of the page itself, as far as documents read it. */
type PageOfState = {
	page: { title: string; path: string; item: string | null; layout: boolean };
	canCode: boolean;
};

/** The page the frame shows now, as Edit mode describes it. */
type FramedPage = { address: string; title: string; entryId: string | null; layout: boolean; canCode: boolean };

/** What the shell shows of the open document. */
export type OpenDocument = {
	documents: Documents;
	/** What the shell's address opens now. */
	address: ShellAddress;
	/** Where the frame shows the document; null while it is being found. */
	shown: Shown | null;
	/** What the open document is called. */
	title: DocumentTitle;
	/** What the document switcher lists; null until it is read (or for someone who may not switch). */
	switchable: Switchable | null;
	/** The bottom bar's document controls (`DocumentNav`). */
	back: { title: string; onBack(): void } | null;
	preview: { entries: readonly PreviewEntry[]; current: string | null; onChoose(entry: PreviewEntry): void } | null;
	renderedBy: { template: string; onOpen(): void } | null;
	/** Opens a document as the next one (the switcher, Go to), remembering the page it was opened from. */
	open(document: BuildingDocument): void;
	/** The frame started a page (`Frame`'s `onPage`): the document follows where the page went. */
	framed(address: string, state: Promise<EditAnswer<unknown>>): void;
	/** A link of the page was followed while editing is off: whether a document was opened for it. */
	follow(href: string): boolean;
};

/**
 * The event a part of the shell sends on the shell's document when what the framed page shows has
 * changed without the page changing (a Loop published from the Loops place): the frame reads it again.
 */
export const PAGE_CHANGED_EVENT = "webcraft:page-changed";

/**
 * The open document (plan 1.4, BA-06): read from the shell's address, found where the frame can show
 * it, kept in step with the frame (a page the frame goes to by itself becomes the document), with
 * Back, Forward and reload all through the shell's own history.
 */
export function useOpenDocument(config: ShellConfig, announce: (text: string) => void): OpenDocument {
	const { words } = config;
	const documents = useMemo(() => shellDocuments(), []);
	const api = useMemo(() => managementApi(config.token), [config.token]);
	const [address, setAddress] = useState<ShellAddress>(() => documents.current());
	const [shown, setShown] = useState<Shown | null>(null);
	const [framedPage, setFramedPage] = useState<FramedPage | null>(null);
	const [goTo, setGoTo] = useState<GoToData | null>(null);
	const [postTypes, setPostTypes] = useState<readonly PostTypeRow[]>([]);
	const [renderingType, setRenderingType] = useState<{ entryId: string; postTypeId: string } | null>(null);
	// The frame's load the shell asked for, until the frame starts it: any other load is the page's own.
	const asked = useRef<string | null>(null);
	// What the frame showed last.
	const lastFramed = useRef<string | null>(null);
	const latest = useRef({ address, shown, framedPage, announce });
	latest.current = { address, shown, framedPage, announce };

	useEffect(() => documents.subscribe((next) => setAddress(next)), [documents]);

	// Something changed what the page shows (a place published a Loop it lists): the frame reads the
	// same page again, as a load the shell asked for, so the document, the place and history stay.
	useEffect(() => {
		const onChanged = () => {
			const frame = window.document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
			if (!frame?.contentWindow || lastFramed.current === null) return;
			asked.current = lastFramed.current;
			frame.contentWindow.location.reload();
		};
		window.document.addEventListener(PAGE_CHANGED_EVENT, onChanged);
		return () => window.document.removeEventListener(PAGE_CHANGED_EVENT, onChanged);
	}, []);

	// What the switcher lists and the names of Templates and Components: Go to's data and the Post Types.
	useEffect(() => {
		let current = true;
		void api.builder
			.commandMenu({ siteId: config.site.id })
			.then((data) => {
				if (current) setGoTo(data);
			})
			.catch(() => {});
		void api.postTypes
			.list({ siteId: config.site.id })
			.then(({ postTypes: rows }) => {
				if (current) setPostTypes(rows);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [api, config.site.id]);

	// Where the frame shows the document, found again whenever the address names another one.
	const documentKey = address.document ? JSON.stringify(address.document) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: the document's printed form is what changes it.
	useEffect(() => {
		const document = address.document;
		if (!document) {
			setShown({ status: "missing" });
			return;
		}
		let current = true;
		void whereShown(api, config.site.id, document).then((found) => {
			if (!current) return;
			if (found.status === "shown") {
				// The frame loads it, unless it shows it already (and then nothing loads).
				asked.current = found.frame === lastFramed.current ? null : found.frame;
				// An Entry template previews an Entry: the address names it, so a reload shows the same one.
				if (document.kind === "entryTemplate" && document.entryId === null && found.entryId) {
					documents.replace({ ...document, entryId: found.entryId });
				}
			}
			setShown(found);
		});
		return () => {
			current = false;
		};
	}, [documentKey, api, config.site.id, documents]);

	// The Template that renders the page in the frame, for Staff ("Rendered by" on an Entry's page).
	useEffect(() => {
		const entryId = framedPage?.canCode && !framedPage.layout ? framedPage.entryId : null;
		if (!entryId || renderingType?.entryId === entryId) return;
		let current = true;
		void api.entries
			.get({ siteId: config.site.id, entryId })
			.then(({ entry }) => {
				if (current) setRenderingType({ entryId, postTypeId: entry.postTypeId });
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [framedPage, renderingType, api, config.site.id]);

	const title = documentTitle(words, address.document, {
		page: address.document?.kind === "page" ? (framedPage?.title ?? null) : null,
		postTypes,
		goTo,
	});

	/** The page the frame shows, as a place a document was opened from. */
	const cameFrom = useCallback((): CameFrom | null => {
		const { address: now, framedPage: page } = latest.current;
		return now.document?.kind === "page" && page
			? { page: page.address, title: page.title || words.documents.untitled }
			: null;
	}, [words]);

	const open = useCallback(
		(document: BuildingDocument) => {
			if (sameDocument(latest.current.address.document, document)) return;
			documents.open(document, cameFrom());
		},
		[documents, cameFrom],
	);

	const framed = useCallback(
		(frameAddress: string, state: Promise<EditAnswer<unknown>>) => {
			// A load the shell asked for (perhaps redirected on the way), or one the page made itself.
			const ours = asked.current !== null;
			asked.current = null;
			lastFramed.current = frameAddress;
			const standIn = frameAddress.startsWith(`${BUILDING_STAND_IN_PREFIX}/`);
			if (!ours && !standIn) {
				// The page went somewhere by itself (a Site script, a form): that page is the document now.
				const query = frameAddress.indexOf("?");
				const went = readAddress(
					`/_webcraft/build/page${query < 0 ? frameAddress : frameAddress.slice(0, query)}`,
					query < 0 ? "" : frameAddress.slice(query),
				);
				if (went.document?.kind === "page") documents.open(went.document, null);
			} else if (latest.current.address.document?.kind === "page" && !standIn) {
				// The page's own address (after a redirect, say) is the one the shell shows.
				if (latest.current.address.document.page !== frameAddress)
					documents.replace({ kind: "page", page: frameAddress });
			}
			setFramedPage(null);
			void state.then((answer) => {
				if (!answer.ok) return;
				const { page, canCode } = answer.data as PageOfState;
				setFramedPage({
					address: frameAddress,
					title: page.title,
					entryId: page.item?.startsWith("entry:") ? page.item.slice("entry:".length) : null,
					layout: page.layout,
					canCode,
				});
				const now = latest.current.address.document;
				if (now?.kind === "page") latest.current.announce(fill(words.documents.opened, { document: page.title }));
			});
		},
		[documents, words],
	);

	const follow = useCallback(
		(href: string) => {
			let url: URL;
			try {
				url = new URL(href, window.location.href);
			} catch {
				return false;
			}
			if (url.origin !== window.location.origin) {
				// Somewhere else: a new tab, as a visitor would see it go, never the frame.
				if (url.protocol === "https:" || url.protocol === "http:") window.open(url.toString(), "_blank", "noopener");
				return true;
			}
			const went = readAddress(`/_webcraft/build/page${url.pathname}`, url.search);
			if (went.document?.kind !== "page") return false;
			documents.open(went.document, null);
			return true;
		},
		[documents],
	);

	// Announced as each document opens (pages say their title once Edit mode has described them).
	const announced = useRef<string>("");
	useEffect(() => {
		const document = address.document;
		if (!document || document.kind === "page" || shown?.status !== "shown") return;
		const text = titleText(words, title);
		const key = `${documentKey}:${text}`;
		if (!text || announced.current === key) return;
		announced.current = key;
		announce(fill(words.documents.opened, { document: text }));
	}, [address.document, documentKey, shown, title, words, announce]);

	const document = address.document;
	const from = documents.cameFrom();
	const back = from && document?.kind !== "page" ? { title: from.title, onBack: () => documents.back() } : null;

	let preview: OpenDocument["preview"] = null;
	if (document?.kind === "entryTemplate") {
		const postType = postTypes.find((each) => each.id === document.postTypeId);
		const entries =
			postType?.builtIn === "page"
				? (goTo?.pages ?? [])
				: (goTo?.postTypes.find((each) => each.id === document.postTypeId)?.entries ?? []);
		preview = {
			entries,
			current: document.entryId ?? (shown?.status === "shown" ? shown.entryId : null),
			onChoose: (entry) => documents.replace({ ...document, entryId: entry.id }),
		};
	}

	let renderedBy: OpenDocument["renderedBy"] = null;
	if (
		document?.kind === "page" &&
		framedPage?.canCode &&
		framedPage.entryId &&
		renderingType?.entryId === framedPage.entryId
	) {
		const { postTypeId } = renderingType;
		const entryId = framedPage.entryId;
		const name = postTypes.find((each) => each.id === postTypeId)?.name ?? "";
		renderedBy = {
			template: fill(words.documents.titled, { name, kind: words.documents.entryTemplate }),
			onOpen: () => open({ kind: "entryTemplate", postTypeId, entryId }),
		};
	}

	return {
		documents,
		address,
		shown,
		title,
		switchable: goTo ? { goTo, postTypes } : null,
		back,
		preview,
		renderedBy,
		open,
		framed,
		follow,
	};
}
