/** Where something is in Template markup: 1-based line and column (in UTF-16 code units, as editors count). */
export type MarkupPosition = { line: number; column: number };

/** One reason Template markup was refused, and where. */
export type MarkupProblem = MarkupPosition & { message: string };

/** Something saving changed for the person to know about, such as an inline style that became a Class. */
export type MarkupNotice = MarkupPosition & { message: string };

/** The Template markup can't be saved: `problems` says what and on which line. */
export class TemplateMarkupInvalidError extends Error {
	override name = "TemplateMarkupInvalidError";
	readonly problems: readonly MarkupProblem[];
	constructor(problems: readonly MarkupProblem[]) {
		super(
			`The Template markup can't be saved: ${problems
				.map((problem) => `line ${problem.line}, column ${problem.column}: ${problem.message}`)
				.join("; ")}`,
		);
		this.problems = problems;
	}
}

/**
 * Markup with its line endings made `\n` (as HTML parsers do), and a way to turn an offset into a
 * line and column.
 */
export class MarkupSource {
	readonly text: string;
	private readonly lineStarts: number[];

	constructor(markup: string) {
		this.text = markup.replace(/\r\n?/g, "\n");
		this.lineStarts = [0];
		for (let index = 0; index < this.text.length; index++) {
			if (this.text.charCodeAt(index) === 10) this.lineStarts.push(index + 1);
		}
	}

	position(offset: number): MarkupPosition {
		let low = 0;
		let high = this.lineStarts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((this.lineStarts[middle] ?? 0) <= offset) low = middle;
			else high = middle - 1;
		}
		return { line: low + 1, column: offset - (this.lineStarts[low] ?? 0) + 1 };
	}
}
