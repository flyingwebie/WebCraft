import { VOID_ELEMENTS } from "@webcraft/renderer/builder";
import { useEffect, useRef, useState } from "react";
import { renderedRanges } from "./rendered-ranges.ts";

import { type DropPosition, dropPositionAt } from "./tree.ts";

/** Where the canvas document is on the admin host: an empty page that runs no script. */
const CANVAS_URL = "/api/builder/canvas";

/** How wide the canvas shows the page: as wide as there is room, a tablet's or a phone's width. */
export type CanvasWidth = "desktop" | "tablet" | "phone";

/**
 * The builder's own styles inside the canvas: placeholders for what only a page shows. Applied with
 * the Site's stylesheet as a constructed stylesheet, never as inline styles or a style element, so
 * the canvas keeps its policy.
 */
const CANVAS_CSS = `
[data-wc-builder-placeholder]{display:block;box-sizing:border-box;margin:.5rem 0;padding:1rem;border:2px dashed #a1a1aa;border-radius:.375rem;background:#f4f4f5;color:#3f3f46;font:500 14px/1.4 system-ui,sans-serif;text-align:center}
[data-wc-builder-placeholder=themeToggle],[data-wc-builder-placeholder=consentSettings]{display:inline-block;margin:0;padding:.25rem .5rem}
*{cursor:default}
[data-wc-hidden-placement]:not([data-wc-hidden-placement] *){opacity:.45}
`;

/** What the canvas outlines: an element of the tree, or a Placement (every element its Component shows). */
export type CanvasTarget = { kind: "element" | "placement" | "structural"; id: string };

type Box = { top: number; left: number; width: number; height: number };

/**
 * The canvas: the tree rendered as the Site renders it, in an iframe on the admin host that runs no
 * script (sandboxed, and its page's policy allows none), styled by the Site's Draft stylesheet. The
 * builder draws outlines, the selected element's name and drop targets over it, never into the
 * Site's HTML. Clicking selects; dragging the selected element moves it before, after or into
 * another, which the Layers panel does from the keyboard. Its content is out of the tab order: the
 * Layers panel is how the keyboard reaches every layer.
 */
