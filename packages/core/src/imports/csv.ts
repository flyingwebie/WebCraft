/**
 * Reading CSV files for an Import, as a stream: the worker never holds a whole file in memory.
 *
 * - **Encoding**: UTF-8, with or without a byte order mark. Anything else (UTF-16 or UTF-32, with or
 *   without a byte order mark, or bytes that aren't UTF-8, such as Latin-1) is refused: guessing an
 *   encoding would put wrong letters into Entries without anyone noticing.
 * - **Separator**: a comma, a semicolon or a tab, whichever the first row (the header) holds most of
 *   outside quotes; a comma when it holds none.
 * - **Fields**: a field in double quotes may hold the separator, line breaks and quotes (written
 *   twice: `""`). Lines end with `\n`, `\r\n` or `\r`. Empty lines are skipped.
 * - **Rows** are numbered as a spreadsheet numbers them: the header is row 1, and a field holding line
 *   breaks keeps its row one row.
 */

/** What an Import takes from a CSV file at most. */
export const CSV_LIMITS = {
	/** The largest file, in bytes (10 MB). */
	maxBytes: 10 * 1024 * 1024,
	/** The most rows after the header. */
	maxRows: 10_000,
	/** The most columns. */
	maxColumns: 200,
	/** The longest field, in characters. */
	maxCellLength: 100_000,
} as const;

export const CSV_SEPARATORS = ["comma", "semicolon", "tab"] as const;

export type CsvSeparator = (typeof CSV_SEPARATORS)[number];

const SEPARATOR_CHARACTERS: Record<CsvSeparator, string> = { comma: ",", semicolon: ";", tab: "\t" };

/**
 * Why a CSV file is refused:
 * - `size`: larger than `CSV_LIMITS.maxBytes` (`maxBytes`);
 * - `encoding`: not UTF-8;
 * - `empty`: no header, or no row after it;
 * - `header`: the header leaves a column without a name, or names one twice (`column`, from 1);
 * - `quote`: a quoted field never closes (`row`);
 * - `cell`: a field longer than `CSV_LIMITS.maxCellLength` (`row`, `max`);
 * - `rows`, `columns`: more than an Import takes (`max`).
 */
export type CsvRefusal = "size" | "encoding" | "empty" | "header" | "quote" | "cell" | "rows" | "columns";

export class CsvRefusedError extends Error {
	override name = "CsvRefusedError";
	readonly reason: CsvRefusal;
	readonly params: Record<string, number>;
	constructor(reason: CsvRefusal, message: string, params: Record<string, number> = {}) {
		super(message);
		this.reason = reason;
		this.params = params;
	}
}

/** One row of a CSV file: its row number (the header is row 1) and its fields. */
export type CsvRecord = { position: number; cells: string[] };

/** What reading a whole CSV file found. */
export type CsvDetails = {
	separator: CsvSeparator;
	byteOrderMark: boolean;
	/** The rows after the header (empty lines not counted). */
	rows: number;
	/** The header's columns, each with the first row's value in it. */
	columns: { name: string; first: string }[];
};

/**
 * The records of a CSV file, header first, as the stream arrives. Throws `CsvRefusedError` for a file
 * that isn't UTF-8, a quote that never closes or a field that is too long.
 */
export async function* csvRecords(
	stream: ReadableStream<Uint8Array>,
	found: { separator?: CsvSeparator; byteOrderMark?: boolean } = {},
): AsyncGenerator<CsvRecord> {
	const text = decodedText(stream, found);
	// The separator is decided from the first row, so text is held back until it is complete.
	let pending = "";
	let separator: string | undefined;
	let parser: CsvParser | undefined;
	for await (const chunk of text) {
		if (!parser) {
			pending += chunk;
			const header = firstRow(pending);
			if (header === null) continue;
			const chosen = found.separator ?? separatorOf(header);
			found.separator = chosen;
			separator = SEPARATOR_CHARACTERS[chosen];
			parser = new CsvParser(separator);
			yield* parser.push(pending);
			pending = "";
			continue;
		}
		yield* parser.push(chunk);
	}
	if (!parser) {
		const chosen = found.separator ?? separatorOf(pending);
		found.separator = chosen;
		parser = new CsvParser(SEPARATOR_CHARACTERS[chosen]);
		yield* parser.push(pending);
	}
	yield* parser.end();
}

