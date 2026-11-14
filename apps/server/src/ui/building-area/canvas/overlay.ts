import { TEXT_REGION } from "../agent/contract.ts";
import type { Words } from "../api.ts";

/**
 * The overlay over the building area's frame (ADR 0037): outlines and the selected element's chip,
 * drawn in the shell's own document so the Site's CSS never reaches them. It reads the rectangles of
 * the frame's elements directly (same origin), maps them through the frame's offset and zoom, and
 * draws again whenever the frame scrolls, resizes, changes or moves.
 */
export type Overlay = {
	/** The element under the pointer (dashed outline), or null. */
	hover(element: Element | null): void;
	/** The selected element (solid outline and the name-and-size chip), or null. */
	select(element: Element | null): void;
	selected(): Element | null;
	/** Watches a page the frame now shows: its scrolling, size and changes move the outlines. */
	attach(document: Document): void;
	/** The frame's element at a point of the shell's window, or null outside the frame. */
	elementAt(clientX: number, clientY: number): Element | null;
	/** Draws again on the next frame (coalesced). */
	schedule(): void;
	/** Stops watching and removes what it drew. */
	destroy(): void;
};

/** Where the frame is on the shell's window, and its zoom (its drawn width over its own width). */
export type FrameGeometry = { left: number; top: number; width: number; height: number; scale: number };

/** The frame's place on the shell's window and its zoom, read from the DOM as it is now. */
export function frameGeometry(frame: HTMLIFrameElement): FrameGeometry {
	const box = frame.getBoundingClientRect();
	const own = frame.offsetWidth;
	return { left: box.left, top: box.top, width: box.width, height: box.height, scale: own > 0 ? box.width / own : 1 };
}

const CHIP_HEIGHT = 18;

