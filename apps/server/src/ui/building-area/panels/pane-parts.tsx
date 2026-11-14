import { BracesIcon, CheckIcon, LoaderCircleIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { ariaKeys, shortcutText } from "../../builder/shortcuts.ts";
import { editorHistory } from "../../builder/editor-history.ts";
import { FORMAT_SHOWN_MS, FORMAT_SPINNER_MS, formatTextArea, isFormatKey } from "../../code-format/box.ts";
import type { CodeFormat, FormatNote } from "../../code-format/FormatControl.tsx";
import { type CodeLanguage, format } from "../../code-format/format.ts";
import { registerFormatTarget } from "../../code-format/targets.ts";
import type { Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { type PaneStore, paneStore, usePane } from "./pane-store.ts";

/**
 * What the three code panes share (BA-11): the `{ }` Format button of a pane's header (SPEC 5.1,
 * `builder/10`: at rest, a spinner after 150 ms, a check for 2 s, red when the code is broken), the
 * Expand button after it, and the boxes' settings from the pane's menu.
 */

/**
 * Format for one code pane's box (SPEC 5.1): what UI-15's `useCodeFormat` does (the selected lines or
 * all of it, one edit typed in so it is one Undo step, the caret on its word; ⇧⌥F; the Command menu's
 * "Format HTML/CSS/JS" reach it while it can be edited), without the admin's words and their library,
 * which the shell doesn't carry: the panes' words are the shell's own.
 */
export function useBoxFormat(
	language: CodeLanguage,
	area: RefObject<HTMLTextAreaElement | null>,
	value: string,
	editable: boolean,
): CodeFormat {
	const [phase, setPhase] = useState<CodeFormat["phase"]>("rest");
	const [note, setNote] = useState<FormatNote | null>(null);
	const [problemLine, setProblemLine] = useState<number | null>(null);
	const timers = useRef<number[]>([]);
	const working = useRef(false);
	const failedOn = useRef<string | null>(null);
	const clearTimers = useCallback(() => {
		for (const timer of timers.current) window.clearTimeout(timer);
		timers.current = [];
	}, []);
	useEffect(() => clearTimers, [clearTimers]);
	// A problem stays marked until the text changes.
	useEffect(() => {
		if (failedOn.current !== null && value !== failedOn.current) {
			failedOn.current = null;
			setProblemLine(null);
			setNote((shown) => (shown?.kind === "problem" ? null : shown));
			setPhase((shown) => (shown === "failed" ? "rest" : shown));
		}
	}, [value]);

	const run = useCallback(async () => {
		const element = area.current;
		if (!element || element.readOnly || working.current) return;
		working.current = true;
		clearTimers();
		timers.current.push(window.setTimeout(() => setPhase("working"), FORMAT_SPINNER_MS));
		const history = editorHistory();
		history.boundary();
		let result: Awaited<ReturnType<typeof formatTextArea>>;
		try {
			result = await formatTextArea(element, language, format);
		} catch {
			result = null;
			setNote({ kind: "unavailable" });
		} finally {
			history.boundary();
			working.current = false;
			clearTimers();
		}
		if (!result) {
			setPhase("rest");
			return;
		}
		if (result.ok) {
			setProblemLine(null);
			setNote(result.changedLines ? { kind: "changed", count: result.changedLines } : { kind: "tidy" });
			setPhase("done");
			timers.current.push(
				window.setTimeout(() => {
					setPhase("rest");
					setNote(null);
				}, FORMAT_SHOWN_MS),
			);
		} else {
			failedOn.current = element.value;
			setProblemLine(result.line);
			setNote({ kind: "problem", line: result.line, reason: result.reason });
			setPhase("failed");
		}
	}, [area, language, clearTimers]);

	const latest = useRef(run);
	latest.current = run;
	useEffect(
		() => (editable ? registerFormatTarget(language, () => latest.current()) : undefined),
		[editable, language],
	);
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (!isFormatKey(event.nativeEvent)) return false;
			event.preventDefault();
			void run();
			return true;
		},
		[run],
	);
	const goToLine = useCallback(
		(line: number) => {
			const element = area.current;
			if (!element) return;
			const offset = element.value
				.split("\n")
				.slice(0, line - 1)
				.reduce((sum, each) => sum + each.length + 1, 0);
			element.focus();
			element.setSelectionRange(offset, offset);
		},
		[area],
	);
	return { run, onKeyDown, phase, note, problemLine, goToLine };
}

/** A box's Format as its header button sees it: the phase, and how to run it (none while the box can't be formatted). */
export type FormatSlot = PaneStore<{ phase: CodeFormat["phase"]; run: (() => Promise<void>) | null }>;

export function formatSlot(): FormatSlot {
	return paneStore<{ phase: CodeFormat["phase"]; run: (() => Promise<void>) | null }>({ phase: "rest", run: null });
}

/** Hands a box's Format to its header button while the box is there and can be formatted. */
export function useFormatSlot(slot: FormatSlot, format: CodeFormat, editable: boolean): void {
	useEffect(() => {
		slot.set({ phase: format.phase, run: editable ? format.run : null });
	}, [slot, format.phase, format.run, editable]);
	useEffect(() => () => slot.set({ run: null, phase: "rest" }), [slot]);
}

/** The settings of the code boxes (the panes' menus): wrap long lines; format when the person leaves a box. */
export type PaneSettings = { wrap: boolean; formatOnLeave: boolean };

const BUTTON = `group text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong relative inline-grid size-6 shrink-0 place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`;

/** The `{ }` button in a code pane's header, just before its Expand button (SPEC 5.1). Absent for a read-only box. */
export function FormatButton({ slot, words }: { slot: FormatSlot; words: Words }) {
	const { phase, run } = usePane(slot);
	if (!run) return null;
	const label = words.styles.format.format;
	const keys = shortcutText("editor.format");
	return (
		<button
			type="button"
			aria-label={label}
			aria-keyshortcuts={ariaKeys("editor.format") || undefined}
			aria-busy={phase === "working" ? true : undefined}
			// Keeps the box's selection: Format works on the selected lines.
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => void run()}
			className={BUTTON}
			data-format-button=""
			data-format-phase={phase}
		>
			{phase === "working" ? (
				<LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
			) : phase === "done" ? (
				<CheckIcon aria-hidden="true" className="text-chrome-ok size-3.5" />
			) : (
				<BracesIcon aria-hidden="true" className={`size-3.5 ${phase === "failed" ? "text-chrome-danger" : ""}`} />
			)}
			<Tip label={label} keys={keys || undefined} side="bottom" />
		</button>
	);
}

/** Expand: the pane takes its dock alone ("one box open wide"), and the same button gives it back its share. */
export function ExpandButton({ wide, onToggle, words }: { wide: boolean; onToggle(): void; words: Words }) {
	const label = wide ? words.code.restore : words.code.expand;
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={wide}
			onClick={onToggle}
			className={`${BUTTON} ${wide ? "bg-chrome-hover text-chrome-strong" : ""}`}
			data-wc-pane-expand=""
		>
			{wide ? (
				<Minimize2Icon aria-hidden="true" className="size-3.5" />
			) : (
				<Maximize2Icon aria-hidden="true" className="size-3.5" />
			)}
			<Tip label={label} side="bottom" align="end" />
		</button>
	);
}
