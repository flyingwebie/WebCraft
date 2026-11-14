/**
 * Format's engine: Prettier's standalone build with its HTML, CSS and JavaScript (acorn) parsers, in
 * the house style. Loaded only when Format is first used (`format.ts` imports it on demand; a Site
 * serves it as a file of its own, `assets.ts`). Nothing here runs code it reads: no `eval`, no
 * `new Function`, so it works under the Site's strict policy (ADR 0023).
 */
import { propsBlockAt } from "@webcraft/renderer/builder";
import * as acorn from "prettier/plugins/acorn";
import * as estree from "prettier/plugins/estree";
import * as html from "prettier/plugins/html";
import * as postcss from "prettier/plugins/postcss";
import * as prettier from "prettier/standalone";

import type { CodeLanguage, FormatOptions, FormatResult } from "./format.ts";
import { guardTemplateMarkup } from "./template-guard.ts";

/** The house style (SPEC 5.1), not a setting: 2 spaces, lines up to 100, double quotes. */
export const HOUSE_STYLE = {
	printWidth: 100,
	tabWidth: 2,
	useTabs: false,
	singleQuote: false,
	semi: true,
	bracketSameLine: false,
	htmlWhitespaceSensitivity: "css",
	embeddedLanguageFormatting: "off",
	endOfLine: "lf",
} as const;

const PARSERS: Record<CodeLanguage, { parser: string; plugins: prettier.Plugin[] }> = {
	html: { parser: "html", plugins: [html] },
	css: { parser: "css", plugins: [postcss] },
	js: { parser: "acorn", plugins: [acorn, estree] },
};

/** A problem found while formatting part of the text: its line in that part, and why. */
class Unformattable extends Error {
	constructor(
		readonly line: number,
		readonly reason: string,
	) {
		super(reason);
	}
}

export async function formatCode(
	given: string,
	language: CodeLanguage,
	options: FormatOptions = {},
): Promise<FormatResult> {
	const text = given.replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	// The lines to format: those the selection touches, or all of them.
	let first = 0;
	let last = lines.length - 1;
	if (options.range && options.range.end > options.range.start) {
		first = lineIndexAt(text, options.range.start);
		// A selection ending at the start of a line doesn't take that line.
		const end = options.range.end;
		last = lineIndexAt(text, end > 0 && text[end - 1] === "\n" ? end - 1 : end);
	}
	// A Component's `{{@props}}` block isn't markup: it is kept as written.
	if (language === "html") {
		const props = propsBlockAt(text);
		if (props) {
			if (props.end < 0) return { ok: false, line: props.first + 1, reason: "{{@props}} has no {{/props}}" };
			first = Math.max(first, props.end + 1);
			if (first > last) return unchanged(given);
		}
	}
	const part = lines.slice(first, last + 1);
	const indent = Math.min(
		...part.filter((line) => line.trim() !== "").map((line) => /^ */.exec(line)?.[0].length ?? 0),
	);
	const margin = Number.isFinite(indent) ? indent : 0;
	const source = part.map((line) => line.slice(Math.min(margin, /^ */.exec(line)?.[0].length ?? 0))).join("\n");

	let formatted: string;
	try {
		formatted = await formatPart(source, language, HOUSE_STYLE.printWidth - margin);
	} catch (error) {
		if (error instanceof Unformattable) return { ok: false, line: first + error.line, reason: error.reason };
		throw error;
	}
	const pad = " ".repeat(margin);
	const placed = formatted
		.split("\n")
		.map((line) => (line === "" ? line : pad + line))
		.join("\n");
	const before = lines.slice(0, first);
	const after = lines.slice(last + 1);
	let result = [...before, placed, ...after].join("\n");
	if (result === text) return unchanged(given);
	if (given.includes("\r\n")) result = result.replace(/\n/g, "\r\n");
	return {
		ok: true,
		text: result,
		changedLines: changedLines(given.split(/\r?\n/), result.split(/\r?\n/)),
		caret: options.caret === undefined ? 0 : caretIn(given, result, options.caret),
	};
}

function unchanged(text: string): FormatResult {
	return { ok: true, text, changedLines: 0, caret: 0 };
}

