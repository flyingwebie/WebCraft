import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useEditorFit } from "../../builder/editor-fit.ts";
import { type EditAnswer, editRequests, fill, type PageState, type ShellConfig } from "../api.ts";
import type { PageLanguage } from "../bottom-bar/LanguageMenu.tsx";
import { Frame, type FrameHandle } from "../canvas/Frame.tsx";
import { PRESETS, type Preset } from "../canvas/gutters.ts";
import { NoDocument } from "../canvas/NoDocument.tsx";
import type { SavingStatus } from "../canvas/regions.ts";
import { LAYOUT_VERSION } from "../docks/layout.ts";
import { reverseElsewhere } from "../editing/drafts.ts";
import { pageEditing } from "../editing/editing.ts";
import { shellHistory } from "../editing/history.ts";
import { TextToolbar } from "../editing/TextToolbar.tsx";
import { type RegionCycle, regionCycle } from "../keyboard.ts";
import { managementApi } from "../management.ts";
import { NarrowNotice } from "../NarrowNotice.tsx";
import { useOpenDocument } from "../open-document.ts";
import { MediaShellHost } from "../places/media/host.tsx";
import { PlaceLoader } from "../places/PlaceLoader.tsx";
import { PLACE_EVENT, placeEntry, placeKeyOf, reopenPlace } from "../places/registry.ts";
import { Publish } from "../publish/Publish.tsx";
import { ClientBar, type ClientPanel, clientDraftStateOf } from "./ClientBar.tsx";
import { CLIENT_PLACES, type ClientPlace, ClientRail } from "./ClientRail.tsx";
import { HelpCard } from "./HelpCard.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import { LoopItems } from "./LoopItems.tsx";
import { loopItems } from "./loop-items.ts";
import { type ClientMode, clientEditing } from "./marks.ts";
import { MemberDetails } from "./PageDetails.tsx";
import { PageSwitcher } from "./PageSwitcher.tsx";
import { regionPopovers } from "./popovers.ts";
import { RegionPopover } from "./RegionPopover.tsx";
import { SidePanel } from "./SidePanel.tsx";

/** What the `state` edit request says beyond what Staff's shell reads: whether it may publish, and a Page layout. */
type ClientPageState = PageState & { page: PageState["page"] & { layout: boolean } };

/** What the bar shows of the page in the frame. */
type ShownPage = {
	address: string;
	changes: number;
	inReview: boolean;
	languages: PageLanguage[];
	/** Whether it is a Page, arranged with a Page layout (Sections, where the Site allows Members). */
	layout: boolean;
};

/** How long "Saved" shows after a save before the Draft's state says what is left to publish (SPEC 13.8). */
const SAVED_FOR_MS = 2000;

/** Puts focus in the page shown in the frame, or in the place open over it. */
function focusFrame(): void {
	const place = document.querySelector<HTMLElement>("[data-wc-place-frame]");
	if (place) {
		place.querySelector<HTMLElement>("[data-wc-place-back]")?.focus();
		return;
	}
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	if (!frame) return;
	frame.focus();
	frame.contentWindow?.focus();
}

/** Whether a key press is meant for a text field rather than the shell's shortcuts. */
function typingIn(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable || target.matches("input, textarea, select, [role='textbox']"))
	);
}

/** Whether a place is one a Member opens. */
function clientPlace(key: string | null): ClientPlace | null {
	return CLIENT_PLACES.find((each) => each === key) ?? null;
}

/**
 * The building area drawn for a Member (SPEC 13, BA-14): "the page is the interface". The rail (76,
 * words under icons: Page, Content, Media; Help, Exit), the page as a light sheet (12 from everything,
 * corners 10, no gutters: its width comes from the bar), the bar (56: Undo, Redo, the page's name, the
 * Draft's state in words; Edit / Preview and the widths; the language, Sections, Page details,
 * Publish), and one side panel at a time (360, pushing the page). Every area the Member may change is
 * marked on the page (`marks.ts`). None of the Staff's parts is drawn: no docks, panels, code panes,
 * insert row, or Templates, Styles, Loops and Components places.
 */
