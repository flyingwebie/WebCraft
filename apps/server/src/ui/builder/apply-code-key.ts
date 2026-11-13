import type { KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { codeKeyEdit } from "./code-keys.ts";

/** Commit controlled text before restoring its selection, including consecutive indentation keys. */
export function applyCodeKey(event: KeyboardEvent<HTMLTextAreaElement>, change: (text: string) => void): boolean {
	const area = event.currentTarget;
	const edit = codeKeyEdit(event.nativeEvent, area);
	if (!edit) return false;
	event.preventDefault();
	const changed = area.value !== edit.text;
	flushSync(() => change(edit.text));
	area.setSelectionRange(edit.start, edit.end);
	// Departure guards observe input, including edits made by indentation commands.
	if (changed) area.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	return true;
}
