import type { InlineText } from "@webcraft/renderer/body";
import { type KeyboardEvent, useRef, useState } from "react";

import { runsFromElement, runsToHtml } from "../../../body-editor/inline-dom.ts";

/**
 * One piece of formatted text in the block editor (a paragraph, a heading, a list item, a cell): an
 * editable element the browser types into, read back as runs on every change. It owns its text once
 * it shows: React writes the starting runs once and never again, so typing never moves the caret.
 * When the block editor changes the text itself (splitting or joining Blocks), it gives the editor a
 * new `key`, which starts it again from the new runs.
 */
export function InlineEditor({
	id,
	label,
	describedBy,
	invalid,
	lang,
	value,
	multiline = true,
	placeholder,
	className,
	register,
	onChange,
	onKeyDown,
	onFocus,
}: {
	id?: string;
	/** What it is, for screen readers: `Paragraph, block 3`. */
	label: string;
	describedBy?: string;
	invalid?: boolean;
	lang?: string;
	value: InlineText;
	/** Whether the text can hold line breaks (Shift+Enter): not in headings, summaries and cells. */
	multiline?: boolean;
	placeholder?: string;
	className?: string;
	/** Hands the element to the block editor, which moves focus and the caret between Blocks. */
	register?(element: HTMLElement | null): void;
	onChange(value: InlineText): void;
	onKeyDown?(event: KeyboardEvent<HTMLElement>, element: HTMLElement): void;
	onFocus?(element: HTMLElement): void;
}) {
	const element = useRef<HTMLDivElement | null>(null);
	const [initial] = useState(() => runsToHtml(value));
	const [empty, setEmpty] = useState(() => value.every((run) => run.text === ""));
	return (
		// biome-ignore lint/a11y/useSemanticElements: formatted text needs an editable element; no native control holds it.
		<div
			ref={(node) => {
				element.current = node;
				register?.(node);
			}}
			id={id}
			role="textbox"
			tabIndex={0}
			aria-label={label}
			aria-multiline={multiline}
			aria-describedby={describedBy}
			aria-invalid={invalid ? true : undefined}
			aria-placeholder={placeholder}
			data-placeholder={empty ? placeholder : undefined}
			lang={lang}
			contentEditable
			suppressContentEditableWarning
			spellCheck
			className={`focus-visible:ring-ring/50 data-[placeholder]:before:text-muted-foreground [&_code]:bg-muted relative min-h-[1.5em] rounded-sm whitespace-pre-wrap outline-none focus-visible:ring-3 data-[placeholder]:before:pointer-events-none data-[placeholder]:before:absolute data-[placeholder]:before:content-[attr(data-placeholder)] [&_a]:underline [&_code]:rounded-sm [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em] ${className ?? ""}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: the renderer's own HTML of the runs: escaped text and a few marks.
			dangerouslySetInnerHTML={{ __html: initial }}
			onInput={(event) => {
				const runs = runsFromElement(event.currentTarget);
				setEmpty(runs.length === 0);
				onChange(runs);
			}}
			onKeyDown={(event) => onKeyDown?.(event, event.currentTarget)}
			onFocus={(event) => {
				// The browser's commands write <b> and <i>, not inline styles.
				document.execCommand("styleWithCSS", false, "false");
				onFocus?.(event.currentTarget);
			}}
			onPaste={(event) => {
				// Pasting keeps the text, line by line; turning pasted documents into Blocks comes later.
				event.preventDefault();
				const text = event.clipboardData.getData("text/plain");
				document.execCommand("insertText", false, multiline ? text : text.replace(/\s*\n\s*/g, " "));
			}}
			onDrop={(event) => event.preventDefault()}
		/>
	);
}