export function createOverlay(options: {
	/** The element the overlay draws in: it covers the canvas and clips to it. */
	canvas: HTMLElement;
	frame: HTMLIFrameElement;
	words: Words;
}): Overlay {
	const { canvas, frame, words } = options;
	const doc = canvas.ownerDocument;
	const view = doc.defaultView ?? window;

	const layer = doc.createElement("div");
	layer.className = "pointer-events-none fixed overflow-hidden";
	layer.dataset.wcOverlay = "";
	layer.setAttribute("aria-hidden", "true");
	const hoverBox = doc.createElement("div");
	hoverBox.className = "absolute box-border hidden border border-dashed border-[#6366f1]";
	hoverBox.dataset.wcOutline = "hover";
	const selectedBox = doc.createElement("div");
	selectedBox.className = "absolute box-border hidden border border-solid border-[#6366f1]";
	selectedBox.dataset.wcOutline = "selected";
	const chip = doc.createElement("div");
	chip.className =
		"absolute hidden whitespace-nowrap rounded-t-[3px] bg-[#4f46e5] px-1.5 font-mono text-[11px] leading-[18px] font-semibold text-white";
	chip.dataset.wcChip = "";
	layer.append(hoverBox, selectedBox, chip);
	canvas.append(layer);

	let hovered: Element | null = null;
	let chosen: Element | null = null;
	let pending = 0;
	const cleanups: (() => void)[] = [];
	let pageCleanups: (() => void)[] = [];

	const place = (box: HTMLElement, element: Element | null, geometry: FrameGeometry, clip: DOMRect) => {
		if (!element?.isConnected) {
			box.classList.add("hidden");
			return null;
		}
		const rect = element.getBoundingClientRect();
		const left = geometry.left - clip.left + rect.left * geometry.scale;
		const top = geometry.top - clip.top + rect.top * geometry.scale;
		const width = rect.width * geometry.scale;
		const height = rect.height * geometry.scale;
		box.style.setProperty("left", `${left}px`);
		box.style.setProperty("top", `${top}px`);
		box.style.setProperty("width", `${width}px`);
		box.style.setProperty("height", `${height}px`);
		box.classList.remove("hidden");
		return { left, top, width, height, rect };
	};

	const draw = () => {
		pending = 0;
		const geometry = frameGeometry(frame);
		const canvasBox = canvas.getBoundingClientRect();
		// What shows of the frame: the frame itself, cut to the canvas it sits in.
		const left = Math.max(geometry.left, canvasBox.left);
		const top = Math.max(geometry.top, canvasBox.top);
		const right = Math.min(geometry.left + geometry.width, canvasBox.right);
		const bottom = Math.min(geometry.top + geometry.height, canvasBox.bottom);
		const clip = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
		layer.style.setProperty("left", `${clip.left}px`);
		layer.style.setProperty("top", `${clip.top}px`);
		layer.style.setProperty("width", `${clip.width}px`);
		layer.style.setProperty("height", `${clip.height}px`);
		place(hoverBox, hovered && hovered !== chosen ? hovered : null, geometry, clip);
		const shown = place(selectedBox, chosen, geometry, clip);
		if (!shown || !chosen) {
			chip.classList.add("hidden");
			return;
		}
		chip.textContent = `${nameOf(chosen, words)} · ${Math.round(shown.rect.width)} × ${Math.round(shown.rect.height)}`;
		chip.classList.remove("hidden");
		// Above the outline's top left corner, or inside it when there is no room above.
		const above = shown.top - CHIP_HEIGHT;
		chip.style.setProperty("left", `${Math.max(0, shown.left)}px`);
		chip.style.setProperty("top", `${above >= 0 ? above : Math.max(0, shown.top)}px`);
	};

	const schedule = () => {
		if (pending) return;
		pending = view.requestAnimationFrame(draw);
	};

	// The shell's own window and the frame element: a resize, a move, a zoom.
	view.addEventListener("resize", schedule);
	cleanups.push(() => view.removeEventListener("resize", schedule));
	const resized = new view.ResizeObserver(schedule);
	resized.observe(frame);
	resized.observe(canvas);
	cleanups.push(() => resized.disconnect());
	const restyled = new view.MutationObserver(schedule);
	restyled.observe(frame, { attributes: true, attributeFilter: ["style", "class", "width", "height"] });
	cleanups.push(() => restyled.disconnect());

	return {
		hover(element) {
			if (element === hovered) return;
			hovered = element;
			schedule();
		},
		select(element) {
			chosen = element;
			schedule();
		},
		selected: () => (chosen?.isConnected ? chosen : null),
		attach(page) {
			for (const cleanup of pageCleanups) cleanup();
			pageCleanups = [];
			hovered = null;
			chosen = null;
			const pageView = page.defaultView;
			if (!pageView) return;
			// The page's own changes (a Site script's, typing) and sizes move what is outlined.
			const changed = new view.MutationObserver(schedule);
			changed.observe(page, { subtree: true, childList: true, attributes: true, characterData: true });
			const sized = new view.ResizeObserver(schedule);
			sized.observe(page.documentElement);
			if (page.body) sized.observe(page.body);
			page.addEventListener("scroll", schedule, { capture: true, passive: true });
			page.addEventListener("load", schedule, { capture: true });
			pageView.addEventListener("resize", schedule);
			pageCleanups.push(
				() => changed.disconnect(),
				() => sized.disconnect(),
				() => page.removeEventListener("scroll", schedule, { capture: true }),
				() => page.removeEventListener("load", schedule, { capture: true }),
				() => pageView.removeEventListener("resize", schedule),
			);
			schedule();
		},
		elementAt(clientX, clientY) {
			const geometry = frameGeometry(frame);
			const canvasBox = canvas.getBoundingClientRect();
			const inside =
				clientX >= Math.max(geometry.left, canvasBox.left) &&
				clientX < Math.min(geometry.left + geometry.width, canvasBox.right) &&
				clientY >= Math.max(geometry.top, canvasBox.top) &&
				clientY < Math.min(geometry.top + geometry.height, canvasBox.bottom);
			const page = frame.contentDocument;
			if (!inside || !page) return null;
			const x = (clientX - geometry.left) / geometry.scale;
			const y = (clientY - geometry.top) / geometry.scale;
			return page.elementsFromPoint(x, y)[0] ?? null;
		},
		schedule,
		destroy() {
			for (const cleanup of [...pageCleanups, ...cleanups]) cleanup();
			if (pending) view.cancelAnimationFrame(pending);
			layer.remove();
		},
	};
}

/** What an element is called on its chip and when announced: a region by its Field, else by its kind. */
export function nameOf(element: Element, words: Words): string {
	if (element.matches(TEXT_REGION)) {
		const label = element.getAttribute("data-wc-label");
		if (label) return label;
		if (element.getAttribute("data-wc-field") === "title") return words.title;
	}
	const tag = element.localName;
	const kind = ELEMENT_KINDS[tag];
	return kind ? words.elements[kind] : tag;
}

const ELEMENT_KINDS: Readonly<Record<string, keyof Words["elements"]>> = {
	h1: "heading",
	h2: "heading",
	h3: "heading",
	h4: "heading",
	h5: "heading",
	h6: "heading",
	p: "paragraph",
	a: "link",
	button: "button",
	img: "image",
	picture: "image",
	svg: "image",
	ul: "list",
	ol: "list",
	li: "listItem",
	section: "section",
	header: "header",
	footer: "footer",
	nav: "navigation",
	main: "main",
	article: "article",
	form: "form",
	input: "field",
	textarea: "field",
	select: "field",
	figure: "figure",
	body: "page",
};
