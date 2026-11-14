import { type AttributePart, isValuePath, readFormat, writeFormat } from "@webcraft/renderer/builder";
import { BracesIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

/**
 * The parts of the Props, Loop, Condition and Component panels (BA-09; `builder/05`, `06`, `07`): a
 * raised card with a small label over its value, text that commits on Enter and when left (and goes
 * back on Escape), a switch, and value completion: typing `{{` in a value offers what may be read
 * there (a Loop's item, the Entry's Fields, the Globals, Props), as a listbox under the box.
 */

/** A raised card with its label above its value (`builder/05`'s Prop fields). */
export function FieldCard({
	label,
	htmlFor,
	aside,
	children,
}: {
	label: string;
	htmlFor?: string;
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="bg-chrome-raised flex min-w-0 flex-col gap-1 rounded-md px-2 pt-1.5 pb-2" data-wc-field-card="">
			<div className="flex items-baseline justify-between gap-2">
				{htmlFor ? (
					<label htmlFor={htmlFor} className="text-chrome-muted text-[11px]">
						{label}
					</label>
				) : (
					<span className="text-chrome-muted text-[11px]">{label}</span>
				)}
				{aside}
			</div>
			{children}
		</div>
	);
}

export const INPUT =
	"w-full min-w-0 rounded-[4px] bg-transparent text-[12px] font-medium text-chrome-strong placeholder:text-chrome-faint disabled:text-chrome-muted outline-none focus-visible:ring-2 focus-visible:ring-chrome-focus";

/** What a value's completion offers: paths a binding may read, each with its label when it has one. */
export type ValueChoice = { path: string; label?: string | null };

/** The `{{` being typed just before the caret, and what has been typed of its path: null outside one. */
export function openBinding(text: string, caret: number): { start: number; typed: string } | null {
	const before = text.slice(0, caret);
	const match = /\{\{\s*([\w.@-]*)$/.exec(before);
	if (!match || before.slice(0, match.index).endsWith("\\")) return null;
	return { start: match.index, typed: match[1] ?? "" };
}

/** The choices whose path starts with (or contains) what has been typed, the closest first. */
export function choicesFor(choices: readonly ValueChoice[], typed: string, limit = 8): ValueChoice[] {
	const wanted = typed.toLowerCase();
	const starts = choices.filter((choice) => choice.path.toLowerCase().startsWith(wanted));
	const contains = choices.filter(
		(choice) => !choice.path.toLowerCase().startsWith(wanted) && choice.path.toLowerCase().includes(wanted),
	);
	return [...starts, ...contains].slice(0, limit);
}

/**
 * A text box that commits on Enter and when left, and goes back to the stored value on Escape. With
 * `values`, typing `{{` opens the value completion (a combobox): the arrows move through it, Enter or
 * Tab takes one (`{{ post.title }}`), Escape closes it.
 */
export function CommitInput({
	id,
	value,
	onCommit,
	disabled,
	placeholder,
	mono,
	label,
	values,
	valuesLabel,
	multiline,
	type = "text",
}: {
	id?: string;
	value: string;
	/** The new value; answers whether it was taken (else the box keeps what was typed). */
	onCommit(value: string): boolean | undefined;
	disabled?: boolean;
	placeholder?: string;
	mono?: boolean;
	label?: string;
	values?: readonly ValueChoice[];
	/** The completion's heading ("Values"). */
	valuesLabel?: string;
	multiline?: boolean;
	type?: "text" | "number" | "date" | "email" | "url";
}) {
	const [text, setText] = useState(value);
	const [open, setOpen] = useState<{ start: number; typed: string } | null>(null);
	const [active, setActive] = useState(0);
	const box = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	const listId = useId();
	useEffect(() => setText(value), [value]);
	const shown = open && values ? choicesFor(values, open.typed) : [];
	const listOpen = shown.length > 0;

	const commit = () => {
		if (text !== value && onCommit(text) === false) return;
	};
	const look = (next: string, caret: number) => {
		setText(next);
		if (!values) return;
		const found = openBinding(next, caret);
		setOpen(found);
		setActive(0);
	};
	const take = (choice: ValueChoice) => {
		if (!open) return;
		const caret = box.current?.selectionStart ?? text.length;
		const after = text.slice(caret).replace(/^[\w.@-]*\s*(\}\})?/, "");
		const inserted = `{{ ${choice.path} }}`;
		const next = `${text.slice(0, open.start)}${inserted}${after}`;
		setText(next);
		setOpen(null);
		requestAnimationFrame(() => {
			const at = open.start + inserted.length;
			box.current?.setSelectionRange(at, at);
		});
	};

	const common = {
		ref: box,
		id,
		"aria-label": label,
		value: text,
		disabled,
		placeholder,
		spellCheck: false,
		autoComplete: "off",
		...(values
			? {
					role: "combobox",
					"aria-autocomplete": "list" as const,
					"aria-expanded": listOpen,
					"aria-controls": listOpen ? listId : undefined,
					"aria-activedescendant": listOpen ? `${listId}-${active}` : undefined,
				}
			: {}),
		onChange: (event: { target: { value: string; selectionStart: number | null } }) =>
			look(event.target.value, event.target.selectionStart ?? event.target.value.length),
		onBlur: () => {
			setOpen(null);
			commit();
		},
		onKeyDown: (event: React.KeyboardEvent) => {
			if (listOpen) {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					setActive((at) => (at + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
					return;
				}
				if (event.key === "Enter" || event.key === "Tab") {
					const choice = shown[active];
					if (choice) {
						event.preventDefault();
						take(choice);
					}
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					setOpen(null);
					return;
				}
			}
			if (event.key === "Enter" && !(multiline && event.shiftKey)) {
				event.preventDefault();
				commit();
			}
			if (event.key === "Escape" && text !== value) {
				event.preventDefault();
				event.stopPropagation();
				setText(value);
			}
		},
		className: `${INPUT} ${mono ? "font-mono" : ""} ${multiline ? "min-h-[54px] resize-y leading-[18px]" : ""}`,
	};

	return (
		<div className="relative min-w-0">
			{multiline ? <textarea rows={3} {...common} /> : <input type={type} {...common} />}
			{listOpen ? (
				<div
					className="absolute start-0 top-full z-20 mt-1 flex w-[200px] max-w-[calc(100vw-16px)] flex-col gap-0.5 rounded-lg border border-[#2a2a30] bg-[#18181b] p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
					data-wc-values=""
				>
					{valuesLabel ? (
						<p className="text-chrome-muted px-2 pt-0.5 pb-1 text-[11px] font-semibold tracking-[0.06em] uppercase">
							{valuesLabel}
						</p>
					) : null}
					<div role="listbox" id={listId} aria-label={valuesLabel}>
						{shown.map((choice, index) => (
							<div
								key={choice.path}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === active}
								tabIndex={-1}
								// The box keeps focus: a pointer press takes the value without blurring it.
								onPointerDown={(event) => {
									event.preventDefault();
									take(choice);
								}}
								onKeyDown={() => {}}
								className={`flex h-[26px] cursor-default items-center gap-2 rounded-[5px] px-2 ${
									index === active ? "bg-chrome-hover" : ""
								}`}
								title={choice.label ?? undefined}
							>
								<BracesIcon aria-hidden="true" className="size-3 shrink-0 text-[#fbbf24]" />
								<span className="text-chrome-text truncate font-mono text-[12px]">{choice.path}</span>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** A switch (`builder/05`'s "Show rating"): its state in words beside it. */
export function Switch({
	checked,
	onChange,
	label,
	disabled,
	on,
	off,
}: {
	checked: boolean;
	onChange(checked: boolean): void;
	label: string;
	disabled?: boolean;
	on: string;
	off: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`flex w-fit items-center gap-2 rounded-[4px] text-[12px] ${FOCUS_RING}`}
		>
			<span
				aria-hidden="true"
				className={`relative inline-block h-[15px] w-[26px] rounded-full ${CHROME_EASE} ${
					checked ? "bg-[#16a34a]" : "bg-[#3f3f46]"
				}`}
			>
				<span
					className={`absolute top-[2px] size-[11px] rounded-full bg-white ${CHROME_EASE} ${
						checked ? "start-[13px]" : "start-[2px]"
					}`}
				/>
			</span>
			<span className="text-chrome-muted">{checked ? on : off}</span>
		</button>
	);
}

/** A note in a panel: muted, or a warning (`builder/05`'s "On 4 pages…"). */
export function Note({ children, warn, icon }: { children: ReactNode; warn?: boolean; icon?: ReactNode }) {
	return warn ? (
		<p
			className="text-chrome-warn flex gap-2 rounded-md bg-[#422006] p-2 text-[12px] leading-[16px]"
			data-wc-warning=""
		>
			{icon}
			<span className="grow">{children}</span>
		</p>
	) : (
		<p className="text-chrome-muted px-1 py-1 text-[12px] leading-[16px]">{children}</p>
	);
}

/**
 * An attribute's value as the Inspector shows it: fixed text, and each value as `{{ path }}` (with its
 * formatter, `{{ path | date: long }}`); a literal `{{` is written `\{{`. Read back the same way. The
 * Template markup parser would do this too, but it is large for the shell's bundle; the server checks
 * every tree it saves either way.
 */
export function printParts(parts: readonly AttributePart[]): string {
	return parts
		.map((part) =>
			part.type === "text"
				? part.text.replaceAll("{{", "\\{{")
				: `{{ ${part.path}${part.format ? ` | ${writeFormat(part.format)}` : ""} }}`,
		)
		.join("");
}

/** Reads what `printParts` writes; the problem is the value it couldn't read, or its formatter's problem. */
export function readParts(text: string): { parts: AttributePart[] } | { problem: string } {
	const parts: AttributePart[] = [];
	let literal = "";
	let at = 0;
	for (const match of text.matchAll(/\\\{\{|\{\{([^}]*)\}\}/g)) {
		literal += text.slice(at, match.index);
		at = match.index + match[0].length;
		if (match[0] === "\\{{") {
			literal += "{{";
			continue;
		}
		const [path = "", format] = (match[1] ?? "").split("|").map((piece) => piece.trim());
		if (!isValuePath(path)) return { problem: match[0] };
		const read = format === undefined ? null : readFormat(format);
		if (read && "problem" in read) return { problem: read.problem };
		if (literal) parts.push({ type: "text", text: literal });
		literal = "";
		parts.push({ type: "value", path, ...(read ? { format: read.format } : {}) });
	}
	literal += text.slice(at);
	if (literal) parts.push({ type: "text", text: literal });
	return { parts };
}
