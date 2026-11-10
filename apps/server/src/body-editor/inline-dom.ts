import { canonicalInline, type InlineText, type Mark, type Run, renderInline } from "@webcraft/renderer/body/editing";

/**
 * Formatted text in the block editor: a Block's runs written into an editable element, and read back
 * from what the browser made of it while someone typed. The browser's own editing commands (bold,
 * italic, strikethrough, links) write `<b>`, `<i>`, `<strike>`, `<a>`; reading accepts those and the
 * renderer's own `<strong>`, `<em>`, `<s>`, `<code>`, so nothing typed is lost. Positions are counted
 * in characters of text, a line break counting as one.
 */

/** The HTML an editable element starts with: the runs as the renderer writes them. */
export function runsToHtml(runs: InlineText): string {
	const html = renderInline(runs);
	// A line break at the very end needs a second one before the browser shows the empty line.
	return runs.at(-1)?.text.endsWith("\n") ? `${html}<br>` : html;
}

const BOLD = new Set(["B", "STRONG"]);
const ITALIC = new Set(["I", "EM"]);
const STRIKE = new Set(["S", "STRIKE", "DEL"]);
const BLOCKS = new Set(["DIV", "P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE"]);

/** Reads an editable element's text and formatting as runs, in their canonical form. */
export function runsFromElement(element: HTMLElement): InlineText {
	const runs: Run[] = [];
	const walk = (node: Node, marks: ReadonlySet<Mark>, link: string | undefined) => {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent ?? "").replace(/ /g, " ").replace(/​/g, "");
			if (text) runs.push({ text, marks: [...marks], ...(link ? { link } : {}) });
			return;
		}
		if (!(node instanceof HTMLElement)) return;
		if (node.tagName === "BR") {
			runs.push({ text: "\n", marks: [...marks], ...(link ? { link } : {}) });
			return;
		}
		const next = new Set(marks);
		if (BOLD.has(node.tagName) || Number(node.style.fontWeight) >= 600 || node.style.fontWeight === "bold") {
			next.add("bold");
		}
		if (ITALIC.has(node.tagName) || node.style.fontStyle === "italic") next.add("italic");
		if (STRIKE.has(node.tagName) || node.style.textDecorationLine.includes("line-through")) next.add("strike");
		if (node.tagName === "CODE") next.add("code");
		const href = node.tagName === "A" ? (node.getAttribute("href") ?? undefined) : link;
		// Browsers sometimes wrap a new line in its own <div>: it starts on a line of its own.
		if (BLOCKS.has(node.tagName) && runs.length > 0 && !runs.at(-1)?.text.endsWith("\n")) {
			runs.push({ text: "\n" });
		}
		for (const child of node.childNodes) walk(child, next, href);
	};
	for (const child of element.childNodes) walk(child, new Set(), undefined);
	// The browser keeps a last <br> so an empty last line shows; it isn't text.
	const last = runs.at(-1);
	if (last?.text.endsWith("\n")) last.text = last.text.slice(0, -1);
	return canonicalInline(runs);
}

/** The runs before and after a position. */
export function splitRuns(runs: InlineText, offset: number): [InlineText, InlineText] {
	const before: Run[] = [];
	const after: Run[] = [];
	let seen = 0;
	for (const run of runs) {
		const end = seen + run.text.length;
		if (end <= offset) before.push(run);
		else if (seen >= offset) after.push(run);
		else {
			before.push({ ...run, text: run.text.slice(0, offset - seen) });
			after.push({ ...run, text: run.text.slice(offset - seen) });
		}
		seen = end;
	}
	return [canonicalInline(before), canonicalInline(after)];
}

/** Two pieces of formatted text as one. */
export function joinRuns(first: InlineText, second: InlineText): InlineText {
	return canonicalInline([...first, ...second]);
}

/** How many characters formatted text has. */
export function runsLength(runs: InlineText): number {
	return runs.reduce((length, run) => length + run.text.length, 0);
}

/** Formatted text as plain text. */
export function runsText(runs: InlineText): string {
	return runs.map((run) => run.text).join("");
}

/** The text nodes and line breaks of an element, in order: where positions are counted. */
function pieces(element: HTMLElement): (Text | HTMLBRElement)[] {
	const found: (Text | HTMLBRElement)[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node instanceof Text || node instanceof HTMLBRElement) found.push(node);
	}
	return found;
}

/** Where the caret is in an editable element, in characters from its start; null when it isn't in it. */
export function caretOffset(element: HTMLElement): number | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	if (!element.contains(range.startContainer)) return null;
	const before = document.createRange();
	before.selectNodeContents(element);
	before.setEnd(range.startContainer, range.startOffset);
	const fragment = before.cloneContents();
	const holder = document.createElement("div");
	holder.append(fragment);
	return runsLength(runsFromElement(holder)) + (endsWithBreak(holder) ? 1 : 0);
}

/** Whether a piece of an element ends with a line break (which `runsFromElement` drops as the browser's own). */
function endsWithBreak(element: HTMLElement): boolean {
	const all = pieces(element);
	return all.at(-1) instanceof HTMLBRElement;
}

/** Whether there is a selection of some text inside the element. */
export function hasSelection(element: HTMLElement): boolean {
	const selection = window.getSelection();
	return Boolean(
		selection && selection.rangeCount > 0 && !selection.isCollapsed && element.contains(selection.anchorNode),
	);
}

/** Puts the caret at a position in an editable element (its end when past it), and focuses it. */
export function placeCaret(element: HTMLElement, offset: number | "start" | "end"): void {
	element.focus({ preventScroll: false });
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	if (offset === "start" || offset === 0) {
		range.setStart(element, 0);
	} else {
		const target = offset === "end" ? Number.POSITIVE_INFINITY : offset;
		let seen = 0;
		let placed = false;
		for (const piece of pieces(element)) {
			const length = piece instanceof Text ? piece.data.length : 1;
			if (seen + length >= target) {
				if (piece instanceof Text) range.setStart(piece, target - seen);
				else range.setStartAfter(piece);
				placed = true;
				break;
			}
			seen += length;
		}
		if (!placed) {
			range.selectNodeContents(element);
			range.collapse(false);
		}
	}
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** Whether the caret is on the first (or last) line of an element, so the arrow keys leave it for the Block above (or below). */
export function caretOnEdgeLine(element: HTMLElement, edge: "first" | "last"): boolean {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
	const range = selection.getRangeAt(0).cloneRange();
	const rects = range.getClientRects();
	const box = element.getBoundingClientRect();
	const caret =
		rects[0] ?? (range.startContainer instanceof Element ? range.startContainer.getBoundingClientRect() : null);
	if (!caret || (caret.height === 0 && caret.top === 0)) return true;
	const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || caret.height || 20;
	return edge === "first" ? caret.top - box.top < lineHeight * 0.9 : box.bottom - caret.bottom < lineHeight * 0.9;
}
