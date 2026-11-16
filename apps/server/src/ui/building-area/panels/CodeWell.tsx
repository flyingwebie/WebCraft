import {
	type KeyboardEvent,
	type Ref,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { codeKeyEdit } from "../../editor/code-keys.ts";
import type { CssTokenKind } from "../../editor/css-tokens.ts";
import { editorHistory } from "../../editor/editor-history.ts";
import { matches } from "../../editor/shortcuts.ts";
import { type CodeLanguage, codeLines } from "./code-tokens.ts";

/** Each kind of piece on the chrome's code well (each at least 4.5:1 on it), as the Styles place's box. */
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

/** Lines of a box, 1-based and inclusive. */
export type LineRange = { from: number; to: number };

/**
 * A code pane's box (`builder/02`, `builder/10`): line numbers in a 32 px gutter, the text highlighted
 * under a transparent text area that keeps the caret, the selection and the keyboard (Tab moves on, as
 * in every code box of the app), the caret's line raised, the selection's lines marked (the element's
 * own lines in its source) and lines with a problem marked in red. With `wrap`, long lines wrap and
 * each line's number stays at its first row. The gutter and the highlighting are hidden from assistive
 * technology: the text area is the box. ⌘] and ⌘[ (Ctrl on other systems) indent and outdent the
 * caret's line or every line of the selection by two spaces (BA-36, as Code mode's boxes did), typed
 * in so the box's own Undo takes each back in one step.
 */
export function CodeWell({
	ref,
	language,
	value,
	onChange,
	onKeyDown,
	onBlur,
	onCaret,
	label,
	describedBy,
	problems,
	marked,
	readOnly,
	wrap,
	data,
	aria,
}: {
	ref?: Ref<HTMLTextAreaElement>;
	language: CodeLanguage;
	value: string;
	onChange?(text: string): void;
	onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
	/** The person left the box. */
	onBlur?(): void;
	/** The caret moved (an offset in the text). */
	onCaret?(offset: number): void;
	label: string;
	describedBy?: string;
	/** 1-based lines with a problem, marked until it is fixed. */
	problems?: readonly number[];
	/** The selection's lines, marked. */
	marked?: LineRange | null;
	readOnly?: boolean;
	wrap?: boolean;
	data?: Record<`data-${string}`, string>;
	/** ARIA states of the box itself (the HTML pane's suggestions: the option active, the list it controls). */
	aria?: Record<`aria-${string}`, string | undefined>;
}) {
	const area = useRef<HTMLTextAreaElement | null>(null);
	const layer = useRef<HTMLDivElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const lines = useMemo(() => codeLines(language, value), [language, value]);
	const [caretLine, setCaretLine] = useState<number | null>(null);
	const problemSet = useMemo(() => new Set(problems ?? []), [problems]);

	const setArea = useCallback(
		(element: HTMLTextAreaElement | null) => {
			area.current = element;
			if (typeof ref === "function") ref(element);
			else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = element;
		},
		[ref],
	);

	/** The highlighting follows the text area's scroll and the width its text has (its scroll bar left out). */
	const follow = useCallback(() => {
		const element = area.current;
		const drawn = layer.current;
		if (!element || !drawn) return;
		drawn.style.transform = `translateY(${-element.scrollTop}px)`;
		drawn.style.setProperty("--wc-scroll-x", `${-element.scrollLeft}px`);
		drawn.style.setProperty("--wc-code-width", `${element.clientWidth}px`);
	}, []);
	useLayoutEffect(() => {
		follow();
	});
	useEffect(() => {
		const element = area.current;
		if (!element) return;
		const observer = new ResizeObserver(follow);
		observer.observe(element);
		return () => observer.disconnect();
	}, [follow]);

	// The selection's lines are brought into view, unless the person is typing in the box.
	useEffect(() => {
		const element = area.current;
		if (!marked || !element || document.activeElement === element) return;
		const row = layer.current?.querySelector<HTMLElement>(`[data-line="${marked.from}"]`);
		if (!row) return;
		const top = row.offsetTop;
		if (top < element.scrollTop || top > element.scrollTop + element.clientHeight - 40) {
			element.scrollTop = Math.max(0, top - 20);
			follow();
		}
	}, [marked, follow]);

	const followCaret = (element: HTMLTextAreaElement) => {
		const before = element.value.slice(0, element.selectionStart);
		setCaretLine(element.selectionStart === element.selectionEnd ? before.split("\n").length : null);
		onCaret?.(element.selectionStart);
	};
	const wrapping = wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";

	return (
		<div
			ref={box}
			className="bg-chrome-well relative flex min-h-0 min-w-0 grow overflow-hidden rounded-lg font-mono text-[12px] leading-5"
			data-wc-code-well={language}
		>
			<div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
				<div ref={layer} className="py-2 will-change-transform">
					{lines.map((pieces, index) => {
						const line = index + 1;
						const isProblem = problemSet.has(line);
						const isMarked = marked ? line >= marked.from && line <= marked.to : false;
						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: a line is its number.
								key={index}
								data-line={line}
								data-wc-marked-line={isMarked ? "" : undefined}
								data-wc-problem-line={isProblem ? "" : undefined}
								className={`flex min-h-5 ${isProblem ? "bg-chrome-danger/25" : isMarked ? "bg-selection/30" : ""}`}
							>
								<span
									className={`border-chrome-line w-8 flex-none border-e pe-1.5 text-end select-none ${
										isProblem
											? "text-red-200"
											: isMarked || caretLine === line
												? "text-chrome-strong"
												: "text-chrome-faint"
									}`}
								>
									{line}
								</span>
								<span className="min-w-0 grow overflow-hidden">
									<code
										className={`text-chrome-text block px-3 ${wrapping} ${
											caretLine === line && !readOnly && !isMarked && !isProblem ? "bg-chrome-raised" : ""
										}`}
										style={{
											width: "var(--wc-code-width, 100%)",
											transform: wrap ? undefined : "translateX(var(--wc-scroll-x, 0px))",
										}}
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
									</code>
								</span>
							</div>
						);
					})}
				</div>
			</div>
			<textarea
				ref={setArea}
				aria-label={label}
				aria-describedby={describedBy}
				aria-invalid={problemSet.size > 0 ? true : undefined}
				readOnly={readOnly}
				value={value}
				wrap={wrap ? "soft" : "off"}
				spellCheck={false}
				autoCapitalize="off"
				autoComplete="off"
				onChange={(event) => {
					onChange?.(event.target.value);
					followCaret(event.target);
				}}
				onKeyDown={(event) => {
					if (indentKey(event)) return;
					onKeyDown?.(event);
				}}
				onSelect={(event) => followCaret(event.currentTarget)}
				onBlur={() => {
					editorHistory().boundary();
					setCaretLine(null);
					onBlur?.();
				}}
				onScroll={follow}
				className={`caret-chrome-strong focus-visible:outline-chrome-focus selection:bg-selection/40 absolute inset-y-0 start-8 end-0 m-0 resize-none overflow-auto border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-5 text-transparent outline-none [-webkit-text-fill-color:transparent] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid ${wrapping}`}
				{...data}
				{...aria}
			/>
		</div>
	);
}

