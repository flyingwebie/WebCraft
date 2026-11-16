/**
 * Format: tidying the code in a code box with Prettier, in one house style (SPEC 5.1). The one module
 * every code box uses, in the admin, the Builder, Code mode and the building area:
 *
 * ```ts
 * const result = await format(text, "html", { range, caret });
 * if (result.ok) use(result.text, result.changedLines, result.caret);
 * else mark(result.line, result.reason);
 * ```
 *
 * - `language`: `html` is Template markup (values, Template commands and Component tags kept whole,
 *   see `template-guard.ts`), `css` a stylesheet or bare declarations, `js` a script.
 * - `range`: with a selection, only the lines it touches are formatted (each kept at its indentation);
 *   without one, the whole text.
 * - `caret`: an offset in `text`; the answer says where it is in the new text, on the same word.
 *
 * The answer is the new text and how many of its lines changed (0: it was already tidy), or a problem
 * and the 1-based line it is on (nothing changed). Prettier is loaded the first time this is called
 * (`engine.ts`, a file of its own: in the admin a chunk of the bundle, on a Site a hashed file served
 * from the Site's domain like the other editor scripts, ADR 0023), then formats at once.
 */
export type CodeLanguage = "html" | "css" | "js";

export type FormatOptions = {
	/** The selection, as offsets in the text: only the lines it touches are formatted. */
	range?: { start: number; end: number };
	/** Where the caret is in the text. */
	caret?: number;
};

export type FormatResult =
	| {
			ok: true;
			text: string;
			/** How many lines of the new text differ from the text given: 0 when it was already tidy. */
			changedLines: number;
			/** Where the caret given is in the new text (on the same word); 0 when none was given. */
			caret: number;
	  }
	| {
			ok: false;
			/** The 1-based line of the text given that the problem is on. */
			line: number;
			/** What is wrong, as the parser says it ("unexpected }"). */
			reason: string;
	  };

/** What the engine module exports: the same call, once Prettier is there. */
export type FormatEngine = {
	formatCode(text: string, language: CodeLanguage, options?: FormatOptions): Promise<FormatResult>;
};

let engine: Promise<FormatEngine> | undefined;

/** Tidies `text` in the house style (see the top of this file). */
export async function format(text: string, language: CodeLanguage, options: FormatOptions = {}): Promise<FormatResult> {
	engine ??= import("./engine.ts").catch((failure: unknown) => {
		engine = undefined;
		throw failure;
	});
	return (await engine).formatCode(text, language, options);
}