export function Canvas({
	html,
	css,
	language,
	direction,
	theme,
	width,
	title,
	selected,
	selectedName,
	fixedText,
	placeholderWords,
	onSelect,
	onMove,
	onShortcut,
}: {
	html: string | null;
	css: string;
	language: string;
	direction: "ltr" | "rtl";
	theme: "light" | "dark";
	width: CanvasWidth;
	title: string;
	selected: CanvasTarget | null;
	selectedName: string | null;
	/** The ids of elements holding fixed text, outlined while shown. */
	fixedText: readonly string[];
	placeholderWords(kind: string, name: string | null): string;
	onSelect(target: CanvasTarget): void;
	onMove(from: CanvasTarget, to: CanvasTarget, position: DropPosition): void;
	/** A key pressed while the canvas has focus: the builder's shortcuts hear it too. */
	onShortcut(event: KeyboardEvent): void;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const holder = useRef<HTMLDivElement>(null);
	const [ready, setReady] = useState(false);
	const [layout, setLayout] = useState(0);
	const [boxes, setBoxes] = useState<{
		selected: Box[];
		hover: Box[];
		fixed: Box[];
		drop: { box: Box; position: DropPosition } | null;
	}>({ selected: [], hover: [], fixed: [], drop: null });
	const hover = useRef<CanvasTarget | null>(null);
	const drag = useRef<{ from: CanvasTarget; x: number; y: number; moving: boolean } | null>(null);
	const dropAt = useRef<{ to: CanvasTarget; position: DropPosition } | null>(null);
	const callbacks = useRef({ onSelect, onMove, onShortcut, selected });
	callbacks.current = { onSelect, onMove, onShortcut, selected };

	// The canvas page loads once; it may have loaded before the builder was ready to hear it.
	useEffect(() => {
		const document = frame.current?.contentDocument;
		if (document?.readyState === "complete" && document.URL.endsWith(CANVAS_URL)) setReady(true);
	}, []);

	// The rendered tree and its stylesheet, written into the canvas by the admin.
	useEffect(() => {
		const iframe = frame.current;
		const document = iframe?.contentDocument;
		const view = iframe?.contentWindow as (Window & typeof globalThis) | null | undefined;
		if (!ready || !document || !view || html === null) return;
		const root = document.documentElement;
		root.lang = language;
		root.dir = direction;
		root.setAttribute("data-wc-theme", theme);
		const sheet = new view.CSSStyleSheet();
		sheet.replaceSync(`${css}\n${CANVAS_CSS}`);
		document.adoptedStyleSheets = [sheet];
		document.body.innerHTML = html;
		// Nothing in the canvas is a tab stop: the Layers panel reaches every layer.
		for (const element of document.body.querySelectorAll<HTMLElement>(
			"a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable]",
		)) {
			element.tabIndex = -1;
		}
		for (const placeholder of document.body.querySelectorAll<HTMLElement>("[data-wc-builder-placeholder]")) {
			placeholder.textContent = placeholderWords(
				placeholder.dataset.wcBuilderPlaceholder ?? "",
				placeholder.dataset.wcBuilderName ?? null,
			);
		}
		setLayout((count) => count + 1);
	}, [ready, html, css, language, direction, theme, placeholderWords]);

	// Pointer events in the canvas: hover outlines, selecting by click, dragging the selection.
	useEffect(() => {
		const document = frame.current?.contentDocument;
		if (!ready || !document) return;
		const targetAt = (x: number, y: number, skip?: Element[]): { target: CanvasTarget; element: Element } | null => {
			for (const element of document.elementsFromPoint(x, y)) {
				const tagged = element.closest("[data-wc-code]");
				if (!skip && element !== tagged)
					for (const { ref, range } of renderedRanges(document)) {
						const target = targetOf(ref);
						if (
							target?.kind === "structural" &&
							!ref.endsWith("/0") &&
							range.intersectsNode(element) &&
							(!tagged || !range.isPointInRange(tagged, 0))
						)
							return { target, element };
					}
				if (!tagged || skip?.some((each) => each === tagged || each.contains(tagged))) continue;
				const target = targetOf(tagged.getAttribute("data-wc-code") ?? "");
				if (target) return { target, element: rootOf(document, target, tagged) };
			}
			return null;
		};
		const onClick = (event: MouseEvent) => {
			event.preventDefault();
			const found = targetAt(event.clientX, event.clientY);
			if (found) callbacks.current.onSelect(found.target);
		};
		const onPointerDown = (event: PointerEvent) => {
			const found = targetAt(event.clientX, event.clientY);
			const current = callbacks.current.selected;
			if (found && current && current.kind !== "structural" && found.target.id === current.id && event.button === 0) {
				drag.current = { from: current, x: event.clientX, y: event.clientY, moving: false };
			}
		};
		const onPointerMove = (event: PointerEvent) => {
			const dragging = drag.current;
			if (dragging) {
				if (!dragging.moving && Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 6) return;
				dragging.moving = true;
				event.preventDefault();
				const dragged = elementsOf(document, dragging.from);
				const found = targetAt(event.clientX, event.clientY, dragged);
				if (!found) {
					dropAt.current = null;
					setLayout((count) => count + 1);
					return;
				}
				const box = found.element.getBoundingClientRect();
				const y = (event.clientY - box.top) / Math.max(box.height, 1);
				// Placements and void elements (an image, a line break) hold nothing: a drop goes beside them.
				const canHold = found.target.kind === "element" && !VOID_ELEMENTS.has(found.element.tagName.toLowerCase());
				const position = dropPositionAt(y, canHold);
				dropAt.current = { to: found.target, position };
				setLayout((count) => count + 1);
				return;
			}
			const found = targetAt(event.clientX, event.clientY);
			if (found?.target.id !== hover.current?.id) {
				hover.current = found?.target ?? null;
				setLayout((count) => count + 1);
			}
		};
		const onPointerUp = () => {
			const dragging = drag.current;
			const drop = dropAt.current;
			drag.current = null;
			dropAt.current = null;
			if (dragging?.moving && drop) callbacks.current.onMove(dragging.from, drop.to, drop.position);
			setLayout((count) => count + 1);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && drag.current) {
				drag.current = null;
				dropAt.current = null;
				setLayout((count) => count + 1);
			}
		};
		// Keys pressed while the canvas has focus (after a click there) reach the builder's shortcuts.
		const onCanvasKey = (event: KeyboardEvent) => {
			onKey(event);
			callbacks.current.onShortcut(event);
		};
		const onLeave = () => {
			hover.current = null;
			setLayout((count) => count + 1);
		};
		const onScroll = () => setLayout((count) => count + 1);
		const preventSubmit = (event: Event) => event.preventDefault();
		document.addEventListener("click", onClick);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("pointermove", onPointerMove);
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("keydown", onCanvasKey);
		document.addEventListener("submit", preventSubmit);
		document.addEventListener("dragstart", preventSubmit);
		document.documentElement.addEventListener("pointerleave", onLeave);
		document.addEventListener("scroll", onScroll);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("click", onClick);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("pointermove", onPointerMove);
			document.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("keydown", onCanvasKey);
			document.removeEventListener("submit", preventSubmit);
			document.removeEventListener("dragstart", preventSubmit);
			document.documentElement.removeEventListener("pointerleave", onLeave);
			document.removeEventListener("scroll", onScroll);
			window.removeEventListener("keydown", onKey);
		};
	}, [ready]);

	// The outlines move whenever the canvas or what it shows changes size: the window and the panels,
	// the stylesheet taking effect, images and fonts arriving.
	useEffect(() => {
		const element = holder.current;
		const document = frame.current?.contentDocument;
		if (!element || typeof ResizeObserver === "undefined") return;
		const relayout = () => setLayout((count) => count + 1);
		const observer = new ResizeObserver(relayout);
		observer.observe(element);
		if (ready && document) {
			observer.observe(document.documentElement);
			observer.observe(document.body);
			document.addEventListener("load", relayout, true);
			void document.fonts?.ready.then(relayout);
		}
		return () => {
			observer.disconnect();
			document?.removeEventListener("load", relayout, true);
		};
	}, [ready]);

	// The outlines, measured after every change of what the canvas shows or where it is scrolled.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `layout` counts what moved the outlines.
	useEffect(() => {
		const iframe = frame.current;
		const document = iframe?.contentDocument;
		if (!ready || !iframe || !document) return;
		const offset = { top: iframe.offsetTop, left: iframe.offsetLeft };
		const measure = (elements: readonly (Element | Range)[]): Box[] =>
			elements.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					top: rect.top + offset.top,
					left: rect.left + offset.left,
					width: rect.width,
					height: rect.height,
				};
			});
		const drop = dropAt.current;
		const dropElement = drop ? elementsOf(document, drop.to)[0] : undefined;
		setBoxes({
			selected: selected
				? measure(
						selected.kind === "structural"
							? renderedRanges(document)
									.filter((each) => each.ref === `b#${selected.id}`)
									.map((each) => each.range)
							: elementsOf(document, selected),
					)
				: [],
			hover:
				hover.current && hover.current.id !== selected?.id
					? measure(
							hover.current.kind === "structural"
								? renderedRanges(document)
										.filter((each) => each.ref === `b#${hover.current?.id}`)
										.map((each) => each.range)
								: elementsOf(document, hover.current),
						)
					: [],
			fixed: measure(fixedText.flatMap((id) => elementsOf(document, { kind: "element", id }))),
			drop: drop && dropElement ? { box: measure([dropElement])[0] as Box, position: drop.position } : null,
		});
	}, [ready, layout, selected, fixedText]);

	const frameWidth = { desktop: "w-full", tablet: "w-[768px] max-w-full", phone: "w-[390px] max-w-full" }[width];

	return (
		<div ref={holder} className="relative flex min-h-0 flex-1 justify-center overflow-hidden">
			<iframe
				ref={frame}
				src={CANVAS_URL}
				title={title}
				sandbox="allow-same-origin"
				tabIndex={-1}
				onLoad={() => setReady(true)}
				className={`bg-background h-full border-x ${frameWidth}`}
			/>
			<div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
				{boxes.fixed.map((box) => (
					<Outline key={`fixed-${boxKey(box)}`} box={box} className="border border-dashed border-amber-500" />
				))}
				{boxes.hover.map((box) => (
					<Outline key={`hover-${boxKey(box)}`} box={box} className="border border-sky-500/70" />
				))}
				{boxes.selected.map((box, index) => (
					<Outline key={`selected-${boxKey(box)}`} box={box} className="border-primary border-2">
						{index === 0 && selectedName ? (
							<span className="bg-primary text-primary-foreground absolute start-0 -top-5 rounded-t px-1.5 text-xs leading-5 whitespace-nowrap">
								{selectedName}
							</span>
						) : null}
					</Outline>
				))}
				{boxes.drop ? <DropMark box={boxes.drop.box} position={boxes.drop.position} /> : null}
			</div>
		</div>
	);
}

