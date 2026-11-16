import { useLayoutEffect, useMemo, useState } from "react";

import { type Direction, type MasonryLayout, type MasonryOptions, masonry, neighbour } from "./masonry.ts";

/**
 * The masonry layout of `shapes` (height over width) in the element given to `ref`: its width measured
 * when it appears, before it is painted, and again whenever it changes, so the boxes are in place from
 * the first frame (FX-03).
 */
export function useMasonry(
	shapes: readonly number[],
	options: MasonryOptions,
): { ref: (element: HTMLElement | null) => void; layout: MasonryLayout } {
	const [element, setElement] = useState<HTMLElement | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!element) return;
		setWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	const key = shapes.join(",");
	const { minColumn, gap, below } = options;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the shapes.
	const layout = useMemo(() => masonry(shapes, width, { minColumn, gap, below }), [key, width, minColumn, gap, below]);
	return { ref: setElement, layout };
}

const ARROWS: Record<string, Direction> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
};

/**
 * Where an arrow key goes in a masonry grid from box `from` (Home and End: the first and the last), or
 * null when the key isn't one of those or there is nothing that way. In a right-to-left page, left and
 * right swap, as the columns do.
 */
export function arrowTarget(
	event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
	layout: MasonryLayout,
	from: number,
	rtl = false,
): number | null | undefined {
	if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
	if (event.key === "Home") return 0;
	if (event.key === "End") return layout.boxes.length - 1;
	let direction = ARROWS[event.key];
	if (!direction) return undefined;
	if (rtl && (direction === "left" || direction === "right")) direction = direction === "left" ? "right" : "left";
	if (from < 0) return 0;
	return neighbour(layout.boxes, from, direction);
}