/**
 * ⌘] / ⌘[: indents or outdents the lines the caret or the selection is on (`codeKeyEdit`, the old
 * editors' rule: two spaces in, up to two spaces or a tab out), keeping the same lines selected. Only
 * what changed is typed over, so the box's Undo gives the lines back as they were. The keys never reach
 * the browser (⌘[ would go back a page), even in a box that can't be edited.
 */
function indentKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
	const native = event.nativeEvent;
	if (!matches(native, "editor.indent") && !matches(native, "editor.outdent")) return false;
	event.preventDefault();
	const area = event.currentTarget;
	const edit = codeKeyEdit(native, area);
	if (!edit) return true;
	const text = area.value;
	const next = edit.text;
	if (next !== text) {
		let from = 0;
		while (from < text.length && from < next.length && text[from] === next[from]) from++;
		let tail = 0;
		while (
			tail < text.length - from &&
			tail < next.length - from &&
			text[text.length - 1 - tail] === next[next.length - 1 - tail]
		)
			tail++;
		const { scrollTop, scrollLeft } = area;
		area.setSelectionRange(from, text.length - tail);
		const typed = area.ownerDocument.execCommand("insertText", false, next.slice(from, next.length - tail));
		if (!typed) {
			area.setRangeText(next.slice(from, next.length - tail), from, text.length - tail, "end");
			area.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		}
		area.scrollTop = scrollTop;
		area.scrollLeft = scrollLeft;
	}
	area.setSelectionRange(edit.start, edit.end);
	return true;
}
