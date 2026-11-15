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

/** How long leaving a document waits for what was typed to be saved before it goes anyway, in milliseconds. */
const LEAVE_WAIT_MS = 4000;

/**
 * The open document (plan 1.4, BA-06): read from the shell's address, found where the frame can show
 * it, kept in step with the frame (a page the frame goes to by itself becomes the document), with
 * Back, Forward and reload all through the shell's own history.
 *
 * Before the shell opens another document (the switcher, Go to, "Back to {page}", "Rendered by", a
 * link followed, another Entry in the picker), `leaving` saves what was typed and not saved yet (the
 * page's regions, the code panes), as the old Builder did on its way out (BA-34). What can't be saved
 * (markup that can't be read, a conflict waiting) stays where it was typed: the panes keep it for when
 * the document shows again, and each document remembers its selection (`documents.ts`).
 */
export function useOpenDocument(
	config: ShellConfig,
	announce: (text: string) => void,
	leaving: () => Promise<void> = async () => {},
): OpenDocument {
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
	// Back or Forward went to another document: the browser puts the frame back where it was then by
	// itself (its place in the history goes with the shell's), before the shell has found where the
	// document shows. That load is the shell's own, not the page going somewhere (BA-34).
	const popped = useRef(false);
	const latest = useRef({ address, shown, framedPage, announce, leaving });
	latest.current = { address, shown, framedPage, announce, leaving };

	/** Saves what can be saved, then goes: never waiting more than `LEAVE_WAIT_MS`, never stopped by a failure. */
	const leave = useCallback((then: () => void) => {
		const saved = latest.current.leaving().catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waited = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, LEAVE_WAIT_MS);
		});
		void Promise.race([saved, waited]).then(() => {
			clearTimeout(timer);
			then();
		});
	}, []);

	useEffect(
		() =>
			documents.subscribe((next, change) => {
				if (change === "pop") popped.current = true;
				setAddress(next);
			}),
		[documents],
	);

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
		// A Form opens in the Forms place (BA-27), over the home page: the address says so from now on.
		if (document.kind === "form") {
			documents.replace({ kind: "page", page: "/" }, `forms/${document.formId}`);
			return;
		}
		let current = true;
		void whereShown(api, config.site.id, document).then((found) => {
			if (!current) return;
			if (found.status === "shown") {
				// The frame loads it, unless it shows it already (and then nothing loads).
				asked.current = found.frame === lastFramed.current ? null : found.frame;
				// Shown already (put back by Back or Forward): nothing is left to load for it.
				if (asked.current === null) popped.current = false;
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
			const from = cameFrom();
			leave(() => documents.open(document, from));
		},
		[documents, cameFrom, leave],
	);

	const framed = useCallback(
		(frameAddress: string, state: Promise<EditAnswer<unknown>>) => {
			// A load the shell asked for (perhaps redirected on the way), or one the page made itself. The
			// page the open document is shown on, loaded again (by a redraw, the browser's own Back), is
			// never the page going somewhere by itself (BA-34).
			const now = latest.current.shown;
			const ours = asked.current !== null || popped.current || (now?.status === "shown" && now.frame === frameAddress);
			popped.current = false;
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
			const document = went.document;
			if (document?.kind !== "page") return false;
			leave(() => documents.open(document, null));
			return true;
		},
		[documents, leave],
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
	const back =
		from && document?.kind !== "page" ? { title: from.title, onBack: () => leave(() => documents.back()) } : null;

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
			onChoose: (entry) => leave(() => documents.replace({ ...document, entryId: entry.id })),
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
