import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AGENT_HOST_PROPERTY, type AgentHost, BUILDING_STAND_IN_PREFIX } from "../agent/contract.ts";
import { type EditAnswer, type EditRequests, fill, type PageState, type Words } from "../api.ts";
import type { PageEditing } from "../editing/editing.ts";
import { swapPage } from "../editing/rerender.ts";
import type { RegionCycle } from "../keyboard.ts";
import { consoleLog } from "../panels/console-log.ts";
import { installDragCatcher } from "./catcher.ts";
import { Gutter } from "./Gutter.tsx";
import {
	type Breakpoint,
	clampWidth,
	dragged,
	FRAME_MIN,
	type FrameLayout,
	type FrameSize,
	FULL_SIZE,
	frameLayout,
	type GutterSide,
	type Pane,
	paneOf,
	widestFor,
} from "./gutters.ts";
import { chipName, createOverlay, nameOf, type Overlay } from "./overlay.ts";
import { chosenRefOf, PLACED_FORM, placedFormAt, placedFormOf } from "./placed-form.ts";
import { endPreview, showPreview } from "./preview.ts";
import { answerRedraws } from "./redraw.ts";
import { regionSaving, type SavingStatus } from "./regions.ts";
import { SizeReadout, useReadoutShown } from "./SizeReadout.tsx";

/** What a drop over the page tells the rest of the shell: `webcraft:drop` on the shell's document. */
export type DropDetail = { source: string; target: Element | null };

/** What the shell can ask of the frame. */
export type FrameHandle = {
	/**
	 * Shows another page of the Site (its path and query) or a stand-in in the frame, in place of the
	 * one it shows: the shell's own history, not the frame's, has the entry (the shell's address names it).
	 */
	navigate(address: string): void;
	/** Saves whatever was typed and not saved yet. */
	flush(): Promise<void>;
	/**
	 * Draws the page again in place from the Drafts as they are now (BA-08, `editing/rerender.ts`):
	 * scroll and selection kept, none of the page's scripts run again. A stand-in loads again instead.
	 */
	rerender(): Promise<void>;
	/**
	 * Outlines the element a Structure reference names (`data-wc-code`), or nothing; brought into view.
	 * `name` is what its chip calls it instead of its element's name (a Placement: its Component's).
	 */
	select(ref: string | null, name?: string | null): void;
	/** The overlay drawn over the page now (BA-09 draws the Component edited in place on it), or null. */
	overlay(): Overlay | null;
	/**
	 * Shows the page as the server rendered it with changes not saved yet (BA-11, `canvas/preview.ts`):
	 * its body and stylesheet in place, as `rerender` does. `rerender` takes the preview away again.
	 */
	preview(page: { html: string; css: string }): void;
	/** The page's document now (the JS pane's Run adds the scripts to it), or none. */
	page(): Document | null;
};

/** The page's theme as the rail's Dark preview sets it: dark or light values, or the page's own choice (null). */
export type PageTheme = "dark" | "light" | null;

/**
 * The page's element a Structure reference names: the element itself, else, for a source (a Page's
 * Placement, `content/<id>`) or a Placement in a Template (`content#<id>`), the first element its
 * Component draws (the Placement's root).
 */
