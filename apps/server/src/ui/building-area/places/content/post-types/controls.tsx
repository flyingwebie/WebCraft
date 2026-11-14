import { LockIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";

/**
 * What the Post Types parts of the Content place draw with (`places-content/02` and `03`): the
 * setting cards of the details panel (a label over its value, 8 px in, radius 6), a switch, text and
 * number settings that save when they are left (or after a pause), and the words for why something
 * wasn't saved.
 */

/** A text box on a card: no box of its own, the card is the box. */
export const BARE_INPUT =
	"text-chrome-strong placeholder:text-chrome-muted w-full min-w-0 rounded-sm bg-transparent text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-chrome-focus";

/** How long after the last key a setting is saved (as the Globals form saves values). */
export const SAVE_AFTER_MS = 800;

/** A setting's card: its label above its value, a problem under it, help under that. */
export function Card({
	label,
	htmlFor,
	children,
	problem,
	help,
	helpId,
	trailing,
	grow,
	data,
}: {
	label: string;
	/** The control the label names; none for a group of controls (the card is then a group). */
	htmlFor?: string;
	children: ReactNode;
	problem?: string | null;
	help?: string;
	helpId?: string;
	trailing?: ReactNode;
	grow?: boolean;
	data?: Record<`data-${string}`, string>;
}) {
	const problemId = useId();
	const look = `bg-chrome-raised flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 ${grow ? "flex-1" : "w-full"} ${
		problem ? "ring-chrome-danger ring-1" : ""
	}`;
	const caption = "text-chrome-muted p-0 text-[11px] font-medium";
	const rest = (
		<>
			<div className="flex min-h-5 items-center gap-2">
				<div className="min-w-0 grow">{children}</div>
				{trailing}
			</div>
			{problem ? (
				<p id={problemId} role="alert" className="text-chrome-danger m-0 text-[11px]">
					{problem}
				</p>
			) : null}
			{help ? (
				<p id={helpId} className="text-chrome-muted m-0 text-[11px]">
					{help}
				</p>
			) : null}
		</>
	);
	// One control: its label names it. Several, or a value that can't change: a fieldset names them.
	return htmlFor ? (
		<div className={look} {...data}>
			<label htmlFor={htmlFor} className={caption}>
				{label}
			</label>
			{rest}
		</div>
	) : (
		<fieldset className={`${look} m-0 border-0`} {...data}>
			<legend className={`${caption} float-start w-full`}>{label}</legend>
			{rest}
		</fieldset>
	);
}

/** A value that can't change (a key, a kind), with a lock and why. */
export function Locked({ value, why, mono }: { value: string; why: string; mono?: boolean }) {
	const id = useId();
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span
				aria-describedby={id}
				className={`text-chrome-strong min-w-0 grow truncate text-[12px] font-medium ${mono ? "font-mono" : ""}`}
			>
				{value}
			</span>
			<LockIcon aria-hidden="true" className="text-chrome-muted size-3 shrink-0" />
			<span id={id} className="sr-only">
				{why}
			</span>
		</span>
	);
}

