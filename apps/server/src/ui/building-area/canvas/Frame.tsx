import { useEffect, useRef, useState } from "react";
import { AGENT_HOST_PROPERTY, type AgentHost, BUILDING_PAGE_PREFIX } from "../agent/contract.ts";
import { type EditRequests, fill, type Words } from "../api.ts";
import type { RegionCycle } from "../keyboard.ts";
import { installDragCatcher } from "./catcher.ts";
import { createOverlay, nameOf, type Overlay } from "./overlay.ts";
import { regionSaving } from "./regions.ts";

/** What a drop over the page tells the rest of the shell: `webcraft:drop` on the shell's document. */
export type DropDetail = { source: string; target: Element | null };

/**
 * The canvas: the page in a frame of the same origin, on the dark chrome with a 12 px gutter left,
 * right and below (ADR 0037, SPEC 2 and 7), and the overlay drawn over it. The page agent in each page
 * the frame shows hands its events here: a pointer over an element outlines it, a click selects it
 * (on text, the caret is already there and typing starts), typing saves to the Draft.
 */
export function Frame({
	page,
	words,
	request,
	cycle,
	announce,
}: {
	/** The page the frame opens first: its path on the Site, with its query. */
	page: string;
	words: Words;
	request: EditRequests;
	cycle: () => RegionCycle | null;
	announce(text: string, urgent?: boolean): void;
}) {
	const canvas = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const [focused, setFocused] = useState(false);
	// The newest of what the agent's events need, without making the frame again.
	const latest = useRef({ words, request, cycle, announce });
	latest.current = { words, request, cycle, announce };

	useEffect(() => {
		const element = frame.current;
		const area = canvas.current;
		if (!element || !area) return;
		const doc = element.ownerDocument;
		const overlay: Overlay = createOverlay({ canvas: area, frame: element, words: latest.current.words });
		const saving = regionSaving({
			request: (action, body) => latest.current.request(action, body),
			words: latest.current.words,
			announce: (text, urgent) => latest.current.announce(text, urgent),
		});
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
				// The shell's address follows the page the frame shows, so a reload opens it again.
				const shown = `${BUILDING_PAGE_PREFIX}${address}`;
				if (`${location.pathname}${location.search}` !== shown) history.replaceState(history.state, "", shown);
				const path = address.split("?")[0] ?? "/";
				const language = latest.current.request<{ language?: { code?: string } }>("state", { path }).then((answer) => {
					if (!answer.ok && answer.code === "EDIT_MODE_ENDED")
						latest.current.announce(latest.current.words.ended, true);
					return answer.ok ? (answer.data.language?.code ?? null) : null;
				});
				saving.track(document, language);
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
			delete (element as unknown as Record<string, unknown>)[AGENT_HOST_PROPERTY];
		};
	}, [page]);

	return (
		<div ref={canvas} className="absolute inset-0 overflow-hidden" data-wc-canvas="">
			<div className="absolute start-3 end-3 top-0 bottom-3 overflow-hidden rounded-b-md bg-white" data-wc-frame-box="">
				<iframe
					ref={frame}
					title={words.frameTitle}
					// The page is a region of its own, reached with F6 and the skip link; Tab then moves
					// through the page, and leaves it for the shell's next control.
					tabIndex={-1}
					className="block h-full w-full origin-top-left border-0 bg-white"
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
	);
}
