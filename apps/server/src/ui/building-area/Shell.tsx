import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorFit } from "../builder/editor-fit.ts";
import { editorHistory } from "../builder/editor-history.ts";
import { matches } from "../builder/shortcuts.ts";
import { type EditAnswer, editRequests, fill, type PageState, type ShellConfig } from "./api.ts";
import { BottomBar } from "./bottom-bar/BottomBar.tsx";
import { DocumentNav } from "./bottom-bar/DocumentNav.tsx";
import { draftStateOf } from "./bottom-bar/DraftState.tsx";
import type { PageLanguage } from "./bottom-bar/LanguageMenu.tsx";
import { Frame, type FrameHandle, type PageTheme } from "./canvas/Frame.tsx";
import { NoDocument } from "./canvas/NoDocument.tsx";
import type { SavingStatus } from "./canvas/regions.ts";
import { type RegionCycle, regionCycle } from "./keyboard.ts";
import { NarrowNotice } from "./NarrowNotice.tsx";
import { useOpenDocument } from "./open-document.ts";
import { PLACE_EVENT, PLACE_KEYS, type PlaceKey, placeEntry, placeKeyOf, reopenPlace } from "./places/registry.ts";
import { Rail } from "./rail/Rail.tsx";

/**
 * The building area's shell (ADR 0037, SPEC 2 and 4): the rail on the left (48 wide; the logo tile
 * goes back to the admin), the canvas with the page in its frame, and the bottom bar (48 high). The
 * chrome is always dark; the page inside the frame follows the device, or Dark preview.
 */
/** Puts focus in the page shown in the frame, or in the place open over it (BA-20). */
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

/** What the bottom bar shows of the page in the frame. */
type ShownPage = { address: string; changes: number; inReview: boolean; languages: PageLanguage[] };

