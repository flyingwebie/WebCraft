/** One text-edit contract for HTML, CSS and JS on both canvases. Self-contained for asset injection.
 * The caller commits through its existing input owner; this helper never owns history or focus. */
export function codeKeyEdit(
	event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">,
	area: HTMLTextAreaElement,
): { text: string; start: number; end: number } | null {
	if (area.readOnly || area.disabled || event.isComposing) return null;
	const { value, selectionStart: start, selectionEnd: end } = area;
	const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
	if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
		const indent = /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? "";
		const inserted = `\n${indent}`;
		return {
			text: value.slice(0, start) + inserted + value.slice(end),
			start: start + inserted.length,
			end: start + inserted.length,
		};
	}
	if (!(event.ctrlKey || event.metaKey) || event.altKey || !["[", "]"].includes(event.key)) return null;
	const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
	const newline = value.indexOf("\n", last);
	const through = newline < 0 ? value.length : newline;
	let offset = lineStart;
	let nextStart = start;
	let nextEnd = end;
	const lines = value
		.slice(lineStart, through)
		.split("\n")
		.map((line) => {
			const removed = event.key === "[" ? (/^(?:\t| {1,2})/.exec(line)?.[0].length ?? 0) : 0;
			const delta = event.key === "]" ? 2 : -removed;
			if (offset <= start) nextStart += delta > 0 ? delta : -Math.min(removed, start - offset);
			if (offset <= end) nextEnd += delta > 0 ? delta : -Math.min(removed, end - offset);
			offset += line.length + 1;
			return delta > 0 ? `  ${line}` : line.slice(removed);
		});
	return { text: value.slice(0, lineStart) + lines.join("\n") + value.slice(through), start: nextStart, end: nextEnd };
}