/** A switch (`role="switch"`), its state in words beside it. */
export function Switch({
	id,
	checked,
	onChange,
	words,
	disabled,
	describedBy,
	data,
}: {
	id?: string;
	checked: boolean;
	onChange(checked: boolean): void;
	words: { on: string; off: string };
	disabled?: boolean;
	describedBy?: string;
	data?: Record<`data-${string}`, string>;
}) {
	return (
		<span className="flex items-center justify-between gap-2">
			<span className="text-chrome-strong text-[12px] font-medium" aria-hidden="true">
				{checked ? words.on : words.off}
			</span>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				aria-describedby={describedBy}
				disabled={disabled}
				onClick={() => onChange(!checked)}
				{...data}
				className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full disabled:opacity-50 ${
					checked ? "bg-primary" : "bg-chrome-hover"
				} ${CHROME_EASE} ${FOCUS_RING}`}
			>
				<span
					aria-hidden="true"
					className={`bg-chrome-strong absolute top-0.5 size-3 rounded-full ${checked ? "end-0.5" : "start-0.5"}`}
				/>
			</button>
		</span>
	);
}

/**
 * A text setting: its value saved 0.8 s after typing stops, when it is left and on Enter (`onSave`
 * with the text); a new value from outside (another save) shows when the box isn't being typed in.
 */
export function TextSetting({
	id,
	value,
	onSave,
	placeholder,
	mono,
	multiline,
	maxLength,
	describedBy,
	invalid,
	data,
}: {
	id: string;
	value: string;
	onSave(text: string): void;
	placeholder?: string;
	mono?: boolean;
	multiline?: boolean;
	maxLength?: number;
	describedBy?: string;
	invalid?: boolean;
	data?: Record<`data-${string}`, string>;
}) {
	const [text, setText] = useState(value);
	const typing = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latest = useRef({ text, value, onSave });
	latest.current = { text, value, onSave };

	useEffect(() => {
		if (!typing.current) setText(value);
	}, [value]);

	// It reads only refs, so it is the same function for the setting's life.
	const flush = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		typing.current = false;
		const { text: now, value: saved, onSave: save } = latest.current;
		if (now !== saved) save(now);
	}, []);

	// What waits is saved when the setting goes (another Field chosen, the place left).
	useEffect(
		() => () => {
			if (timer.current) flush();
		},
		[flush],
	);

	const change = (next: string) => {
		typing.current = true;
		setText(next);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(flush, SAVE_AFTER_MS);
	};

	const shared = {
		id,
		value: text,
		placeholder,
		maxLength,
		"aria-describedby": describedBy,
		"aria-invalid": invalid || undefined,
		onBlur: flush,
		className: `${BARE_INPUT} ${mono ? "font-mono" : ""}`,
		...data,
	};
	return multiline ? (
		<textarea
			{...shared}
			rows={2}
			onChange={(event) => change(event.target.value)}
			className={`${shared.className} resize-y`}
		/>
	) : (
		<input
			{...shared}
			type="text"
			onChange={(event) => change(event.target.value)}
			onKeyDown={(event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				flush();
			}}
		/>
	);
}

/** A number setting (empty: none), saved as `TextSetting` saves text. */
export function NumberSetting({
	id,
	value,
	onSave,
	describedBy,
	invalid,
}: {
	id: string;
	value: number | null;
	onSave(value: number | null): void;
	describedBy?: string;
	invalid?: boolean;
}) {
	return (
		<TextSetting
			id={id}
			value={value === null ? "" : String(value)}
			describedBy={describedBy}
			invalid={invalid}
			onSave={(text) => {
				const trimmed = text.trim();
				const number = trimmed === "" ? null : Number(trimmed);
				onSave(number === null || Number.isNaN(number) ? null : number);
			}}
		/>
	);
}

/** An error's code, as the API answers it. */
export function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/** Why a call failed, in the person's words. */
export function reasonText(words: Words, error: unknown): string {
	const reasons = words.postTypes.reasons;
	const code = codeOf(error);
	switch (code) {
		case "POST_TYPE_TAKEN":
			return reasons.taken;
		case "PATH_TAKEN":
			return reasons.pathTaken;
		case "POST_TYPE_INVALID":
			return reasons.invalid;
		case "POST_TYPE_IN_USE":
			return reasons.inUse;
		case "CONFIRMATION_INVALID":
			return reasons.confirmation;
		case "FORBIDDEN":
			return reasons.forbidden;
		case "network":
			return reasons.network;
		default:
			return fill(reasons.generic, { code });
	}
}

/** A problem the server answered with a setting (`POST_TYPE_INVALID`'s `problems`). */
export type Problem = { at: string; rule?: string; message: string };

/** The problems of a `POST_TYPE_INVALID` refusal; none for any other. */
export function problemsOf(error: unknown): Problem[] {
	if (codeOf(error) !== "POST_TYPE_INVALID") return [];
	const problems = (error as { data?: { problems?: unknown } }).data?.problems;
	return Array.isArray(problems) ? (problems as Problem[]) : [];
}

/** A problem in the person's words: the rules the place words, else a plain "can't be saved". */
export function problemText(words: Words, problem: Problem): string {
	const shown = words.postTypes.problems;
	const rule = problem.rule ?? "";
	if (rule in shown) return shown[rule as keyof typeof shown];
	if (problem.at === "urlPattern") return shown.urlPattern;
	return shown.generic;
}
