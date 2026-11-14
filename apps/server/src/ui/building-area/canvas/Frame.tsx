import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AGENT_HOST_PROPERTY, type AgentHost, BUILDING_PAGE_PREFIX } from "../agent/contract.ts";
import { type EditAnswer, type EditRequests, fill, type PageState, type Words } from "../api.ts";
import type { RegionCycle } from "../keyboard.ts";
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
import { createOverlay, nameOf, type Overlay } from "./overlay.ts";
import { regionSaving, type SavingStatus } from "./regions.ts";
import { SizeReadout, useReadoutShown } from "./SizeReadout.tsx";

/** What a drop over the page tells the rest of the shell: `webcraft:drop` on the shell's document. */
export type DropDetail = { source: string; target: Element | null };

/** What the shell can ask of the frame. */
export type FrameHandle = {
	/** Opens another page of the Site in the frame (its path and query). */
	navigate(address: string): void;
	/** Saves whatever was typed and not saved yet. */
	flush(): Promise<void>;
};

/** The page's theme as the rail's Dark preview sets it: dark or light values, or the page's own choice (null). */
export type PageTheme = "dark" | "light" | null;

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
	page,
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
}: {
	/** The page the frame opens first: its path on the Site, with its query. */
	page: string;
	words: Words;
	request: EditRequests;
	cycle: () => RegionCycle | null;
	announce(text: string, urgent?: boolean): void;
	/** The Design system's breakpoints, which the size readout names. */
	breakpoints: readonly Breakpoint[];
	/** The page's theme (Dark preview), applied to every page the frame shows. */
	theme: PageTheme;
	handle: RefObject<FrameHandle | null>;
	/** A page started in the frame: its address (path and query), and what Edit mode says of it. */
	onPage(address: string, state: Promise<EditAnswer<PageState>>): void;
	/** Saving to the Draft started, ended, or failed. */
	onSaving(status: SavingStatus): void;
	/** The selection changed: the element selected in the page and its name, or nothing. */
	onSelect?(selected: { element: Element; name: string } | null): void;
}) {
	const canvas = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const overlayOf = useRef<Overlay | null>(null);
	const [focused, setFocused] = useState(false);
	// The newest of what the agent's events need, without making the frame again.
	const latest = useRef({ words, request, cycle, announce, theme, onPage, onSaving, onSelect });
	latest.current = { words, request, cycle, announce, theme, onPage, onSaving, onSelect };

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
	const layout = frameLayout(size, pane);

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
			latest.current.onSelect?.(chosen ? { element: chosen, name: nameOf(chosen, latest.current.words) } : null);
		const overlay: Overlay = {
			...drawn,
			select(chosen) {
				drawn.select(chosen);
				tellSelected(chosen);
			},
			attach(document) {
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
		});
		handle.current = {
			navigate(address) {
				element.contentWindow?.location.assign(address);
			},
			flush: () => saving.flush(),
		};
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
		const selectable = (target: EventTarget | null): Element | null => {
			const found = pageElement(target);
			return found ? (saving.regionOf(found) ?? found) : null;
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
				// The shell's address follows the page the frame shows, so a reload opens it again.
				const shown = `${BUILDING_PAGE_PREFIX}${address}`;
				if (`${location.pathname}${location.search}` !== shown) history.replaceState(history.state, "", shown);
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
			},
			event(kind, event) {
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
						return false;
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
			error() {
				// The JS pane lists them once it exists.
			},
		};
		// The shell's half goes on the frame before the frame loads anything: the agent looks for it as
		// soon as the page starts.
		(element as unknown as Record<string, unknown>)[AGENT_HOST_PROPERTY] = host;
		element.src = page;

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
			overlay.destroy();
			overlayOf.current = null;
			handle.current = null;
			delete (element as unknown as Record<string, unknown>)[AGENT_HOST_PROPERTY];
		};
	}, [page, handle]);

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
			{readoutShown && area ? (
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
				{gutter("start")}
				{gutter("end")}
				{gutter("below")}
				<div
					className={`absolute start-3 end-3 top-0 bottom-3 overflow-hidden rounded-b-md bg-white ${drag ? "[&>iframe]:pointer-events-none" : ""}`}
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
							className="pointer-events-none absolute inset-0 rounded-b-md shadow-[inset_0_0_0_2px_#818cf8]"
							data-wc-frame-focus=""
						/>
					) : null}
				</div>
			</div>
		</div>
	);
}
