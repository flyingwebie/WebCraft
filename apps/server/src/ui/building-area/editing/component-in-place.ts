import type { Overlay } from "../canvas/overlay.ts";

/**
 * A Component edited in place (BA-09; SPEC 5, `builder/06`): "Edit Component" on a Placement keeps the
 * page where it is and opens the Placement's Component for editing there. Its elements are selected,
 * changed and moved as any Template's, saving to the Component's Draft; the rest of the page is dimmed
 * (drawn over by the shell, never by the Site's CSS) and locked (inert, so it takes no pointer, focus
 * or typing), the Component panel opens in the left dock and "Done" in the bar ends it, back on the
 * page with the Placement selected. The Draft keeps every change: Done loses nothing.
 */
export type InPlaceTarget = {
	/** The Component's source on the page: `content/<placement id>` (a Page's, or a Template's Placement). */
	source: string;
	componentId: string;
	/** The Component's name, as the panel and the label over it say it. */
	name: string;
	/** What Done selects: the Placement (`content/<id>` on a Page, `<source>#<id>` in a Template). */
	placement: string;
};

export type ComponentInPlace = {
	start(target: InPlaceTarget): void;
	/** Ends editing in place: answers what was edited (Done selects its Placement), or null. */
	done(): InPlaceTarget | null;
	current(): InPlaceTarget | null;
	subscribe(listener: () => void): () => void;
	/** The frame shows this page now (loaded, or drawn again) and its overlay: the lock and the dimming follow. */
	page(document: Document | null, overlay: Overlay | null): void;
	destroy(): void;
};

/** How much of the rest of the page shows through (`builder/06` draws it at 40 %). */
const SHOWN = 0.4;

/** The elements a source draws at its top: those whose reference is the source's, inside no other of its own. */
export function rootsOf(document: Document, source: string): Element[] {
	const prefix = `${source}#`;
	const mine = (element: Element | null) => element?.getAttribute("data-wc-code")?.startsWith(prefix) ?? false;
	return [...document.querySelectorAll(`[data-wc-code^="${CSS.escape(prefix)}"]`)].filter(
		(element) => !mine(element.parentElement?.closest("[data-wc-code]") ?? null),
	);
}

/** The page's own background, as the colour the dimming draws in: so the rest reads as faded, not darkened. */
function backgroundOf(document: Document): string {
	const view = document.defaultView;
	for (const element of [document.body, document.documentElement]) {
		if (!element || !view) continue;
		const colour = view.getComputedStyle(element).backgroundColor;
		const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(colour);
		if (match && (match[4] === undefined || Number(match[4]) > 0))
			return `rgb(${match[1]} ${match[2]} ${match[3]} / ${1 - SHOWN})`;
	}
	return `rgb(255 255 255 / ${1 - SHOWN})`;
}

export function componentInPlace(options: {
	/** The label over the Component while it is edited ("SECTION 1 · EDITING"). */
	words: { editing(name: string): string };
}): ComponentInPlace {
	const listeners = new Set<() => void>();
	let target: InPlaceTarget | null = null;
	let document: Document | null = null;
	let overlay: Overlay | null = null;
	/** The page's elements made inert for the lock, to give back. */
	let locked: Element[] = [];
	let stopDrawing: (() => void) | null = null;
	let dim: HTMLElement | null = null;

	const tell = () => {
		for (const listener of listeners) listener();
	};

	const unlock = () => {
		for (const element of locked) element.removeAttribute("inert");
		locked = [];
		stopDrawing?.();
		stopDrawing = null;
		dim?.remove();
		dim = null;
	};

	/** Everything on the page but the Component's elements and the elements around them is inert. */
	const lock = () => {
		unlock();
		if (!target || !document?.body) return;
		const roots = rootsOf(document, target.source);
		if (roots.length === 0) return;
		const around = new Set<Element>();
		for (const root of roots) {
			for (let at = root.parentElement; at; at = at.parentElement) around.add(at);
		}
		for (const keep of around) {
			for (const child of keep.children) {
				if (around.has(child) || roots.includes(child) || child.hasAttribute("inert")) continue;
				if (child.localName === "script" || child.localName === "style" || child.localName === "link") continue;
				child.setAttribute("inert", "");
				locked.push(child);
			}
		}
		draw(roots);
	};

	/** The dimming: four boxes around the Component's elements, and its name over them, in the overlay's layer. */
	const draw = (roots: Element[]) => {
		const layer = overlay ? globalThis.document.querySelector<HTMLElement>("[data-wc-overlay]") : null;
		if (!overlay || !layer || !document) return;
		const shell = globalThis.document;
		dim = shell.createElement("div");
		dim.className = "absolute inset-0";
		dim.dataset.wcInPlace = "";
		const colour = backgroundOf(document);
		const parts = [0, 1, 2, 3].map(() => {
			const part = shell.createElement("div");
			part.className = "absolute";
			part.style.setProperty("background", colour);
			dim?.append(part);
			return part;
		});
		const label = shell.createElement("div");
		label.className =
			"absolute -translate-x-1/2 text-[11px] leading-[16px] font-semibold tracking-[0.06em] whitespace-nowrap text-[#71717a] uppercase";
		label.textContent = options.words.editing(target?.name ?? "");
		label.dataset.wcInPlaceLabel = "";
		dim.append(label);
		layer.prepend(dim);
		const place = () => {
			const area = layer.getBoundingClientRect();
			const boxes = roots.flatMap((root) => {
				const box = root.isConnected ? overlay?.boxOf(root) : null;
				return box ? [box] : [];
			});
			if (boxes.length === 0) {
				for (const part of parts) part.style.setProperty("display", "none");
				label.style.setProperty("display", "none");
				return;
			}
			const left = Math.min(...boxes.map((box) => box.left)) - area.left;
			const top = Math.min(...boxes.map((box) => box.top)) - area.top;
			const right = Math.max(...boxes.map((box) => box.right)) - area.left;
			const bottom = Math.max(...boxes.map((box) => box.bottom)) - area.top;
			const set = (part: HTMLElement | undefined, x: number, y: number, width: number, height: number) => {
				if (!part) return;
				part.style.removeProperty("display");
				part.style.setProperty("left", `${x}px`);
				part.style.setProperty("top", `${y}px`);
				part.style.setProperty("width", `${Math.max(0, width)}px`);
				part.style.setProperty("height", `${Math.max(0, height)}px`);
			};
			const [above, below, before, after] = parts;
			set(above, 0, 0, area.width, top);
			set(below, 0, bottom, area.width, area.height - bottom);
			set(before, 0, top, left, bottom - top);
			set(after, right, top, area.width - right, bottom - top);
			label.style.removeProperty("display");
			label.style.setProperty("left", `${(left + right) / 2}px`);
			label.style.setProperty("top", `${Math.max(0, top - 24)}px`);
		};
		place();
		stopDrawing = overlay.onDraw(place);
	};

	return {
		start(next) {
			target = next;
			lock();
			rootsOf(document ?? globalThis.document, next.source)[0]?.scrollIntoView({ block: "nearest" });
			tell();
		},
		done() {
			const was = target;
			target = null;
			unlock();
			if (was) tell();
			return was;
		},
		current: () => target,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		page(next, drawn) {
			document = next;
			overlay = drawn;
			lock();
		},
		destroy() {
			unlock();
			listeners.clear();
		},
	};
}
