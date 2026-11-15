import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

import type { FrameHandle } from "../canvas/Frame.tsx";
import type { Inserter, Landing } from "./insert.ts";

/** A line's box on the shell's window. */
type Line = { left: number; top: number; width: number };

/** The page's elements a source or a Placement draws at its top level (a Placement's roots). */
function rootsOfSource(page: Document, source: string): Element[] {
	const prefix = `${source}#`;
	return [...page.querySelectorAll(`[data-wc-code^="${CSS.escape(source)}#"]`)].filter((element) => {
		const parent = element.parentElement?.closest("[data-wc-code]");
		return !parent?.getAttribute("data-wc-code")?.startsWith(prefix);
	});
}

/** Where the landing line goes on the canvas, through the frame's offset and zoom. */
function canvasLine(handle: FrameHandle | null, landing: Landing): Line | null {
	const page = handle?.page();
	const overlay = handle?.overlay();
	if (!page || !overlay) return null;
	if (landing.kind === "refused") return null;
	let element: Element | null = null;
	let inside = false;
	if (landing.kind === "page") {
		if (!landing.anchor) return null;
		element = rootsOfSource(page, landing.anchor).at(-1) ?? null;
	} else if (landing.anchor) {
		element = page.querySelector(`[data-wc-code="${CSS.escape(landing.anchor)}"]`);
		inside = landing.position === "inside";
	} else element = rootsOfSource(page, landing.source).at(-1) ?? null;
	const box = element ? overlay.boxOf(element) : null;
	if (!box) return null;
	if (inside) return { left: box.left + 6, top: box.bottom - 4, width: Math.max(8, box.width - 12) };
	return { left: box.left, top: box.bottom - 1, width: box.width };
}

/** Where the landing line goes in the tree: under the anchor's row and what it holds, one level in for "inside". */
function treeLine(landing: Landing): Line | null {
	if (landing.kind === "refused" || !landing.anchor) return null;
	const tree = document.querySelector<HTMLElement>("[data-wc-layers] [role=tree]");
	const rows = tree ? [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")] : [];
	const at = rows.findIndex((row) => row.dataset.wcRef === landing.anchor);
	const anchor = rows[at];
	if (!tree || !anchor) return null;
	const level = Number(anchor.getAttribute("aria-level") ?? "1");
	let last = anchor;
	for (const row of rows.slice(at + 1)) {
		if (Number(row.getAttribute("aria-level") ?? "1") <= level) break;
		last = row;
	}
	const box = last.getBoundingClientRect();
	const clip = tree.getBoundingClientRect();
	if (box.bottom < clip.top || box.bottom > clip.bottom) return null;
	const indent = landing.kind === "tree" && landing.position === "inside" ? 14 : 0;
	const start = anchor.getBoundingClientRect().left + 4 + (level - 1) * 14 + indent;
	return { left: start, top: box.bottom - 1, width: Math.max(16, clip.right - start - 4) };
}

/**
 * Where the next insert lands (SPEC 6, `docking/07`): a green line on the canvas and in the tree,
 * while a button of the insert row is under the pointer or has focus. Drawn in the shell's own
 * document, so the Site's CSS never reaches it, and moved with the page as it scrolls or changes.
 */
export function InsertLine({ inserter, frame }: { inserter: Inserter; frame: RefObject<FrameHandle | null> }) {
	const shown = useSyncExternalStore(inserter.subscribe, inserter.current);
	const [lines, setLines] = useState<{ canvas: Line | null; tree: Line | null }>({ canvas: null, tree: null });
	useEffect(() => {
		if (!shown) {
			setLines({ canvas: null, tree: null });
			return;
		}
		const draw = () => setLines({ canvas: canvasLine(frame.current, shown.landing), tree: treeLine(shown.landing) });
		draw();
		const stop = frame.current?.overlay()?.onDraw(draw);
		return () => stop?.();
	}, [shown, frame]);
	if (!shown) return null;
	return (
		<>
			{[lines.canvas, lines.tree].map((line, index) =>
				line ? (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: two fixed lines, the canvas's then the tree's.
						key={index}
						aria-hidden="true"
						className="pointer-events-none fixed z-30 h-0.5 rounded-full bg-[#4ade80]"
						style={{ left: line.left, top: line.top, width: line.width }}
						data-wc-insert-line={index === 0 ? "canvas" : "tree"}
					/>
				) : null,
			)}
		</>
	);
}