/** Formats one stretch of code; throws `Unformattable` with the line (in this stretch) of a problem. */
async function formatPart(source: string, language: CodeLanguage, printWidth: number): Promise<string> {
	if (source.trim() === "") return source;
	let input = source;
	let restore = (text: string) => text;
	const lineOf = (offset: number) => lineIndexAt(source, offset) + 1;
	let lineOfLocation = (line: number, column: number) => lineOf(offsetOf(input, line, column));
	if (language === "html") {
		const guarded = guardTemplateMarkup(source);
		if (!guarded.ok) throw new Unformattable(guarded.line, guarded.reason);
		input = guarded.text;
		restore = guarded.restore;
		lineOfLocation = (line, column) => lineOf(guarded.originalOffset(offsetOf(input, line, column)));
	}
	let output: string;
	try {
		output = await prettier.format(input, { ...HOUSE_STYLE, ...PARSERS[language], printWidth });
	} catch (error) {
		const location = (error as { loc?: { start?: { line?: number; column?: number } } }).loc?.start;
		const line = location?.line ? lineOfLocation(location.line, location.column ?? 1) : 1;
		throw new Unformattable(line, reasonOf(error));
	}
	// Prettier ends the text with a line break; the box keeps the end it had.
	if (!source.endsWith("\n")) output = output.replace(/\n+$/, "");
	return restore(output);
}

/** What the parser says is wrong, without its location or the name of its error: "unexpected }". */
function reasonOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	let reason = (message.split("\n")[0] ?? "")
		.replace(/^\w*Error:\s*/, "")
		.replace(/\s*\(\d+:\d+\)\s*$/, "")
		.replace(/\. It may happen when.*$/, "")
		.replace(/\.$/, "")
		.trim();
	if (/^[A-Z][a-z]/.test(reason)) reason = reason[0]?.toLowerCase() + reason.slice(1);
	return reason || "the code can't be read";
}

/** The index of the line an offset is on. */
function lineIndexAt(text: string, offset: number): number {
	let line = 0;
	for (let index = 0; index < offset && index < text.length; index++) if (text[index] === "\n") line++;
	return line;
}

/** The offset of a 1-based line and column (Prettier's locations). */
function offsetOf(text: string, line: number, column: number): number {
	let offset = 0;
	for (let at = 1; at < line; at++) {
		const next = text.indexOf("\n", offset);
		if (next < 0) return text.length;
		offset = next + 1;
	}
	return Math.min(text.length, offset + Math.max(0, column - 1));
}

/** How many lines differ: those of the longer side outside the longest run both sides share, in order. */
function changedLines(before: readonly string[], after: readonly string[]): number {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = 0;
	while (
		end < before.length - start &&
		end < after.length - start &&
		before[before.length - 1 - end] === after[after.length - 1 - end]
	)
		end++;
	const a = before.slice(start, before.length - end);
	const b = after.slice(start, after.length - end);
	if (a.length * b.length > 4_000_000) return Math.max(a.length, b.length);
	// The longest common subsequence of the middle, one row at a time.
	let previous = new Array<number>(b.length + 1).fill(0);
	for (const line of a) {
		const row = new Array<number>(b.length + 1).fill(0);
		for (let j = 0; j < b.length; j++)
			row[j + 1] = line === b[j] ? (previous[j] ?? 0) + 1 : Math.max(row[j] ?? 0, previous[j + 1] ?? 0);
		previous = row;
	}
	const common = previous[b.length] ?? 0;
	return Math.max(a.length, b.length) - common;
}

/** Letters, digits and the like: what formatting never adds or takes away, so a caret can follow them. */
const WORD = /[\p{L}\p{N}_$]/u;

/** Where a caret in `before` is in `after`: after the same number of word characters, on the same word. */
function caretIn(before: string, after: string, caret: number): number {
	let count = 0;
	for (let index = 0; index < caret && index < before.length; index++) if (WORD.test(before[index] ?? "")) count++;
	const atWordStart = WORD.test(before[caret] ?? "") && !WORD.test(before[caret - 1] ?? "");
	let seen = 0;
	let index = 0;
	while (index < after.length && seen < count) {
		if (WORD.test(after[index] ?? "")) seen++;
		index++;
	}
	if (atWordStart) while (index < after.length && !WORD.test(after[index] ?? "")) index++;
	return index;
}
