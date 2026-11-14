import type { FormField, FormVersion } from "@webcraft/renderer/forms";

/**
 * The arithmetic of the Build tab (BA-26, SPEC 15.2): a Form's items are one list in order, where a
 * step holds the items after it up to the next step and a section the items after it up to the next
 * section or step. The canvas shows one step at a time; adding, moving and removing work on that list,
 * so a field moved past a section's or a step's title moves into it. Pure, so it is tested alone.
 */

export type Item = FormField;

/** The Form's steps, in order: each step item's index and its number (from 1). None for a Form without steps. */
export function stepsOf(items: readonly Item[]): { index: number; number: number }[] {
	const steps: { index: number; number: number }[] = [];
	items.forEach((item, index) => {
		if (item.type === "step") steps.push({ index, number: steps.length + 1 });
	});
	return steps;
}

/** The step an item is in (from 1), or 1 for a Form without steps; a step item is in its own step. */
export function stepOf(items: readonly Item[], index: number): number {
	let step = 0;
	for (let at = 0; at <= index && at < items.length; at++) if (items[at]?.type === "step") step++;
	return Math.max(1, step);
}

/**
 * The items a step shows, as indexes, with where an item added at its end goes (`end`). In a Form
 * without steps, every item; in step `n`, the items after its step item up to the next one.
 */
export function stepRange(items: readonly Item[], step: number): { indexes: number[]; end: number } {
	const steps = stepsOf(items);
	if (steps.length === 0) return { indexes: items.map((_, index) => index), end: items.length };
	const at = steps[Math.min(Math.max(step, 1), steps.length) - 1];
	const next = steps.find((each) => at && each.index > at.index);
	const start = (at?.index ?? -1) + 1;
	const end = next ? next.index : items.length;
	const indexes: number[] = [];
	for (let index = start; index < end; index++) indexes.push(index);
	return { indexes, end };
}

/** The items with `item` put at `at` (0 to the list's length). */
export function insertAt(items: readonly Item[], at: number, item: Item): Item[] {
	const place = Math.min(Math.max(at, 0), items.length);
	return [...items.slice(0, place), item, ...items.slice(place)];
}

/**
 * The items with the one at `from` moved to the gap before `before` (the list's length for the end),
 * and where it now is. A move to its own place changes nothing.
 */
export function moveTo(items: readonly Item[], from: number, before: number): { items: Item[]; index: number } {
	if (from < 0 || from >= items.length) return { items: [...items], index: from };
	const target = Math.min(Math.max(before, 0), items.length);
	if (target === from || target === from + 1) return { items: [...items], index: from };
	const moved = [...items];
	const [item] = moved.splice(from, 1);
	const index = target > from ? target - 1 : target;
	if (item) moved.splice(index, 0, item);
	return { items: moved, index };
}

/** The items with one moved a place up (−1) or down (1), across a section's or step's title too. */
export function nudge(items: readonly Item[], index: number, by: -1 | 1): { items: Item[]; index: number } {
	const target = index + by;
	if (target < 0 || target >= items.length) return { items: [...items], index };
	// A Form with steps starts with one: nothing moves above the first step's title.
	if (by === -1 && target === 0 && items[0]?.type === "step" && items[index]?.type !== "step") {
		return { items: [...items], index };
	}
	return moveTo(items, index, by === 1 ? index + 2 : target);
}

/**
 * The items with the one at `index` removed. A step's title removed joins its fields to the step
 * before; the first step's, to the next (a Form with steps starts with one).
 */
export function removeAt(items: readonly Item[], index: number): Item[] {
	const left = items.filter((_, at) => at !== index);
	if (left.length > 0 && left[0]?.type !== "step") {
		const first = left.findIndex((item) => item.type === "step");
		if (first > 0) return moveTo(left, first, 0).items;
	}
	return left;
}

/**
 * The items with a new step: in a Form without steps, every item goes into a first step and the new
 * one follows it; otherwise the new step comes last. Answers the new step's number.
 */
export function addStep(
	items: readonly Item[],
	make: (number: number, all: readonly Item[]) => Item,
): { items: Item[]; step: number } {
	const steps = stepsOf(items);
	if (steps.length === 0) {
		const first = make(1, items);
		const withFirst = [first, ...items];
		return { items: [...withFirst, make(2, withFirst)], step: 2 };
	}
	return { items: [...items, make(steps.length + 1, items)], step: steps.length + 1 };
}