function elementOfRef(page: Document, ref: string): Element | null {
	const exact = page.querySelector(`[data-wc-code="${CSS.escape(ref)}"]`);
	if (exact) return exact;
	const source = ref.includes("#") ? ref.replace("#", "/") : ref;
	return page.querySelector(`[data-wc-code^="${CSS.escape(`${source}#`)}"]`);
}

/** How long a control's change of the frame's size eases, in milliseconds (SPEC 10). */
const RESIZE_EASE_MS = 200;

/**
 * The canvas: the page in a frame of the same origin, on the dark chrome with a 12 px grab gutter
 * left, right and below (ADR 0037, SPEC 2, 4 and 7), the overlay drawn over it, and the size readout.
 * The page agent in each page the frame shows hands its events here: a pointer over an element
 * outlines it, a click selects it (on text, the caret is already there and typing starts), typing
 * saves to the Draft. Dragging a side gutter narrows the frame symmetrically; a width wider than the
 * pane zooms the page out; double-clicking a gutter goes back to full width.
 */
export function Frame({
	address,
	following,
	onFollow,
	words,
	request,
	cycle,
	announce,
	breakpoints,
	theme,
	handle,
	onPage,
	onSaving,
	onSelect,
	onReady,
	editing,
	sheet,
}: {
	/** What the frame shows: a page's path on the Site with its query, or a stand-in's address. */
	address: string;
	/** Whether links in the page are followed (editing is off) rather than selected. */
	following: boolean;
	/** A link of the page was followed (editing is off): whether the shell opened where it goes. */
	onFollow(href: string): boolean;
	words: Words;
	request: EditRequests;
	cycle: () => RegionCycle | null;
	announce(text: string, urgent?: boolean): void;
	/** The Design system's breakpoints, which the size readout names. */
	breakpoints: readonly Breakpoint[];
	/** The page's theme (Dark preview), applied to every page the frame shows. */
	theme: PageTheme;
	handle: RefObject<FrameHandle | null>;
	/**
	 * A page started in the frame: its address (path and query, or the stand-in's), and what Edit mode
	 * says of it (a stand-in has no Edit mode state: its answer is a refusal).
	 */
	onPage(address: string, state: Promise<EditAnswer<PageState>>): void;
	/** Saving to the Draft started, ended, or failed. */
	onSaving(status: SavingStatus): void;
	/** The selection changed: the element selected in the page and its name, or nothing. */
	onSelect?(selected: { element: Element; name: string } | null): void;
	/** The page's elements are there: parsed, or drawn again in place (BA-08's Structure reads their tags). */
	onReady?(document: Document): void;
	/**
	 * Content typed in place, around the saving (BA-07, `editing/editing.ts`): the text toolbar, the
	 * Undo history's steps and keys, the page's shared Drafts and Presence. It sees the page's events first.
	 */
	editing?: PageEditing;
	/**
	 * Drawn as client editing's sheet (SPEC 13.1, BA-14) instead: no gutters and no size readout, the
	 * corners 10, and the width the bar's Desktop, Tablet or Phone gives (null: the pane's), centred.
	 */
	sheet?: { width: number | null };
}) {
	const canvas = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const overlayOf = useRef<Overlay | null>(null);
	/** The last address the shell asked the frame to show. */
	const requested = useRef<string | null>(null);
	const [focused, setFocused] = useState(false);
	// The newest of what the agent's events need, without making the frame again.
	const latest = useRef({
		words,
		request,
		cycle,
		announce,
		theme,
		onPage,
		onSaving,
		onSelect,
		onReady,
		address,
		following,
		onFollow,
		editing,
	});
	latest.current = {
		words,
		request,
		cycle,
		announce,
		theme,
		onPage,
		onSaving,
		onSelect,
		onReady,
		address,
		following,
		onFollow,
		editing,
	};

	// The frame's size: the canvas as measured, the size given, and whether the last change eases.
	const [area, setArea] = useState<{ width: number; height: number } | null>(null);
	const [size, setSize] = useState<FrameSize>(FULL_SIZE);
	const [easing, setEasing] = useState(false);
	const [drag, setDrag] = useState<{
		side: GutterSide;
		x: number;
		y: number;
		size: FrameSize;
		layout: FrameLayout;
	} | null>(null);
	const pane: Pane = paneOf(area ?? { width: 0, height: 0 });
	const layout = frameLayout(sheet ? { width: sheet.width, height: null } : size, pane);

	// The readout: under the pointer or focus, or always while the frame isn't the pane's full width.
	const [pointerIn, setPointerIn] = useState({ gutter: false, readout: false });
	const [focusIn, setFocusIn] = useState({ gutter: false, readout: false });
	const focusInside = focusIn.gutter || focusIn.readout;
	const readoutShown = useReadoutShown({
		always: area !== null && (layout.narrower || layout.zoomed),
		active: pointerIn.gutter || pointerIn.readout || focusInside || drag !== null,
		immediate: focusInside || drag !== null,
	});

	/** Draws the overlay again every frame while the frame eases to a new size. */
	const followEase = useCallback(() => {
		const until = performance.now() + RESIZE_EASE_MS + 60;
		const step = () => {
			overlayOf.current?.schedule();
			if (performance.now() < until) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}, []);

	/** A control set the size: the frame eases to it (200 ms; at once with reduced motion). */
	const setByControl = useCallback(
		(next: FrameSize) => {
			setEasing(true);
			setSize(next);
			followEase();
		},
		[followEase],
	);

	// Client editing's sheet takes its width from the bar, and eases to it as a control's change does.
	const sheetWidth = sheet ? sheet.width : undefined;
	const sheetWas = useRef(sheetWidth);
	useEffect(() => {
		if (sheetWas.current === sheetWidth) return;
		sheetWas.current = sheetWidth;
		setEasing(true);
		followEase();
	}, [sheetWidth, followEase]);

	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		const measure = () => setArea({ width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// The page's theme follows Dark preview, now and on every page the frame shows next.
	useEffect(() => {
		const root = frame.current?.contentDocument?.documentElement;
		if (root && theme) root.setAttribute("data-wc-theme", theme);
	}, [theme]);

	useEffect(() => {
		const element = frame.current;
		const area = canvas.current;
		if (!element || !area) return;
		const doc = element.ownerDocument;
		const drawn: Overlay = createOverlay({ canvas: area, frame: element, words: latest.current.words });
		/** Tells the shell what is selected (the docks' panels follow it). */
		const tellSelected = (chosen: Element | null) =>
			latest.current.onSelect?.(chosen ? { element: chosen, name: chipName(chosen, latest.current.words) } : null);
		/** What is selected now, by its Structure reference: a drawing in place selects it again, whenever it lands. */
		let chosenRef: string | null = null;
		/** What its chip calls it, when not its element's name. */
		let chosenName: string | null = null;
		const overlay: Overlay = {
			...drawn,
			select(chosen) {
				chosenRef = chosenRefOf(chosen);
				chosenName = null;
				drawn.select(chosen);
				tellSelected(chosen);
			},
			attach(document) {
				chosenRef = null;
				drawn.attach(document);
				tellSelected(null);
			},
		};
		overlayOf.current = overlay;
		const saving = regionSaving({
			request: (action, body) => latest.current.request(action, body),
			words: latest.current.words,
			announce: (text, urgent) => latest.current.announce(text, urgent),
			status: (status) => latest.current.onSaving(status),
			watch: (region) => latest.current.editing?.watch(region),
		});
		const disconnectEditing = latest.current.editing?.connect({ frame: element, overlay, saving });
		/** The page's body was drawn again in place: its regions, the Structure and the outline follow it. */
		const drawnAgain = (swapped: Document) => {
			saving.track(swapped);
			latest.current.editing?.ready(swapped);
			latest.current.onReady?.(swapped);
			drawn.hover(null);
			// What is selected by the time the page is drawn, not what was when it was asked for.
			drawn.select(chosenRef ? (placedFormAt(swapped, chosenRef) ?? elementOfRef(swapped, chosenRef)) : null);
			drawn.name(chosenName);
		};
		handle.current = {
			navigate(address) {
				// In place: a frame's own navigation would add to the window's history, which is the shell's.
				element.contentWindow?.location.replace(address);
			},
			flush: () => saving.flush(),
			async rerender() {
				const page = element.contentDocument;
				const view = element.contentWindow;
				if (!page || !view) return;
				await saving.flush();
				if (view.location.pathname.startsWith(`${BUILDING_STAND_IN_PREFIX}/`)) {
					view.location.replace(`${view.location.pathname}${view.location.search}`);
					return;
				}
				const swapped = await swapPage(element);
				if (!swapped) return;
				endPreview(element);
				drawnAgain(swapped);
			},
			preview(shown) {
				const swapped = showPreview(element, shown.html, shown.css);
				if (swapped) drawnAgain(swapped);
			},
			page: () => element.contentDocument,
			overlay: () => overlayOf.current,
			select(ref, name = null) {
				chosenRef = ref;
				chosenName = name;
				const page = element.contentDocument;
				// A placed Form by the command that placed it (BA-27), else an element by its reference.
				const found = ref && page ? (placedFormAt(page, ref) ?? elementOfRef(page, ref)) : null;
				drawn.select(found);
				drawn.name(name);
				found?.scrollIntoView({ block: "nearest", inline: "nearest" });
			},
		};
		// A place over the canvas asks for the page to be drawn again (a Class renamed in Styles).
		const stopRedraws = answerRedraws(element, () => handle.current?.rerender() ?? Promise.resolve());
		const catcher = installDragCatcher({
			document: doc,
			overlay,
			onDrop(source, target) {
				const { words: shown, announce: say } = latest.current;
				say(target ? fill(shown.droppedOn, { name: nameOf(target, shown) }) : shown.dropOutside);
				doc.dispatchEvent(new CustomEvent<DropDetail>("webcraft:drop", { detail: { source, target } }));
			},
		});
		/** Whether focus is in the page: the frame is the shell's focused element and the window has focus. */
		const checkFocus = () => setFocused(doc.activeElement === element && doc.hasFocus());

		/** An event's target as an element of the page (the page's own realm, not the shell's). */
		const pageElement = (target: EventTarget | null): Element | null => {
			const view = element.contentWindow as (Window & typeof globalThis) | null;
			return view && target instanceof view.Element ? target : null;
		};
		// A placed Form as one thing (BA-27: its fields are the Forms place's), else a region, else (for
		// Staff, whose page tags every element of a Template or Component) the element a Template or
		// Component drew, else what is under the pointer.
		const selectable = (target: EventTarget | null): Element | null => {
			const found = pageElement(target);
			return found ? (placedFormOf(found) ?? saving.regionOf(found) ?? found.closest("[data-wc-code]") ?? found) : null;
		};
		const regionOf = (target: EventTarget | null) => {
			const found = pageElement(target);
			return found ? saving.regionOf(found) : null;
		};

		const host: AgentHost = {
			attach(_agent, document, address) {
				overlay.attach(document);
				const theme = latest.current.theme;
				if (theme) document.documentElement.setAttribute("data-wc-theme", theme);
				const standIn = address.startsWith(`${BUILDING_STAND_IN_PREFIX}/`);
				latest.current.editing?.page(document, address, !standIn);
				// A stand-in is no page of the Site: Edit mode has nothing to say of it.
				if (standIn) {
					saving.track(document, Promise.resolve(null));
					latest.current.onPage(address, Promise.resolve({ ok: false, status: 404, code: "STAND_IN" }));
					return;
				}
				const path = address.split("?")[0] ?? "/";
				const state = latest.current.request<PageState>("state", { path });
				const language = state.then((answer) => {
					if (!answer.ok && answer.code === "EDIT_MODE_ENDED")
						latest.current.announce(latest.current.words.ended, true);
					return answer.ok ? (answer.data.language?.code ?? null) : null;
				});
				saving.track(document, language);
				latest.current.onPage(address, state);
			},
			ready(document) {
				overlay.attach(document);
				saving.track(document);
				latest.current.editing?.ready(document);
				latest.current.onReady?.(document);
			},
			event(kind, event) {
				// Content typed in place sees the page's events first: Undo and Redo, the toolbar's Alt+F10.
				if (latest.current.editing?.event(kind, event)) return true;
				switch (kind) {
					case "pointermove":
						overlay.hover(selectable(event.target));
						return false;
					case "pointerleave":
						overlay.hover(null);
						return false;
					case "click": {
						const target = selectable(event.target);
						if (target) overlay.select(target);
						// While editing, a click in a placed Form only chooses it: it never sends it.
						return !latest.current.following && Boolean(target?.matches(PLACED_FORM));
					}
					case "focusin": {
						const target = regionOf(event.target);
						if (target) overlay.select(target);
						checkFocus();
						return false;
					}
					case "focusout": {
						const region = regionOf(event.target);
						if (region) void saving.left(region);
						return false;
					}
					case "input": {
						const region = regionOf(event.target);
						if (region) saving.typed(region);
						overlay.schedule();
						return false;
					}
					case "scroll":
						overlay.schedule();
						return false;
					case "keydown": {
						const key = event as KeyboardEvent;
						if (latest.current.cycle()?.key(key, "canvas")) return true;
						if (key.key === "Escape" && overlay.selected()) {
							overlay.select(null);
							return false;
						}
						return false;
					}
					default:
						return false;
				}
			},
			focus() {
				checkFocus();
			},
			log(entry) {
				// The JS pane's console (BA-11), against the page that wrote it.
				const view = element.contentWindow;
				consoleLog.add(entry, view ? `${view.location.pathname}${view.location.search}` : "");
			},
			following: () => latest.current.following,
			follow: (href) => latest.current.onFollow(href),
		};
		// The shell's half goes on the frame before the frame loads anything: the agent looks for it as
		// soon as the page starts.
		(element as unknown as Record<string, unknown>)[AGENT_HOST_PROPERTY] = host;
		requested.current = latest.current.address;
		element.src = latest.current.address;

		const onFocusChange = () => queueMicrotask(checkFocus);
		doc.addEventListener("focusin", onFocusChange);
		doc.addEventListener("focusout", onFocusChange);
		window.addEventListener("blur", onFocusChange);
		window.addEventListener("focus", onFocusChange);
		return () => {
			doc.removeEventListener("focusin", onFocusChange);
			doc.removeEventListener("focusout", onFocusChange);
			window.removeEventListener("blur", onFocusChange);
			window.removeEventListener("focus", onFocusChange);
			catcher.destroy();
			stopRedraws();
			disconnectEditing?.();
			overlay.destroy();
			overlayOf.current = null;
			handle.current = null;
			delete (element as unknown as Record<string, unknown>)[AGENT_HOST_PROPERTY];
		};
	}, [handle]);

	// Another document shows in the frame: loaded in place, unless the frame shows it already (the page
	// went there itself).
	useEffect(() => {
		const view = frame.current?.contentWindow;
		if (!view || requested.current === address) return;
		requested.current = address;
		let showing: string | null = null;
		try {
			showing = `${view.location.pathname}${view.location.search}`;
		} catch {
			showing = null;
		}
		if (showing !== address) handle.current?.navigate(address);
	}, [address, handle]);

	const widest = widestFor(pane);
	const highest = Math.max(FRAME_MIN, Math.floor(pane.height / layout.scale));
	const gutter = (side: GutterSide) => (
		<Gutter
			side={side}
			layout={layout}
			widest={widest}
			highest={highest}
			dragging={drag?.side === side}
			words={words}
			onDragStart={(from, x, y) => {
				setEasing(false);
				setDrag({ side: from, x, y, size, layout });
			}}
			onDragMove={(x, y) => {
				if (!drag) return;
				const rtl = getComputedStyle(canvas.current ?? document.body).direction === "rtl";
				const delta = drag.side === "below" ? y - drag.y : x - drag.x;
				setSize(dragged(drag.side, drag.size, drag.layout, delta, pane, rtl));
			}}
			onDragEnd={() => setDrag(null)}
			onFull={(from) => setByControl(from === "below" ? { ...size, height: null } : { ...size, width: null })}
			onStep={(from, by) => {
				if (from === "below") {
					const height =
						by === "min"
							? FRAME_MIN
							: by === "max"
								? null
								: Math.min(highest, Math.max(FRAME_MIN, layout.pageHeight + by));
					setByControl({ ...size, height: height === highest ? null : height });
				} else {
					const width = by === "min" ? FRAME_MIN : by === "max" ? widest : layout.pageWidth + 2 * by;
					setByControl({ ...size, width: clampWidth(width, pane) });
				}
			}}
			onPointerInside={(inside) => setPointerIn((was) => ({ ...was, gutter: inside }))}
			onFocusInside={(inside) => setFocusIn((was) => ({ ...was, gutter: inside }))}
		/>
	);

	// Until the canvas is measured the stage simply fills it.
	const stageSize = area
		? { width: `${layout.boxWidth + 24}px`, height: `${layout.boxHeight + 12}px` }
		: { width: "100%", height: "100%" };
	const ease =
		easing && drag === null ? "transition-[width,height] duration-200 ease-out motion-reduce:transition-none" : "";

	return (
		<div ref={canvas} className="absolute inset-0 flex justify-center overflow-hidden" data-wc-canvas="">
			{readoutShown && area && !sheet ? (
				<SizeReadout
					size={size}
					layout={layout}
					pane={pane}
					breakpoints={breakpoints}
					words={words}
					onSize={setByControl}
					onPointerInside={(inside) => setPointerIn((was) => ({ ...was, readout: inside }))}
					onFocusInside={(inside) => setFocusIn((was) => ({ ...was, readout: inside }))}
				/>
			) : null}
			<div
				className={`relative shrink-0 ${ease}`}
				style={stageSize}
				data-wc-stage=""
				onTransitionEnd={(event) => {
					if (event.target === event.currentTarget) setEasing(false);
				}}
			>
				{/* The gutters before the frame in the Tab order: the page comes last. */}
				{sheet ? null : (
					<>
						{gutter("start")}
						{gutter("end")}
						{gutter("below")}
					</>
				)}
				<div
					className={`absolute start-3 end-3 top-0 bottom-3 overflow-hidden bg-white ${sheet ? "rounded-[10px]" : "rounded-b-md"} ${drag ? "[&>iframe]:pointer-events-none" : ""}`}
					data-wc-frame-box=""
				>
					<iframe
						ref={frame}
						title={words.frameTitle}
						className={`block h-full w-full origin-top-left border-0 bg-white rtl:origin-top-right ${
							easing && drag === null
								? "transition-[transform,width,height] duration-200 ease-out motion-reduce:transition-none"
								: ""
						}`}
						style={
							layout.zoomed && area
								? {
										width: `${layout.pageWidth}px`,
										height: `${layout.pageHeight}px`,
										transform: `scale(${layout.scale})`,
									}
								: undefined
						}
						data-wc-frame=""
					/>
					{/* Focus in the page: a ring drawn over the frame's edge, since the page draws its own focus inside. */}
					{focused ? (
						<div
							className={`pointer-events-none absolute inset-0 shadow-[inset_0_0_0_2px_#818cf8] ${sheet ? "rounded-[10px]" : "rounded-b-md"}`}
							data-wc-frame-focus=""
						/>
					) : null}
				</div>
			</div>
		</div>
	);
}
