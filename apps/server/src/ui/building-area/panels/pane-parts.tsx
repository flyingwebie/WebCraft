import { BracesIcon, CheckIcon, LoaderCircleIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useEffect } from "react";

import { ariaKeys, shortcutText } from "../../builder/shortcuts.ts";
import type { CodeFormat } from "../../code-format/FormatControl.tsx";
import type { Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { type PaneStore, paneStore, usePane } from "./pane-store.ts";

/**
 * What the three code panes share (BA-11): the `{ }` Format button of a pane's header (SPEC 5.1,
 * `builder/10`: at rest, a spinner after 150 ms, a check for 2 s, red when the code is broken), the
 * Expand button after it, and the boxes' settings from the pane's menu.
 */

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
