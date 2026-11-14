import type { CodeLanguage, FormatOptions, FormatResult } from "./format.ts";

/** How long the button's check and the line under the box stay (SPEC 10). */
export const FORMAT_SHOWN_MS = 2000;
/** The button shows it is working only when Prettier takes longer than this to load. */
export const FORMAT_SPINNER_MS = 150;

/**
 * Formats a code box's text area in place: the selected lines, or all of it. The change goes in as one
 * edit typed over what changed (so the browser's own Undo and the box's input handling see one step),
 * the caret stays on the same word, and the box doesn't scroll. Answers what `format` answered, or null
 * when the text changed while Prettier worked (nothing is done then). Nothing changes on a problem.
 *
 * Self-contained, so Code mode's asset can carry it as text (`assets.ts`): `run` is `format`.
 */
export async function formatTextArea(
	area: HTMLTextAreaElement,
	language: CodeLanguage,
	run: (text: string, language: CodeLanguage, options: FormatOptions) => Promise<FormatResult>,
): Promise<FormatResult | null> {
	const text = area.value;
	const { selectionStart, selectionEnd } = area;
	const result = await run(text, language, {
		range: selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : undefined,
		caret: selectionStart,
	});
	if (area.value !== text) return null;
	if (!result.ok || result.changedLines === 0) return result;
	const next = result.text;
	// Only what changed is typed over: the same start and end are left alone.
	let from = 0;
	while (from < text.length && from < next.length && text[from] === next[from]) from++;
	let tail = 0;
	while (
		tail < text.length - from &&
		tail < next.length - from &&
		text[text.length - 1 - tail] === next[next.length - 1 - tail]
	)
		tail++;
	const { scrollTop, scrollLeft } = area;
	area.focus({ preventScroll: true });
	area.setSelectionRange(from, text.length - tail);
	const typed = area.ownerDocument.execCommand("insertText", false, next.slice(from, next.length - tail));
	if (!typed) {
		// Where typing can't be simulated: the same change, without the browser's own Undo.
		area.setRangeText(next.slice(from, next.length - tail), from, text.length - tail, "end");
		area.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	}
	area.setSelectionRange(result.caret, result.caret);
	area.scrollTop = scrollTop;
	area.scrollLeft = scrollLeft;
	return result;
}

/** Whether a key press is Format's: ⇧⌥F (Shift+Alt+F), whatever letter ⌥ makes of F on the keyboard. */
export function isFormatKey(
	event: Pick<KeyboardEvent, "code" | "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">,
): boolean {
	return (
		event.altKey &&
		event.shiftKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		(event.code === "KeyF" || event.key.toLowerCase() === "f")
	);
}