export function Shell({ config }: { config: ShellConfig }) {
	const { words } = config;
	const request = useMemo(() => editRequests(config.token), [config.token]);
	const cycle = useRef<RegionCycle | null>(null);
	const frame = useRef<FrameHandle | null>(null);
	const [message, setMessage] = useState({ text: "", urgent: false, count: 0 });
	const fit = useEditorFit();

	// The rail's switches: Dark preview starts as the page shows itself (dark where the device is, if
	// the Site has Dark mode), and sets the page's theme only once the person uses it.
	const [darkPreview, setDarkPreview] = useState(
		() => config.darkMode && window.matchMedia("(prefers-color-scheme: dark)").matches,
	);
	const [theme, setTheme] = useState<PageTheme>(null);
	const [hidden, setHidden] = useState(false);
	const [exiting, setExiting] = useState(false);

	// The page in the frame and the Draft state beside Publish.
	const [shown, setShown] = useState<ShownPage | null>(null);
	const [saving, setSaving] = useState<"idle" | "saving" | "failed">("idle");
	const shownAddress = useRef<string | null>(null);

	const announce = useCallback((text: string, urgent = false) => {
		// Alternating a trailing space makes the same words twice in a row heard twice.
		setMessage((last) => ({ text: `${text}${last.count % 2 ? " " : ""}`, urgent, count: last.count + 1 }));
	}, []);

	/** Reads what Edit mode says of the page in the frame, for the Draft state and the languages. */
	const takeState = useCallback((address: string, answer: Promise<EditAnswer<PageState>>) => {
		void answer.then((state) => {
			if (!state.ok || shownAddress.current !== address) return;
			setShown({
				address,
				changes: state.data.changes.length,
				inReview: state.data.reviews.some((review) => review.status === "inReview"),
				languages: state.data.languages,
			});
		});
	}, []);

	// The open document (BA-06): what the address names, and where the frame shows it.
	const opened = useOpenDocument(config, announce);
	const { framed } = opened;

	const onPage = useCallback(
		(address: string, answer: Promise<EditAnswer<PageState>>) => {
			shownAddress.current = address;
			setSaving("idle");
			setShown(null);
			takeState(address, answer);
			framed(address, answer);
		},
		[takeState, framed],
	);

	// The place open over the canvas (BA-20): it takes the canvas's and the docks' room; the canvas stays
	// as it was underneath (its page, selection and panels), hidden and inert until the place is left.
	const placeKey = placeKeyOf(opened.address.place);
	const place = placeKey ? placeEntry(placeKey) : null;
	const placeOpener = useRef<Element | null>(null);
	const openPlace = useCallback(
		(key: PlaceKey) => {
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
	// The Command menu's way in and out of places (it comes with BA-10): `webcraft:place` on the shell's
	// document, its detail the place to open (`{ place: "content" }`) or none to leave (`{ place: null }`).
	useEffect(() => {
		const onPlaceEvent = (event: Event) => {
			const wanted = (event as CustomEvent<{ place?: unknown } | null>).detail?.place;
			if (wanted === null) leavePlace();
			// Opening the place that is open already leaves it open (the rail's button is the toggle).
			else if (typeof wanted === "string" && wanted !== placeKey && PLACE_KEYS.includes(wanted as PlaceKey))
				openPlace(wanted as PlaceKey);
		};
		document.addEventListener(PLACE_EVENT, onPlaceEvent);
		return () => document.removeEventListener(PLACE_EVENT, onPlaceEvent);
	}, [leavePlace, openPlace, placeKey]);
	// Said as a place opens and as it is left; leaving puts focus back where it was before the place opened.
	const lastPlace = useRef<PlaceKey | null>(null);
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

	const onSaving = useCallback(
		(status: SavingStatus) => {
			setSaving(status === "saving" ? "saving" : status === "failed" ? "failed" : "idle");
			const address = shownAddress.current;
			// A save changes the page's Draft: its count of changes is read again.
			if (status === "saved" && address) {
				takeState(address, request<PageState>("state", { path: address.split("?")[0] ?? "/" }));
			}
		},
		[request, takeState],
	);

	useEffect(() => {
		const keys = regionCycle({ document, focusFrame });
		cycle.current = keys;
		const onKey = (event: KeyboardEvent) => {
			// Under the narrow-window notice nothing else can be reached.
			if (document.querySelector("[data-wc-narrow]")) return;
			if (keys.key(event)) return;
			// Undo and Redo of the shell's history, outside text fields (the page's own text keeps the browser's).
			if (typingIn(event.target)) return;
			if (matches(event, "editor.undo")) {
				event.preventDefault();
				void editorHistory().undo();
			} else if (matches(event, "editor.redo")) {
				event.preventDefault();
				void editorHistory().redo();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			cycle.current = null;
		};
	}, []);

	useEffect(() => {
		const history = editorHistory();
		history.siteId = config.site.id;
		return history.listen({ announce: (text, refused) => announce(text, refused) });
	}, [config.site.id, announce]);

	const exit = async () => {
		setExiting(true);
		announce(words.exiting);
		// Whatever was typed and not saved yet is saved before the session ends.
		await frame.current?.flush();
		const answer = await request("end", {});
		if (!answer.ok && answer.code !== "EDIT_MODE_ENDED") {
			setExiting(false);
			announce(fill(words.exitFailed, { reason: answer.code }), true);
			return;
		}
		window.location.assign(config.returnTo);
	};

	return (
		<div
			className="bg-chrome text-chrome-text grid h-dvh w-full grid-cols-[48px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_48px] overflow-hidden font-sans text-[12px]"
			data-interface={hidden ? "hidden" : "shown"}
			data-place={placeKey ?? undefined}
		>
			{/* The page itself is the main content: following the link puts focus in the frame (see <main>). */}
			<a
				href="#wc-canvas"
				className="focus:ring-chrome-focus focus:ring-offset-chrome sr-only rounded-md bg-white px-3 py-2 text-[13px] font-medium text-[#121214] focus:not-sr-only focus:fixed focus:start-14 focus:top-2 focus:z-50 focus:ring-2 focus:ring-offset-2"
			>
				{words.skipToContent}
			</a>
			<Rail
				config={config}
				place={placeKey}
				onPlace={openPlace}
				darkPreview={darkPreview}
				onDarkPreview={(on) => {
					setDarkPreview(on);
					setTheme(on ? "dark" : "light");
				}}
				hidden={hidden}
				onHidden={setHidden}
				onExit={() => void exit()}
				exiting={exiting}
			/>
			{/* Before the canvas in the Tab order, so the page (and whatever it holds) comes last; F6 still goes rail, page, bar. */}
			<BottomBar
				words={words}
				language={config.language}
				languages={place ? [] : (shown?.languages ?? [])}
				onLanguage={(language) => frame.current?.navigate(language.path)}
				nav={
					place ? null : (
						<DocumentNav words={words} back={opened.back} preview={opened.preview} renderedBy={opened.renderedBy} />
					)
				}
				insertRow={!place}
				staging={config.staging && shown ? `${config.staging}${shown.address}` : null}
				draft={draftStateOf(saving, shown)}
			/>
			<main
				id="wc-canvas"
				tabIndex={-1}
				onFocus={(event) => {
					// Reached by the skip link: focus goes on into the page, and the address keeps no fragment.
					if (event.target !== event.currentTarget) return;
					focusFrame();
					if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
				}}
				aria-label={place && placeKey ? words.places[placeKey] : words.canvas}
				data-building-region="canvas"
				className="relative col-start-2 row-start-1 min-h-0 min-w-0"
			>
				{/* While a place is open the canvas stays as it was (its page, selection and panels), hidden and inert. */}
				<div className={`contents ${place ? "invisible" : ""}`} inert={place ? true : undefined} data-wc-canvas="">
					{opened.shown?.status === "missing" || opened.shown?.status === "later" ? (
						<NoDocument words={words} why={opened.shown.status} />
					) : null}
					{opened.shown?.status === "shown" ? (
						<Frame
							address={opened.shown.frame}
							following={hidden}
							onFollow={opened.follow}
							words={words}
							request={request}
							cycle={() => cycle.current}
							announce={announce}
							breakpoints={config.breakpoints}
							theme={theme}
							handle={frame}
							onPage={onPage}
							onSaving={onSaving}
						/>
					) : null}
				</div>
				{place && opened.address.place ? (
					<place.component
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
			<div className="sr-only" data-wc-messages="">
				<p role="status" aria-live="polite" aria-atomic="true">
					{message.urgent ? "" : message.text}
				</p>
				<p role="alert" aria-live="assertive" aria-atomic="true">
					{message.urgent ? message.text : ""}
				</p>
			</div>
			<NarrowNotice covered={fit.covered} words={words} back={config.returnTo} />
		</div>
	);
}