/** The items with step `from` (its title and everything in it) moved to the place of step `to`. */
export function moveStep(items: readonly Item[], from: number, to: number): Item[] {
	const steps = stepsOf(items);
	if (from === to || from < 1 || to < 1 || from > steps.length || to > steps.length) return [...items];
	const blocks = steps.map((step, at) => items.slice(step.index, steps[at + 1]?.index ?? items.length));
	const [block] = blocks.splice(from - 1, 1);
	if (block) blocks.splice(to - 1, 0, block);
	return [...items.slice(0, steps[0]?.index ?? 0), ...blocks.flat()];
}

/** The widths a field can take (UI-05), and how much of the line each is. */
export const WIDTH_SHARES = { whole: 1, half: 1 / 2, third: 1 / 3 } as const;

export type FieldWidth = keyof typeof WIDTH_SHARES;

/** The width a field snaps to when its right edge is dragged to `share` of its line. */
export function snapWidth(share: number): FieldWidth {
	if (share < (WIDTH_SHARES.third + WIDTH_SHARES.half) / 2) return "third";
	if (share < (WIDTH_SHARES.half + WIDTH_SHARES.whole) / 2) return "half";
	return "whole";
}

/** A box on the screen. */
export type Box = { top: number; left: number; width: number; height: number };

/** Where a dragged field or kind lands: before an item (its index in the Form), or at the step's end; and the line drawn there. */
export type Drop = { before: number | null; line: { x: number; y: number; length: number; vertical: boolean } };

/**
 * Where a drop lands, from the boxes of the items the step shows (in order, with their indexes in the
 * Form) and the pointer: before the first item whose middle is below the pointer, or (on a line of
 * fields side by side) before the one whose middle is right of it; after the last item otherwise.
 * The line is drawn across the gap, or down it between fields on one line.
 */
export function dropAt(
	boxes: readonly { index: number; box: Box }[],
	point: { x: number; y: number },
	rtl = false,
): Drop | null {
	if (boxes.length === 0) return null;
	const left = Math.min(...boxes.map(({ box }) => box.left));
	const right = Math.max(...boxes.map(({ box }) => box.left + box.width));
	const width = right - left;
	for (let at = 0; at < boxes.length; at++) {
		const each = boxes[at];
		if (!each) continue;
		const { box } = each;
		const inRow = point.y >= box.top && point.y <= box.top + box.height;
		if (inRow) {
			const middle = box.left + box.width / 2;
			const before = rtl ? point.x > middle : point.x < middle;
			const neighbour = boxes[at + 1];
			const sharesLine =
				box.width < width - 1 ||
				(neighbour !== undefined && Math.abs(neighbour.box.top - box.top) < 2 && neighbour.box.width < width - 1);
			if (sharesLine) {
				if (before) return { before: each.index, line: edge(box, rtl ? "end" : "start", rtl) };
				if (neighbour && Math.abs(neighbour.box.top - box.top) < 2) continue;
				return { before: neighbour?.index ?? null, line: edge(box, rtl ? "start" : "end", rtl) };
			}
			const above = point.y < box.top + box.height / 2;
			if (above) return { before: each.index, line: across(boxes[at - 1]?.box ?? null, box, left, width) };
			continue;
		}
		if (point.y < box.top) return { before: each.index, line: across(boxes[at - 1]?.box ?? null, box, left, width) };
	}
	const last = boxes.at(-1)?.box;
	return {
		before: null,
		line: { x: left, y: last ? last.top + last.height + 6 : 0, length: width, vertical: false },
	};
}

function across(previous: Box | null, next: Box, left: number, width: number): Drop["line"] {
	const y = previous ? (previous.top + previous.height + next.top) / 2 : next.top - 6;
	return { x: left, y, length: width, vertical: false };
}

function edge(box: Box, side: "start" | "end", rtl: boolean): Drop["line"] {
	const leftSide = (side === "start") !== rtl;
	return { x: leftSide ? box.left - 8 : box.left + box.width + 8, y: box.top, length: box.height, vertical: true };
}

/**
 * How many changes a Form's Draft holds against what is published, for the Draft state: each field
 * added, removed or changed (by its key), and the button, the message once sent and the spam limits
 * each as one. A Form never published counts each of its items (at least one).
 */
export function changesOf(draft: FormVersion, published: FormVersion | null): number {
	if (!published) return Math.max(1, draft.fields.length);
	const was = new Map(published.fields.map((field, index) => [field.key, { field, index }]));
	let count = 0;
	draft.fields.forEach((field, index) => {
		const before = was.get(field.key);
		if (!before) count++;
		else if (before.index !== index || JSON.stringify(before.field) !== JSON.stringify(field)) count++;
		was.delete(field.key);
	});
	count += was.size;
	for (const part of ["submitLabel", "success", "spam"] as const) {
		if (JSON.stringify(draft[part]) !== JSON.stringify(published[part])) count++;
	}
	return count;
}
