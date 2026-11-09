import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useId, useRef } from "react";

import { useT } from "../i18n.tsx";

/** A problem of markup that can't be read, where it is (UTF-16 units, as the server counts). */
export type MarkupProblem = { line: number; column: number; message: string };

/**
 * The Template markup view (ADR 0017): the same Draft as the builder, as text. Switching to it prints
 * the tree; switching back reads the text into the tree, with every problem's line and column (a
 * button moves the caret there). Nothing is saved until Save, and nothing is reformatted: markup
 * typed with its own line breaks comes back exactly as typed.
 */
export function MarkupView({
	value,
	onChange,
	problems,
}: {
	value: string;
	onChange(value: string): void;
	problems: readonly MarkupProblem[];
}) {
	const t = useT();
	const id = useId();
	const area = useRef<HTMLTextAreaElement>(null);
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
				<Textarea
					ref={area}
					id={`${id}-markup`}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					spellCheck={false}
					autoCapitalize="off"
					aria-describedby={`${id}-help${problems.length > 0 ? ` ${id}-problems` : ""}`}
					aria-invalid={problems.length > 0 ? true : undefined}
					className="min-h-64 flex-1 resize-none font-mono text-xs leading-5 whitespace-pre"
				/>
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
