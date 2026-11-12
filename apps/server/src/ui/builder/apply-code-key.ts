import type { KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { codeKeyEdit } from "./code-keys.ts";

/** Commit controlled text before restoring its selection, including consecutive indentation keys. */
export function applyCodeKey(event: KeyboardEvent<HTMLTextAreaElement>, change: (text: string) => void): boolean {
	const area = event.currentTarget;
	const edit = codeKeyEdit(event.nativeEvent, area);
	if (!edit) return false;
	event.preventDefault();
	flushSync(() => change(edit.text));
	area.setSelectionRange(edit.start, edit.end);
	return true;
}