/**
 * Reads a whole CSV file, checking it against `CSV_LIMITS`: its separator, its columns with the first
 * row's values, and how many rows it holds. Throws `CsvRefusedError` for a file an Import can't take.
 */
export async function readCsvDetails(stream: ReadableStream<Uint8Array>): Promise<CsvDetails> {
	const found: { separator?: CsvSeparator; byteOrderMark?: boolean } = {};
	let columns: string[] | null = null;
	let first: string[] | null = null;
	let rows = 0;
	for await (const record of csvRecords(stream, found)) {
		if (!columns) {
			columns = csvColumns(record.cells);
			continue;
		}
		rows++;
		first ??= record.cells;
		if (rows > CSV_LIMITS.maxRows) {
			throw new CsvRefusedError("rows", `An Import takes at most ${CSV_LIMITS.maxRows} rows.`, {
				max: CSV_LIMITS.maxRows,
			});
		}
	}
	if (!columns || !first) throw new CsvRefusedError("empty", "The file has no rows after its header.");
	const values = first;
	return {
		separator: found.separator ?? "comma",
		byteOrderMark: found.byteOrderMark ?? false,
		rows,
		columns: columns.map((name, index) => ({ name, first: values[index] ?? "" })),
	};
}

/** The header's column names, checked: every column named, each once (whatever its case). */
export function csvColumns(cells: readonly string[]): string[] {
	if (cells.length > CSV_LIMITS.maxColumns) {
		throw new CsvRefusedError("columns", `An Import takes at most ${CSV_LIMITS.maxColumns} columns.`, {
			max: CSV_LIMITS.maxColumns,
		});
	}
	const names = cells.map((cell) => cell.trim());
	const seen = new Set<string>();
	names.forEach((name, index) => {
		const folded = name.toLocaleLowerCase();
		if (name === "" || seen.has(folded)) {
			throw new CsvRefusedError(
				"header",
				name === ""
					? `Row 1 names no column ${index + 1}: it must name every column.`
					: `Row 1 names column ${index + 1} "${name}" twice: it must name every column once.`,
				{ column: index + 1 },
			);
		}
		seen.add(folded);
	});
	return names;
}

/** Decodes a byte stream as UTF-8, refusing every other encoding. */
async function* decodedText(
	stream: ReadableStream<Uint8Array>,
	found: { byteOrderMark?: boolean },
): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const reader = stream.getReader();
	let start: Uint8Array = new Uint8Array(0);
	let started = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (!started) {
				// The first bytes say whether the file starts with a byte order mark, and which.
				if (value) start = concat(start, value);
				if (!done && start.length < 4) continue;
				started = true;
				refuseOtherEncodings(start);
				found.byteOrderMark = start[0] === 0xef && start[1] === 0xbb && start[2] === 0xbf;
				const text = decode(decoder, start.subarray(found.byteOrderMark ? 3 : 0), !done);
				if (text) yield text;
				if (done) return;
				continue;
			}
			if (done) {
				const rest = decode(decoder, new Uint8Array(0), false);
				if (rest) yield rest;
				return;
			}
			const text = decode(decoder, value, true);
			if (text) yield text;
		}
	} finally {
		reader.releaseLock();
	}
}

function decode(decoder: TextDecoder, bytes: Uint8Array, stream: boolean): string {
	let text: string;
	try {
		text = decoder.decode(bytes, { stream });
	} catch {
		throw notUtf8();
	}
	// UTF-16 without a byte order mark reads as UTF-8 full of NUL characters.
	if (text.includes("\u0000")) throw notUtf8();
	return text;
}

function refuseOtherEncodings(start: Uint8Array): void {
	const [a, b] = start;
	if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff) || (a === 0 && b === 0)) throw notUtf8();
}

function notUtf8(): CsvRefusedError {
	return new CsvRefusedError(
		"encoding",
		"The file isn't UTF-8. Save it as CSV UTF-8 (with or without a byte order mark) and upload it again.",
	);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const joined = new Uint8Array(a.length + b.length);
	joined.set(a);
	joined.set(b, a.length);
	return joined;
}

