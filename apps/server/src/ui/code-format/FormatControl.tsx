import { Button } from "@webcraft/ui/components/button.tsx";
import { BracesIcon, CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { editorHistory } from "../editor/editor-history.ts";
import { ariaKeys, withKeys } from "../editor/shortcuts.ts";
import { useT } from "../i18n.tsx";
import { FORMAT_SHOWN_MS, FORMAT_SPINNER_MS, formatTextArea, isFormatKey } from "./box.ts";
import { type CodeLanguage, format } from "./format.ts";
import { registerFormatTarget } from "./targets.ts";

/** What Format shows: the button's state and the line under the box. */
export type FormatNote =
	| { kind: "changed"; count: number }
	| { kind: "tidy" }
	| { kind: "problem"; line: number; reason: string }
	| { kind: "unavailable" };

export type CodeFormat = {
	/** Formats the box: the selected lines, or all of it. */
	run(): Promise<void>;
	/** ⇧⌥F in the box; answers whether it was Format's key. */
	onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
	phase: "rest" | "working" | "done" | "failed";
	note: FormatNote | null;
	/** The line Format couldn't read, marked until the text changes. */
	problemLine: number | null;
	/** Moves the caret to the start of a line of the box. */
	goToLine(line: number): void;
};

/**
 * Format for one code box (SPEC 5.1): its button, its key and the line under the box, for a text area
 * the box owns. Formatting is one Undo step: the Builder's and Code mode's history get a boundary on
 * each side of it, and the box's text area gets one edit, as typing does (`formatTextArea`).
 */
export function useCodeFormat(
	language: CodeLanguage,
	area: RefObject<HTMLTextAreaElement | null>,
	value: string,
	/** Whether the box can be edited now: only then do the Command menu's Format commands reach it. */
	editable = true,
): CodeFormat {
	const [phase, setPhase] = useState<CodeFormat["phase"]>("rest");
	const [note, setNote] = useState<FormatNote | null>(null);
	const [problemLine, setProblemLine] = useState<number | null>(null);
	const timers = useRef<number[]>([]);
	const working = useRef(false);
	const formattedValue = useRef<string | null>(null);

	const clearTimers = useCallback(() => {
		for (const timer of timers.current) window.clearTimeout(timer);
		timers.current = [];
	}, []);
	useEffect(() => clearTimers, [clearTimers]);

	// A problem stays marked until the text changes.
	useEffect(() => {
		if (formattedValue.current !== null && value !== formattedValue.current) {
			setProblemLine(null);
			setNote((shown) => (shown?.kind === "problem" ? null : shown));
			setPhase((shown) => (shown === "failed" ? "rest" : shown));
			formattedValue.current = null;
		}
	}, [value]);

	const run = useCallback(async () => {
		const element = area.current;
		if (!element || element.readOnly || element.disabled || working.current) return;
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
			formattedValue.current = element.value;
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
			const lines = element.value.split("\n");
			const offset = lines.slice(0, line - 1).reduce((sum, each) => sum + each.length + 1, 0);
			element.focus();
			element.setSelectionRange(offset, offset);
		},
		[area],
	);

	return { run, onKeyDown, phase, note, problemLine, goToLine };
}

/** The `{ }` button in a code box's header, with the word "Format" where the header has room. */
export function FormatButton({ format: state, withWord = false }: { format: CodeFormat; withWord?: boolean }) {
	const t = useT();
	const label = t("codeFormat.format");
	const icon =
		state.phase === "working" ? (
			<LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
		) : state.phase === "done" ? (
			<CheckIcon aria-hidden="true" className="text-green-700 dark:text-green-400" />
		) : (
			<BracesIcon aria-hidden="true" className={state.phase === "failed" ? "text-destructive" : undefined} />
		);
	return (
		<Button
			type="button"
			variant="ghost"
			size={withWord ? "sm" : "icon-sm"}
			data-format-button=""
			data-format-phase={state.phase}
			aria-label={withWord ? undefined : label}
			aria-keyshortcuts={ariaKeys("editor.format") || undefined}
			aria-busy={state.phase === "working" ? true : undefined}
			title={withKeys(label, "editor.format")}
			// Keeps the selection: Format works on the selected lines.
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => void state.run()}
		>
			{icon}
			{withWord ? (state.phase === "done" ? t("codeFormat.formatted") : label) : null}
		</Button>
	);
}

/** The line under a code box: "Formatted · 6 lines changed", "Already tidy", or why it couldn't. */
export function FormatNoteLine({ format: state, className = "" }: { format: CodeFormat; className?: string }) {
	const t = useT();
	const note = state.note;
	return (
		<p
			role="status"
			data-format-note={note?.kind ?? ""}
			className={`flex items-center gap-1 text-xs ${note?.kind === "problem" || note?.kind === "unavailable" ? "text-destructive" : "text-muted-foreground"} ${className}`}
		>
			{note === null ? null : note.kind === "problem" ? (
				<>
					<TriangleAlertIcon aria-hidden="true" className="size-3.5 flex-none" />
					<button
						type="button"
						className="focus-visible:ring-ring/50 rounded-sm text-start underline-offset-2 outline-none hover:underline focus-visible:ring-3"
						onClick={() => state.goToLine(note.line)}
					>
						{t("codeFormat.problem", { reason: note.reason, line: note.line })}
					</button>
				</>
			) : note.kind === "unavailable" ? (
				<>
					<TriangleAlertIcon aria-hidden="true" className="size-3.5 flex-none" />
					{t("codeFormat.unavailable")}
				</>
			) : (
				<>
					<CheckIcon aria-hidden="true" className="size-3.5 flex-none text-green-700 dark:text-green-400" />
					{note.kind === "tidy" ? t("codeFormat.tidy") : t("codeFormat.changed", { count: note.count })}
				</>
			)}
		</p>
	);
}