export function ClientShell({ config }: { config: ShellConfig }) {
	const { words } = config;
	const said = words.client;
	const request = useMemo(() => editRequests(config.token), [config.token]);
	const api = useMemo(() => managementApi(config.token), [config.token]);
	const cycle = useRef<RegionCycle | null>(null);
	const frame = useRef<FrameHandle | null>(null);
	const [message, setMessage] = useState({ text: "", urgent: false, count: 0 });
	const fit = useEditorFit();
	const panelId = useId();

	const [exiting, setExiting] = useState(false);
	const [mode, setMode] = useState<ClientMode>("edit");
	const [width, setWidth] = useState<Preset>("desktop");
	const [panel, setPanel] = useState<ClientPanel | null>(null);
	const [card, setCard] = useState<"first" | "help" | null>(config.hintSeen ? null : "first");
	const [arranging, setArranging] = useState(false);

	const [shown, setShown] = useState<ShownPage | null>(null);
	const [saving, setSaving] = useState<"idle" | "saving" | "failed">("idle");
	const [justSaved, setJustSaved] = useState(false);
	const savedTimer = useRef<number | undefined>(undefined);
	const shownAddress = useRef<string | null>(null);

	const announce = useCallback((text: string, urgent = false) => {
		// Alternating a trailing space makes the same words twice in a row heard twice.
		setMessage((last) => ({ text: `${text}${last.count % 2 ? " " : ""}`, urgent, count: last.count + 1 }));
	}, []);
	const announceRef = useRef(announce);
	announceRef.current = announce;

	// The panel's bar button gets focus back as the panel closes.
	const panelRef = useRef(panel);
	panelRef.current = panel;
	const closePanel = useCallback((focusButton = true): boolean => {
		const open = panelRef.current;
		if (!open) return false;
		setPanel(null);
		if (focusButton)
			document
				.querySelector<HTMLElement>(`[data-wc-bar="${open === "sections" ? "sections" : "page-details"}"]`)
				?.focus();
		return true;
	}, []);

	// The tab's one Undo history and Content typed in place, as for Staff (BA-07), with the client's
	// marks and keys around it.
	const undoHistory = useMemo(
		() =>
			shellHistory({
				siteId: config.site.id,
				words,
				announce: (text, urgent) => announceRef.current(text, urgent),
				fallback: async (resource) => {
					const prefix = `draft:${config.site.id}:`;
					if (!resource.startsWith(prefix)) return undefined;
					const item = resource.slice(prefix.length);
					return { reverse: (from, to) => reverseElsewhere(item, config.token, from, to) };
				},
			}),
		[config.site.id, config.token, words],
	);
	useEffect(() => () => undoHistory.destroy(), [undoHistory]);
	const refreshRef = useRef<() => void>(() => {});
	const savingRef = useRef<(status: SavingStatus) => void>(() => {});
	// The photo and link popovers (BA-15): what they change shows in the Draft's state and the page's dots.
	const popovers = useMemo(
		() =>
			regionPopovers({
				token: config.token,
				words,
				announce: (text, urgent) => announceRef.current(text, urgent),
				refresh: () => refreshRef.current(),
				saving: (status) => savingRef.current(status),
			}),
		[config.token, words],
	);
	useEffect(() => () => popovers.destroy(), [popovers]);
	// A Loop's own items and a query Loop's (BA-16): selected, moved, added, their Fields in the side panel.
	const openRef = useRef<(path: string) => void>(() => {});
	const items = useMemo(
		() =>
			loopItems({
				token: config.token,
				words,
				announce: (text, urgent) => announceRef.current(text, urgent),
				saving: (status) => savingRef.current(status),
				// One side panel at a time: the item's closes the bar's.
				panelOpened: () => setPanel(null),
				openPage: (path) => openRef.current(path),
			}),
		[config.token, words],
	);
	useEffect(() => () => items.destroy(), [items]);
	const itemsNow = useSyncExternalStore(items.subscribe, items.snapshot);
	const goTo = useCallback(() => api.builder.commandMenu({ siteId: config.site.id }), [api, config.site.id]);
	const editing = useMemo(() => {
		const inner = pageEditing({
			token: config.token,
			siteId: config.site.id,
			words,
			history: undoHistory,
			announce: (text, urgent) => announceRef.current(text, urgent),
			refresh: () => refreshRef.current(),
			failed: () => setSaving("failed"),
		});
		return items.wrap(
			clientEditing({
				inner,
				words,
				announce: (text, urgent) => announceRef.current(text, urgent),
				// Escape in the page closes the panel and leaves focus where it is, in the page.
				closePanel: () => closePanel(false),
				popovers,
			}),
		);
	}, [config.token, config.site.id, words, undoHistory, closePanel, popovers, items]);
	useEffect(() => () => editing.destroy(), [editing]);
	useEffect(() => editing.setMode(mode), [editing, mode]);

	// What Edit mode says of the page now, and what Page details calls itself on it (Post details on an Entry; BA-13).
	const [pageState, setPageState] = useState<PageState | null>(null);
	const [detailsHeading, setDetailsHeading] = useState<{ title: string; sub: string } | null>(null);

	/** Reads what Edit mode says of the page in the frame: the Draft's state, the languages, Publish. */
	const takeState = useCallback(
		(address: string, answer: Promise<EditAnswer<PageState>>) => {
			void answer.then((state) => {
				if (!state.ok || shownAddress.current !== address) return;
				const data = state.data as ClientPageState;
				editing.pageState(data);
				setPageState(data);
				setShown({
					address,
					changes: data.changes.length,
					inReview: data.reviews.some((review) => review.status === "inReview"),
					languages: data.languages,
					layout: data.page.layout === true,
				});
			});
		},
		[editing],
	);

	const opened = useOpenDocument(config, announce);
	const { framed } = opened;
	openRef.current = (path) => opened.open({ kind: "page", page: path });

	const onPage = useCallback(
		(address: string, answer: Promise<EditAnswer<PageState>>) => {
			shownAddress.current = address;
			setSaving("idle");
			// "Saved" belonged to the page before.
			setJustSaved(false);
			window.clearTimeout(savedTimer.current);
			setShown(null);
			setPageState(null);
			takeState(address, answer);
			framed(address, answer);
		},
		[takeState, framed],
	);

	/** Reads the page's `state` again: its Draft changed (a save, someone else's change, a step taken back). */
	const refreshState = useCallback(() => {
		const address = shownAddress.current;
		if (address) takeState(address, request<PageState>("state", { path: address.split("?")[0] ?? "/" }));
	}, [request, takeState]);
	refreshRef.current = refreshState;

	const onSaving = useCallback(
		(status: SavingStatus) => {
			setSaving(status === "saving" ? "saving" : status === "failed" ? "failed" : "idle");
			if (status !== "saved") return;
			// "Saved" for a moment, then what is left to publish (SPEC 13.8).
			setJustSaved(true);
			window.clearTimeout(savedTimer.current);
			savedTimer.current = window.setTimeout(() => setJustSaved(false), SAVED_FOR_MS);
			refreshState();
		},
		[refreshState],
	);
	savingRef.current = onSaving;
	useEffect(() => () => window.clearTimeout(savedTimer.current), []);

	// What Publish covers is read again whenever the page's state or a save changes (BA-12).
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new token each time either changes.
	const publishChanged = useMemo(() => ({}), [shown, saving]);

	// Whether the Site lets its Members arrange Pages: the Sections button (SPEC 13.4).
	useEffect(() => {
		let current = true;
		void api.pageLayouts
			.settings({ siteId: config.site.id })
			.then((settings) => {
				if (current) setArranging(settings.enabled);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [api, config.site.id]);

	// The place open over the canvas: only Content and Media for a Member (SPEC 13.6). An address naming
	// another place opens the canvas.
	const placeKey = clientPlace(placeKeyOf(opened.address.place));
	const place = placeKey ? placeEntry(placeKey) : null;
	const placeOpener = useRef<Element | null>(null);
	const openPlace = useCallback(
		(key: ClientPlace) => {
			if (key === placeKey) {
				opened.documents.openPlace(null);
				return;
			}
			const at = reopenPlace(key);
			if (!at) return;
			if (!placeKey) placeOpener.current = document.activeElement;
			opened.documents.openPlace(at.place, at.view);
		},
		[placeKey, opened.documents],
	);
	const leavePlace = useCallback(() => opened.documents.openPlace(null), [opened.documents]);
	// The Command menu's way in and out of places (it comes with a later part): `webcraft:place`.
	useEffect(() => {
		const onPlaceEvent = (event: Event) => {
			const wanted = (event as CustomEvent<{ place?: unknown } | null>).detail?.place;
			if (wanted === null) leavePlace();
			else if (typeof wanted === "string" && wanted !== placeKey) {
				const key = clientPlace(wanted);
				if (key) openPlace(key);
			}
		};
		document.addEventListener(PLACE_EVENT, onPlaceEvent);
		return () => document.removeEventListener(PLACE_EVENT, onPlaceEvent);
	}, [leavePlace, openPlace, placeKey]);
	const lastPlace = useRef<ClientPlace | null>(null);
	useEffect(() => {
		const was = lastPlace.current;
		lastPlace.current = placeKey;
		if (was === placeKey) return;
		if (placeKey) announce(fill(words.place.opened, { place: words.places[placeKey] }));
		else if (was) {
			announce(words.place.left);
			const opener = placeOpener.current;
			placeOpener.current = null;
			const back =
				opener instanceof HTMLElement && opener.isConnected && !opener.closest("[data-wc-place-frame]")
					? opener
					: document.querySelector<HTMLElement>(`[data-wc-place="${was}"]`);
			back?.focus();
		}
	}, [placeKey, announce, words]);

	useEffect(() => {
		const keys = regionCycle({ document, focusFrame });
		cycle.current = keys;
		const onKey = (event: KeyboardEvent) => {
			if (document.querySelector("[data-wc-narrow]")) return;
			if (keys.key(event)) return;
			if (typingIn(event.target)) return;
			if (undoHistory.key(event)) event.preventDefault();
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			cycle.current = null;
		};
	}, [undoHistory]);

	const exit = async () => {
		setExiting(true);
		announce(words.exiting);
		await frame.current?.flush();
		const answer = await request("end", {});
		if (!answer.ok && answer.code !== "EDIT_MODE_ENDED") {
			setExiting(false);
			announce(fill(words.exitFailed, { reason: answer.code }), true);
			return;
		}
		window.location.assign(config.returnTo);
	};

	/** The first-visit card is put away: it doesn't come again for this person (their editor preferences). */
	const closeCard = () => {
		const was = card;
		setCard(null);
		if (was === "help") document.querySelector<HTMLElement>('[data-wc-rail="help"]')?.focus();
		if (was !== "first") return;
		void api.me
			.saveEditorPreferences({ siteId: config.site.id, preferences: { version: LAYOUT_VERSION, hintSeen: true } })
			.catch(() => {});
	};

	const onMode = (next: ClientMode) => {
		setMode(next);
		announce(next === "preview" ? said.previewOn : said.editOn);
	};

	const pageTitle = opened.address.document?.kind === "page" ? opened.title.name : null;
	const sections = arranging && shown?.layout === true;
	const draft = clientDraftStateOf(saving, justSaved, shown);
	const panelShown = place ? null : panel === "sections" && !sections ? null : panel;
	const current = opened.address.document?.kind === "page" ? opened.address.document.page.split("?")[0] : null;

	return (
		<div
			className="bg-chrome text-chrome-text grid h-dvh w-full grid-cols-[76px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_56px] overflow-hidden font-sans text-[13px]"
			data-wc-client=""
			data-wc-mode={mode}
			data-place={placeKey ?? undefined}
		>
			<a
				href="#wc-canvas"
				className="focus:ring-chrome-focus focus:ring-offset-chrome sr-only rounded-md bg-white px-3 py-2 text-[13px] font-medium text-[#121214] focus:not-sr-only focus:fixed focus:start-24 focus:top-2 focus:z-50 focus:ring-2 focus:ring-offset-2"
			>
				{words.skipToContent}
			</a>
			<ClientRail
				config={config}
				place={placeKey}
				onPage={leavePlace}
				onPlace={openPlace}
				helpOpen={card === "help"}
				onHelp={() => setCard((was) => (was === "help" ? null : "help"))}
				onExit={() => void exit()}
				exiting={exiting}
			/>
			{/* Before the canvas in the Tab order, so the page comes last; F6 still goes rail, page, bar. */}
			<ClientBar
				words={words}
				language={config.language}
				switcher={
					<PageSwitcher
						config={config}
						name={pageTitle ?? words.documents.untitled}
						current={current ?? null}
						data={opened.switchable}
						onOpen={(path) => opened.open({ kind: "page", page: path })}
						announce={announce}
					/>
				}
				draft={draft}
				mode={mode}
				onMode={onMode}
				width={width}
				onWidth={setWidth}
				languages={shown?.languages ?? []}
				onLanguage={(language) => frame.current?.navigate(language.path)}
				sections={sections}
				panel={panelShown}
				panelId={panelId}
				onPanel={(next) => {
					// One side panel at a time: the bar's closes the item's.
					items.closePanel({ deselect: true });
					setPanel((was) => (was === next ? null : next));
				}}
				publish={
					<Publish
						config={config}
						request={request}
						path={shown ? (shown.address.split("?")[0] ?? "/") : null}
						document={opened.address.document}
						changed={publishChanged}
						size="client"
						announce={announce}
						onPublished={refreshState}
					/>
				}
				onUndo={() => void undoHistory.undo()}
				onRedo={() => void undoHistory.redo()}
				place={place !== null}
			/>
			<div
				className="relative col-start-2 row-start-1 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto]"
				data-wc-work=""
			>
				{/* The side panel before the canvas in the Tab order: the page stays the last stop. */}
				{itemsNow.selected?.panel && !place ? (
					<ItemPanel
						id={`${panelId}-item`}
						items={items}
						words={words}
						selected={itemsNow.selected}
						request={request}
						languages={shown?.languages.length ?? 1}
					/>
				) : panelShown ? (
					<SidePanel
						id={panelId}
						kind={panelShown}
						words={words}
						title={panelShown === "sections" ? said.sections : (detailsHeading?.title ?? said.pageDetails)}
						page={panelShown === "sections" ? (pageTitle ?? "") : (detailsHeading?.sub ?? pageTitle ?? "")}
						onClose={() => closePanel()}
					>
						{panelShown === "pageDetails" ? (
							// Page details, or Post details on an Entry (BA-13): a page never published follows its new slug.
							<MemberDetails
								token={config.token}
								siteId={config.site.id}
								words={words}
								request={request}
								page={pageState}
								onSaving={onSaving}
								onMoved={(path) => opened.documents.replace({ kind: "page", page: path })}
								announce={announce}
								admin={config.admin}
								onHeading={setDetailsHeading}
							/>
						) : (
							<p className="text-chrome-muted m-0 text-[13px]" data-wc-side-panel-later="">
								{fill(said.panelLater, { panel: said.sections })}
							</p>
						)}
					</SidePanel>
				) : null}
				<main
					id="wc-canvas"
					tabIndex={-1}
					onFocus={(event) => {
						if (event.target !== event.currentTarget) return;
						focusFrame();
						if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
					}}
					aria-label={place && placeKey ? words.places[placeKey] : words.canvas}
					data-building-region="canvas"
					className="relative col-start-1 row-start-1 min-h-0 min-w-0"
				>
					<div
						className={`relative h-full w-full ${place ? "invisible" : ""}`}
						inert={place ? true : undefined}
						data-wc-under-place=""
					>
						{card && !place ? (
							<HelpCard config={config} page={pageTitle} help={card === "help"} onClose={closeCard} />
						) : null}
						{opened.shown?.status === "missing" || opened.shown?.status === "later" ? (
							<NoDocument words={words} why={opened.shown.status} />
						) : null}
						{/* Before the frame in the Tab order: the page stays the last stop. */}
						{opened.shown?.status === "shown" ? <TextToolbar editing={editing} words={words} /> : null}
						{opened.shown?.status === "shown" ? <RegionPopover popovers={popovers} words={words} goTo={goTo} /> : null}
						{opened.shown?.status === "shown" ? <LoopItems items={items} words={words} /> : null}
						{opened.shown?.status === "shown" ? (
							// 12 from the rail, the panel and the bar: the frame keeps 12 left, right and below.
							<div className="absolute inset-x-0 top-3 bottom-0">
								<Frame
									address={opened.shown.frame}
									following={mode === "preview"}
									onFollow={opened.follow}
									words={words}
									request={request}
									cycle={() => cycle.current}
									announce={announce}
									breakpoints={config.breakpoints}
									theme={null}
									handle={frame}
									onPage={onPage}
									onSaving={onSaving}
									editing={editing}
									sheet={{ width: PRESETS[width] }}
								/>
							</div>
						) : null}
					</div>
					{/* Each place's code is fetched the first time it opens (BA-30): its frame shows at once meanwhile. */}
					{place && opened.address.place ? (
						<PlaceLoader
							entry={place}
							config={config}
							words={words}
							place={opened.address.place}
							view={opened.address.view ?? null}
							documents={opened.documents}
							documentName={opened.title.name}
							leave={leavePlace}
							open={opened.open}
							announce={announce}
							onSaving={(status) => setSaving(status === "saving" ? "saving" : status === "failed" ? "failed" : "idle")}
						/>
					) : null}
				</main>
			</div>
			<div className="sr-only" data-wc-messages="">
				<p role="status" aria-live="polite" aria-atomic="true">
					{message.urgent ? "" : message.text}
				</p>
				<p role="alert" aria-live="assertive" aria-atomic="true">
					{message.urgent ? message.text : ""}
				</p>
			</div>
			<NarrowNotice covered={fit.covered} words={words} back={config.returnTo} />
			<MediaShellHost config={config} />
		</div>
	);
}
