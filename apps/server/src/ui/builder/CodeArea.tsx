import { type Ref, type TextareaHTMLAttributes, useMemo, useRef } from "react";

import { type CssTokenKind, cssLines } from "./css-tokens.ts";

/** The colour of each kind of CSS piece, in light and dark (each at least 4.5:1 on the editor's background). */
const TOKEN_CLASS: Record<CssTokenKind, string> = {
	"": "",
	comment: "text-muted-foreground italic",
	string: "text-green-700 dark:text-green-300",
	keyword: "text-pink-700 dark:text-pink-300",
	variable: "text-amber-700 dark:text-amber-300",
	number: "text-orange-700 dark:text-orange-300",
	property: "text-sky-700 dark:text-sky-300",
	selector: "text-violet-700 dark:text-violet-300",
};

/**
 * A CSS text area as Code mode's HTML and JS editors draw theirs: a line-number gutter and the
 * highlighted text under a transparent text area that keeps the caret, the selection and the
 * keyboard (Tab moves on). Lines with a problem are marked in the gutter and behind the text. The
 * gutter and the highlighting are hidden from assistive technology: the text area is the editor.
 */
export function CodeArea({
	ref,
	value,
	problemLines,
	className,
	onScroll,
	...textarea
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
	ref?: Ref<HTMLTextAreaElement>;
	value: string;
	/** The 1-based lines a problem is on. */
	problemLines?: ReadonlySet<number>;
}) {
	const gutter = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLPreElement>(null);
	const lines = useMemo(() => cssLines(value), [value]);
	return (
		<div
			data-code-area=""
			className={`bg-background relative flex min-h-32 flex-1 overflow-hidden rounded-md border font-mono text-xs leading-5 ${className ?? ""}`}
		>
			<div
				ref={gutter}
				data-gutter=""
				aria-hidden="true"
				className="text-muted-foreground w-10 flex-none overflow-hidden border-e py-2 text-end select-none"
			>
				{lines.map((_, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: a line is its number.
						key={index}
						className={`block h-5 pe-2 ${problemLines?.has(index + 1) ? "bg-destructive text-white" : ""}`}
					>
						{index + 1}
					</span>
				))}
			</div>
			<div className="relative min-w-0 flex-1">
				<pre
					ref={layer}
					aria-hidden="true"
					className="text-foreground pointer-events-none absolute inset-0 m-0 overflow-hidden px-3 py-2 font-mono text-xs leading-5 whitespace-pre"
				>
					<code>
						{lines.map((pieces, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: a line is its number.
								key={index}
								className={`block min-h-5 w-max min-w-full ${problemLines?.has(index + 1) ? "bg-destructive/15" : ""}`}
							>
								{pieces.length
									? pieces.map(([kind, piece], at) =>
											kind ? (
												// biome-ignore lint/suspicious/noArrayIndexKey: pieces keep their order.
												<span key={at} data-token={kind} className={TOKEN_CLASS[kind]}>
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
					{...textarea}
					ref={ref}
					value={value}
					wrap="off"
					spellCheck={false}
					autoCapitalize="off"
					autoComplete="off"
					className="caret-foreground placeholder:text-muted-foreground focus-visible:outline-ring absolute inset-0 m-0 resize-none overflow-auto border-0 bg-transparent px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-transparent outline-none [-webkit-text-fill-color:transparent] selection:bg-sky-500/30 placeholder:[-webkit-text-fill-color:var(--muted-foreground)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid"
					onScroll={(event) => {
						const area = event.currentTarget;
						if (layer.current) {
							layer.current.scrollTop = area.scrollTop;
							layer.current.scrollLeft = area.scrollLeft;
						}
						if (gutter.current) gutter.current.scrollTop = area.scrollTop;
						onScroll?.(event);
					}}
				/>
			</div>
		</div>
	);
}
