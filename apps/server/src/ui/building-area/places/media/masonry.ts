/**
 * The masonry grid of the Media place and the picker (FX-03): each file in its own shape, in columns of
 * about the same width, each next file in the column that is shortest so far, so the files read from
 * left to right as they are listed. Every box is known from the files' pixel sizes before any picture
 * arrives, so nothing moves as they load. Pure: no React, no DOM.
 */

/** A box of the grid, in pixels from the grid's top left; `column` counts from 0. */
export type MasonryBox = { x: number; y: number; width: number; height: number; column: number };

export type MasonryLayout = { columns: number; boxes: MasonryBox[]; height: number };

export type MasonryOptions = {
	/** The narrowest a column may be (the place's 196). */
	minColumn: number;
	/** The space between columns and between boxes. */
	gap: number;
	/** A fixed height under each picture (the picker's name and size); 0 for none. */
	below?: number;
};

/** A picture's height for its width: an image's own shape, 3:4 for anything without one. */
export function shapeOf(width: number | null | undefined, height: number | null | undefined): number {
	if (!width || !height || width <= 0 || height <= 0) return 3 / 4;
	// Very tall or very wide pictures are cropped to keep the grid readable.
	return Math.min(2.5, Math.max(0.4, height / width));
}

/** Lays out boxes of the given shapes (height over width) in a grid `width` pixels wide. */
export function masonry(shapes: readonly number[], width: number, options: MasonryOptions): MasonryLayout {
	const { minColumn, gap, below = 0 } = options;
	const columns = Math.max(1, Math.floor((Math.max(0, width) + gap) / (minColumn + gap)));
	const columnWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
	const heights = new Array<number>(columns).fill(0);
	const boxes = shapes.map((shape) => {
		let column = 0;
		for (let each = 1; each < columns; each++) if ((heights[each] ?? 0) < (heights[column] ?? 0) - 0.5) column = each;
		const y = heights[column] ?? 0;
		const height = Math.round(columnWidth * shape) + below;
		heights[column] = y + height + gap;
		return { x: column * (columnWidth + gap), y, width: columnWidth, height, column };
	});
	return { columns, boxes, height: Math.max(0, Math.max(...heights, 0) - gap) };
}

export type Direction = "up" | "down" | "left" | "right";

/**
 * The box the arrow keys go to from box `from`: up and down, the one above or below in its column;
 * left and right, in the next column, the one beside it whose top is nearest its top (so from the
 * first row the next column's first file), else the nearest in height. Null at an edge.
 */
export function neighbour(boxes: readonly MasonryBox[], from: number, direction: Direction): number | null {
	const here = boxes[from];
	if (!here) return null;
	const middle = (box: MasonryBox) => box.y + box.height / 2;
	const beside = (box: MasonryBox) => Math.min(box.y + box.height, here.y + here.height) - Math.max(box.y, here.y) > 0;
	let best: number | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	boxes.forEach((box, index) => {
		if (index === from) return;
		let score: number | null = null;
		if (direction === "up" || direction === "down") {
			if (box.column !== here.column) return;
			const distance = direction === "down" ? box.y - here.y : here.y - box.y;
			if (distance > 0) score = distance;
		} else {
			const step = direction === "right" ? 1 : -1;
			if (box.column !== here.column + step) return;
			score = beside(box) ? Math.abs(box.y - here.y) : 1_000_000 + Math.abs(middle(box) - middle(here));
		}
		if (score !== null && score < bestScore) {
			bestScore = score;
			best = index;
		}
	});
	return best;
}
