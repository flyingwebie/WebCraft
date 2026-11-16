import { BracesIcon, CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type Ref, type RefObject, useMemo, useRef, useState } from "react";
import type { CodeFormat } from "../../../code-format/FormatControl.tsx";
import { type CssTokenKind, cssLines } from "../../../editor/css-tokens.ts";
import { editorHistory } from "../../../editor/editor-history.ts";
import { ariaKeys, withKeys } from "../../../editor/shortcuts.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../controls.tsx";

/** Each kind of CSS piece on the chrome's code well (each at least 4.5:1 on it). */
const TOKEN_CLASS: Record<CssTokenKind, string> = {
	"": "",
	comment: "text-chrome-faint italic",
	string: "text-green-300",
	keyword: "text-pink-300",
	variable: "text-amber-300",
	number: "text-orange-300",
	property: "text-teal-300",
	selector: "text-violet-300",
};

/**
 * A CSS box on the chrome (`places-assets/05`): line numbers in a 32 px gutter, the text highlighted
 * under a transparent text area that keeps the caret, the selection and the keyboard (Tab moves on),
 * the caret's line drawn raised and a line with a problem marked. The gutter and the highlighting are
 * hidden from assistive technology: the text area is the box.
 */
export function CodeBox({
	ref,
	value,
	onChange,
	onKeyDown,
	label,
	describedBy,
	problemLine,
	readOnly,
	data,
}: {
	ref?: Ref<HTMLTextAreaElement>;
	value: string;
	onChange?(text: string): void;
	onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
	label: string;
	describedBy?: string;
	/** The 1-based line a problem is on, marked until it is fixed. */
	problemLine?: number | null;
	readOnly?: boolean;
	data?: Record<`data-${string}`, string>;
}) {
	const gutter = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLPreElement>(null);
	const lines = useMemo(() => cssLines(value), [value]);
	const [caretLine, setCaretLine] = useState<number | null>(null);
	const followCaret = (area: HTMLTextAreaElement) => {
		const before = area.value.slice(0, area.selectionStart);
		setCaretLine(area.selectionStart === area.selectionEnd ? before.split("\n").length : null);
	};
	return (
		<div
			className="bg-chrome-well relative flex min-h-24 min-w-0 grow overflow-hidden rounded-lg font-mono text-[12px] leading-5"
			data-wc-code-box=""
		>
			<div
				ref={gutter}
				aria-hidden="true"
				className="text-chrome-faint border-chrome-line w-8 flex-none overflow-hidden border-e py-2 text-end select-none"
			>
				{lines.map((_, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: a line is its number.
						key={index}
						className={`block h-5 pe-1.5 ${
							problemLine === index + 1
								? "bg-chrome-danger text-chrome-tip"
								: caretLine === index + 1
									? "text-chrome-strong"
									: ""
						}`}
						data-wc-problem-line={problemLine === index + 1 ? "" : undefined}
					>
						{index + 1}
					</span>
				))}
			</div>
			<div className="relative min-w-0 grow">
				<pre
					ref={layer}
					aria-hidden="true"
					className="text-chrome-text pointer-events-none absolute inset-0 m-0 overflow-hidden py-2 font-mono text-[12px] leading-5 whitespace-pre"
				>
					<code>
						{lines.map((pieces, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: a line is its number.
								key={index}
								className={`block min-h-5 w-max min-w-full px-3 ${
									problemLine === index + 1
										? "bg-chrome-danger/15"
										: caretLine === index + 1 && !readOnly
											? "bg-selection/25"
											: ""
								}`}
							>
								{pieces.length
									? pieces.map(([kind, piece], at) =>
											kind ? (
												// biome-ignore lint/suspicious/noArrayIndexKey: pieces keep their order.
												<span key={at} className={TOKEN_CLASS[kind]}>
													{piece}
												</span>
											) : (
												piece
											),
										)
									: " "}
							</span>
						))}
					</code>
				</pre>
				<textarea
					ref={ref}
					aria-label={label}
					aria-describedby={describedBy}
					aria-invalid={problemLine ? true : undefined}
					readOnly={readOnly}
					value={value}
					wrap="off"
					spellCheck={false}
					autoCapitalize="off"
					autoComplete="off"
					onChange={(event) => {
						onChange?.(event.target.value);
						followCaret(event.target);
					}}
					onKeyDown={onKeyDown}
					onSelect={(event) => followCaret(event.currentTarget)}
					onBlur={() => {
						editorHistory().boundary();
						setCaretLine(null);
					}}
					onScroll={(event) => {
						const area = event.currentTarget;
						if (layer.current) {
							layer.current.scrollTop = area.scrollTop;
							layer.current.scrollLeft = area.scrollLeft;
						}
						if (gutter.current) gutter.current.scrollTop = area.scrollTop;
					}}
					className="caret-chrome-strong focus-visible:outline-chrome-focus selection:bg-selection/40 absolute inset-0 m-0 resize-none overflow-auto border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre text-transparent outline-none [-webkit-text-fill-color:transparent] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid"
					{...data}
				/>
			</div>
		</div>
	);
}