/** The first row of `text` (up to its first line break outside quotes), or null while it isn't complete. */
function firstRow(text: string): string | null {
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '"') quoted = !quoted;
		else if (!quoted && (char === "\n" || char === "\r")) {
			const row = text.slice(0, index);
			// An empty first line says nothing about the separator: look at the next one.
			if (row.trim() === "") return firstRow(text.slice(index + 1));
			return row;
		}
	}
	return null;
}

/** The separator a header uses: the one it holds most of outside quotes (a comma when none). */
function separatorOf(header: string): CsvSeparator {
	const counts: Record<CsvSeparator, number> = { comma: 0, semicolon: 0, tab: 0 };
	let quoted = false;
	for (const char of header) {
		if (char === '"') quoted = !quoted;
		else if (!quoted) {
			if (char === ",") counts.comma++;
			else if (char === ";") counts.semicolon++;
			else if (char === "\t") counts.tab++;
		}
	}
	let best: CsvSeparator = "comma";
	for (const separator of CSV_SEPARATORS) if (counts[separator] > counts[best]) best = separator;
	return best;
}

/** A CSV parser fed text in pieces: it answers each record once its line ends. */
class CsvParser {
	private readonly separator: string;
	private cells: string[] = [];
	private cell = "";
	/** Whether the current field is quoted, and whether its quote has closed. */
	private quoted = false;
	private closed = false;
	/** A closing quote ended the last piece: it may be the first of `""`, which the next piece shows. */
	private pendingQuote = false;
	/** Whether the current record has started (a separator or a character was read on it). */
	private started = false;
	/** A `\r` was the last character: a `\n` right after it belongs to the same line end. */
	private afterReturn = false;
	/** The row being read (the header is row 1), and the row its quoted field started in. */
	private position = 1;
	private quoteRow = 1;

	constructor(separator: string) {
		this.separator = separator;
	}

	*push(text: string): Generator<CsvRecord> {
		for (let index = 0; index < text.length; index++) {
			const char = text[index] as string;
			if (this.afterReturn) {
				this.afterReturn = false;
				if (char === "\n") continue;
			}
			if (this.pendingQuote) {
				this.pendingQuote = false;
				if (char === '"') {
					// It was `""` split across two pieces: a quote inside the field.
					this.closed = false;
					this.append('"');
					continue;
				}
			}
			if (this.quoted && !this.closed) {
				if (char === '"') {
					if (index + 1 === text.length) {
						this.closed = true;
						this.pendingQuote = true;
					} else if (text[index + 1] === '"') {
						this.append('"');
						index++;
					} else {
						this.closed = true;
					}
				} else if (char === "\r") {
					// Line ends inside a field are kept as \n, whichever the file uses.
					this.afterReturn = true;
					this.append("\n");
				} else {
					this.append(char);
				}
				continue;
			}
			if (char === this.separator) {
				this.endCell();
				this.started = true;
			} else if (char === "\n" || char === "\r") {
				if (char === "\r") this.afterReturn = true;
				const record = this.endRecord();
				if (record) yield record;
			} else if (char === '"' && this.cell === "" && !this.closed) {
				this.quoted = true;
				this.started = true;
				this.quoteRow = this.position;
			} else {
				this.started = true;
				this.append(char);
			}
		}
	}

	*end(): Generator<CsvRecord> {
		if (this.quoted && !this.closed) {
			throw new CsvRefusedError("quote", `A quoted field starting in row ${this.quoteRow} never closes.`, {
				row: this.quoteRow,
			});
		}
		this.pendingQuote = false;
		const record = this.endRecord();
		if (record) yield record;
	}

	private append(char: string): void {
		this.cell += char;
		if (this.cell.length > CSV_LIMITS.maxCellLength) {
			throw new CsvRefusedError(
				"cell",
				`A field in row ${this.position} is longer than ${CSV_LIMITS.maxCellLength} characters.`,
				{ row: this.position, max: CSV_LIMITS.maxCellLength },
			);
		}
	}

	private endCell(): void {
		this.cells.push(this.cell);
		this.cell = "";
		this.quoted = false;
		this.closed = false;
		this.pendingQuote = false;
	}

	/** Ends the row being read: its record, or null for an empty line (or one of empty fields only). */
	private endRecord(): CsvRecord | null {
		const position = this.position;
		this.position++;
		if (!this.started) return null;
		this.endCell();
		const cells = this.cells;
		this.cells = [];
		this.started = false;
		if (cells.every((cell) => cell === "")) return null;
		return { position, cells };
	}
}
