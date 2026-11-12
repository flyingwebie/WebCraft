import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useEffect, useId, useRef } from "react";
import { useT } from "../i18n.tsx";
import { editorHistory } from "./editor-history.ts";

/** A problem of markup that can't be read, where it is (UTF-16 units, as the server counts). */
export type MarkupProblem = { line: number; column: number; message: string };

/** The shared Draft as authored text, with parser locations for selection and problems. */
export function MarkupView({
	value,
	onChange,
	problems,
	selected,
	onCaret,
}: {
	selected?: { start: number; end: number };
	onCaret?(offset: number): void;
	value: string;
	onChange(value: string): void;
	problems: readonly MarkupProblem[];
}) {
	const t = useT();
	const id = useId();
	const area = useRef<HTMLTextAreaElement>(null);
	const highlight = useRef<HTMLPreElement>(null);
	// Tags may contain a quoted >; commands and text use their parser-owned extent.
	let tagEnd = selected?.end ?? 0;
	if (selected && value[selected.start] === "<") {
		let quote = "";
		for (let at = selected.start; at < selected.end; at++) {
			const char = value[at];
			if (quote) {
				if (char === quote) quote = "";
			} else if (char === '"' || char === "'") quote = char;
			else if (char === ">") {
				tagEnd = at + 1;
				break;
			}
		}
	}
	useEffect(() => {
		if (!selected || document.activeElement === area.current) return;
		const line = value.slice(0, selected.start).split("\n").length - 1;
		if (area.current && highlight.current) {
			area.current.scrollTop = Math.max(0, line * 20 - 40);
			highlight.current.scrollTop = area.current.scrollTop;
		}
	}, [selected, value]);
	const goTo = (problem: MarkupProblem) => {
		const element = area.current;
		if (!element) return;
		const lines = element.value.split("\n");
		const offset =
			lines.slice(0, problem.line - 1).reduce((sum, line) => sum + line.length + 1, 0) +
			Math.max(0, problem.column - 1);
		element.focus();
		element.setSelectionRange(offset, offset);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
			<Field className="flex min-h-0 flex-1 flex-col">
				<FieldLabel htmlFor={`${id}-markup`}>{t("builder.markup.label")}</FieldLabel>
				<FieldDescription id={`${id}-help`}>{t("builder.markup.help")}</FieldDescription>
				<div className="relative min-h-32 flex-1 overflow-hidden">
					<pre
						ref={highlight}
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 m-0 overflow-hidden rounded-md border border-transparent px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-transparent"
					>
						{selected ? (
							<>
								{value.slice(0, selected.start)}
								<mark data-selected-tag="" className="bg-amber-200 text-transparent dark:bg-amber-900">
									{value.slice(selected.start, tagEnd)}
								</mark>
								{value.slice(tagEnd)}
							</>
						) : (
							value
						)}
					</pre>
					<Textarea
						onBlur={() => editorHistory().boundary()}
						ref={area}
						id={`${id}-markup`}
						value={value}
						onChange={(event) => onChange(event.target.value)}
						onMouseUp={(event) => onCaret?.(event.currentTarget.selectionStart)}
						onKeyUp={(event) => {
							if (
								["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(
									event.key,
								)
							)
								onCaret?.(event.currentTarget.selectionStart);
						}}
						onScroll={(event) => {
							if (highlight.current) {
								highlight.current.scrollTop = event.currentTarget.scrollTop;
								highlight.current.scrollLeft = event.currentTarget.scrollLeft;
							}
						}}
						wrap="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-describedby={`${id}-help${problems.length > 0 ? ` ${id}-problems` : ""}`}
						aria-invalid={problems.length > 0 ? true : undefined}
						className="relative h-full min-h-32 w-full resize-none bg-transparent font-mono text-xs leading-5 whitespace-pre dark:bg-transparent"
					/>
				</div>
			</Field>
			<div id={`${id}-problems`} aria-live="polite" className="empty:hidden">
				{problems.length > 0 ? (
					<ul className="grid gap-1">
						{problems.map((problem, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: problems come in the order they are found.
							<li key={index} className="text-destructive text-sm">
								<button
									type="button"
									className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3"
									onClick={() => goTo(problem)}
								>
									{t("builder.markup.at", { line: problem.line, column: problem.column })}
								</button>{" "}
								{problem.message}
							</li>
						))}
					</ul>
				) : null}
			</div>
		</div>
	);
}
