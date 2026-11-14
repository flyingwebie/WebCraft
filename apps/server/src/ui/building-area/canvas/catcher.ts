import type { Overlay } from "./overlay.ts";

/**
 * Drags that start in the shell and end over the page (ADR 0037): once the pointer has moved, a
 * transparent catcher covers the window, so the shell keeps the pointer as it crosses the frame's
 * edge (a frame would otherwise take its events), and the element under it is found in the page with
 * `elementsFromPoint`, through the frame's offset and zoom. Escape, or losing the pointer, cancels.
 *
 * A control starts such a drag by carrying `data-wc-drag` (what it drags, such as an insert row's
 * item); the catcher listens for them on the shell's whole document.
 */
export type DragCatcher = { destroy(): void };

/** How far the pointer must move before a press becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;

export function installDragCatcher(options: {
	document: Document;
	overlay: Overlay;
	/** A drag ended: what was dragged, and the page's element under the drop (null outside the page). */
	onDrop(source: string, target: Element | null): void;
}): DragCatcher {
	const { document: doc, overlay, onDrop } = options;
	const view = doc.defaultView ?? window;
	let press: { pointerId: number; x: number; y: number; source: string; control: HTMLElement } | null = null;
	let catcher: HTMLElement | null = null;

	const stop = () => {
		if (press?.control.hasPointerCapture(press.pointerId)) press.control.releasePointerCapture(press.pointerId);
		press = null;
		catcher?.remove();
		catcher = null;
		overlay.hover(null);
	};

	const onDown = (event: PointerEvent) => {
		if (event.button !== 0 || !(event.target instanceof view.Element)) return;
		const control = event.target.closest<HTMLElement>("[data-wc-drag]");
		if (!control) return;
		press = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			source: control.dataset.wcDrag ?? "",
			control,
		};
		// A quick first move could land on the frame before the catcher is up: where the browser
		// captures across frames, the control keeps the pointer from the start.
		try {
			control.setPointerCapture(event.pointerId);
		} catch {
			// The pointer is gone already.
		}
	};

	const onMove = (event: PointerEvent) => {
		if (!press || event.pointerId !== press.pointerId) return;
		if (!catcher) {
			if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
			catcher = doc.createElement("div");
			catcher.className = "fixed inset-0 z-50 cursor-grabbing";
			catcher.dataset.wcCatcher = "";
			catcher.setAttribute("aria-hidden", "true");
			doc.body.append(catcher);
		}
		event.preventDefault();
		overlay.hover(overlay.elementAt(event.clientX, event.clientY));
	};

	const onUp = (event: PointerEvent) => {
		if (!press || event.pointerId !== press.pointerId) return;
		const dragging = catcher !== null;
		const source = press.source;
		const target = dragging ? overlay.elementAt(event.clientX, event.clientY) : null;
		stop();
		if (!dragging) return;
		// The press ends as a drop, never also as a click on the control it started on.
		const swallow = (click: Event) => {
			click.preventDefault();
			click.stopImmediatePropagation();
		};
		view.addEventListener("click", swallow, { capture: true, once: true });
		view.setTimeout(() => view.removeEventListener("click", swallow, { capture: true }), 0);
		onDrop(source, target);
	};

	const onKey = (event: KeyboardEvent) => {
		if (event.key === "Escape" && catcher) {
			event.preventDefault();
			stop();
		}
	};

	doc.addEventListener("pointerdown", onDown, true);
	view.addEventListener("pointermove", onMove, true);
	view.addEventListener("pointerup", onUp, true);
	view.addEventListener("pointercancel", stop, true);
	view.addEventListener("keydown", onKey, true);
	return {
		destroy() {
			stop();
			doc.removeEventListener("pointerdown", onDown, true);
			view.removeEventListener("pointermove", onMove, true);
			view.removeEventListener("pointerup", onUp, true);
			view.removeEventListener("pointercancel", stop, true);
			view.removeEventListener("keydown", onKey, true);
		},
	};
}