/** The `{ }` button with the word "Format" (the Styles place has room for it, SPEC 5.1). */
export function FormatControl({ format, words }: { format: CodeFormat; words: Words }) {
	const shown = words.styles.format;
	const icon =
		format.phase === "working" ? (
			<LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
		) : format.phase === "done" ? (
			<CheckIcon aria-hidden="true" className="text-chrome-ok size-3.5" />
		) : (
			<BracesIcon aria-hidden="true" className={`size-3.5 ${format.phase === "failed" ? "text-chrome-danger" : ""}`} />
		);
	return (
		<span className="group relative inline-flex">
			<button
				type="button"
				aria-keyshortcuts={ariaKeys("editor.format") || undefined}
				aria-busy={format.phase === "working" ? true : undefined}
				// Keeps the selection: Format works on the selected lines.
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => void format.run()}
				className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-flex h-6 items-center gap-1.5 rounded-[5px] px-[7px] text-[11px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
				data-format-button=""
				data-format-phase={format.phase}
			>
				{icon}
				<span className={format.phase === "done" ? "text-chrome-ok" : ""}>
					{format.phase === "done" ? shown.formatted : shown.format}
				</span>
			</button>
			<Tip label={withKeys(shown.format, "editor.format")} side="bottom" align="end" />
		</span>
	);
}

/**
 * The line under a code box: what Format did or why it couldn't (a click there puts the caret on the
 * line), else the box's own problem, else its help.
 */
export function NoteLine({
	id,
	format,
	words,
	problem,
	help,
}: {
	id?: string;
	format: CodeFormat | null;
	words: Words;
	/** The box's own problem (a rule that can't be read, a refusal), with its line when it has one. */
	problem?: { text: string; line?: number | null } | null;
	help?: string;
}) {
	const shown = words.styles.format;
	const note = format?.note ?? null;
	let content: ReactNode = help ?? "";
	let tone = "text-chrome-muted";
	if (note?.kind === "changed") {
		content = (
			<>
				<CheckIcon aria-hidden="true" className="text-chrome-ok size-3 flex-none" />
				{note.count === 1 ? shown.changedOne : fill(shown.changed, { count: String(note.count) })}
			</>
		);
	} else if (note?.kind === "tidy") {
		content = (
			<>
				<CheckIcon aria-hidden="true" className="size-3 flex-none" />
				{shown.tidy}
			</>
		);
	} else if (note?.kind === "problem" && format) {
		tone = "text-red-200";
		content = (
			<>
				<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger size-3 flex-none" />
				<button
					type="button"
					onClick={() => format.goToLine(note.line)}
					className={`rounded-sm text-start underline-offset-2 hover:underline ${FOCUS_RING}`}
				>
					{fill(shown.problem, { reason: note.reason, line: String(note.line) })}
				</button>
			</>
		);
	} else if (note?.kind === "unavailable") {
		tone = "text-red-200";
		content = (
			<>
				<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger size-3 flex-none" />
				{shown.unavailable}
			</>
		);
	} else if (problem) {
		tone = "text-red-200";
		content = (
			<>
				<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger size-3 flex-none" />
				{problem.line && format ? (
					<button
						type="button"
						onClick={() => problem.line && format.goToLine(problem.line)}
						className={`rounded-sm text-start underline-offset-2 hover:underline ${FOCUS_RING}`}
					>
						{problem.text}
					</button>
				) : (
					problem.text
				)}
			</>
		);
	}
	return (
		<p
			id={id}
			role="status"
			className={`m-0 flex min-h-[22px] items-center gap-1.5 px-0.5 text-[11px] ${tone}`}
			data-format-note={note?.kind ?? (problem ? "box" : "")}
		>
			{content}
		</p>
	);
}

/** Keeps a code box's text area reachable by its owner (Format and the quick actions use it). */
export type AreaRef = RefObject<HTMLTextAreaElement | null>;