/** Where an outline is, as its key: two outlines are never in the same place. */
function boxKey(box: Box): string {
	return `${box.top},${box.left},${box.width},${box.height}`;
}

/** An outline over the canvas: positioned through the CSSOM, never an inline style in markup. */
function Outline({ box, className, children }: { box: Box; className: string; children?: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const style = ref.current?.style;
		if (!style) return;
		style.top = `${box.top}px`;
		style.left = `${box.left}px`;
		style.width = `${box.width}px`;
		style.height = `${box.height}px`;
	}, [box]);
	return (
		<div ref={ref} className={`absolute rounded-sm ${className}`}>
			{children}
		</div>
	);
}

/** Where a drag drops: a line before or after an element, or a box around it. */
function DropMark({ box, position }: { box: Box; position: DropPosition }) {
	const line =
		position === "inside"
			? box
			: {
					top: position === "before" ? box.top - 2 : box.top + box.height - 1,
					left: box.left,
					width: box.width,
					height: 3,
				};
	return (
		<Outline
			box={line}
			className={position === "inside" ? "bg-primary/10 border-primary border-2 border-dashed" : "bg-primary"}
		/>
	);
}

/** The element or Placement an element of the canvas shows: `b#<id>`, or `b/<placement id>…`. */
function targetOf(code: string): CanvasTarget | null {
	if (code.startsWith("b#@")) return { kind: "structural", id: code.slice(2) };
	if (code.startsWith("b#")) return { kind: "element", id: code.slice(2) };
	if (code.startsWith("b/")) {
		const id = code.slice(2).split(/[/#]/)[0];
		return id ? { kind: "placement", id } : null;
	}
	return null;
}

/** The elements of the canvas that show a target: an element (once per Loop item), or a Placement's outermost ones. */
function elementsOf(document: Document, target: CanvasTarget): Element[] {
	if (target.kind === "element") return [...document.querySelectorAll(`[data-wc-code="b#${CSS.escape(target.id)}"]`)];
	const inside = (element: Element | null) => {
		const code = element?.getAttribute("data-wc-code") ?? "";
		return code.startsWith(`b/${target.id}#`) || code.startsWith(`b/${target.id}/`);
	};
	return [...document.querySelectorAll("[data-wc-code]")].filter(
		(element) => inside(element) && !inside(element.parentElement?.closest("[data-wc-code]") ?? null),
	);
}

/** The outermost element of the canvas showing a target, from one of its elements. */
function rootOf(document: Document, target: CanvasTarget, from: Element): Element {
	if (target.kind === "element") return from;
	return elementsOf(document, target).find((element) => element.contains(from)) ?? from;
}
