/**
 * Inline text: the formatted text inside a Block (a paragraph, a heading, a list item, a table cell),
 * kept as runs of text that share the same marks and link, never as HTML (ADR 0018). Line breaks are
 * `\n` in a run's text.
 *
 *     [{ text: "Bake at " }, { text: "220 °C", marks: ["bold"] }, { text: "recipe", link: "/recipes/loaf" }]
 *
 * The canonical form joins neighbouring runs with the same marks and link, drops empty runs, writes
 * marks once each in `MARKS` order and leaves out `marks` and `link` when there are none, so equal
 * text is always stored the same way.
 */
import { escapeAttribute, escapeText, safeUrl } from "../escape.ts";

/** The marks a run of text can have: bold, italic, strikethrough and inline code, in this order. */
export const MARKS = ["bold", "italic", "strike", "code"] as const;

export type Mark = (typeof MARKS)[number];

/** A run of text with the same marks and link. */
export type Run = { text: string; marks?: Mark[]; link?: string };

/** Formatted text: runs in order. */
export type InlineText = Run[];

/** The longest address a link in a Block has, in characters. */
export const LINK_MAX_LENGTH = 2_000;

/** Reports a problem at a path below the value being read (`[2].text[1].link`). */
export type Report = (at: string, message: string) => void;

/** Whether a URL may be a link in a Block: one the renderer keeps as it is (a safe scheme, a path or an #anchor). */
export function isSafeLink(url: string): boolean {
	return url === "#" || safeUrl(url) !== "#";
}

/**
 * Reads formatted text: a list of runs, or text alone as a shorthand for one run without marks.
 * `oneLine` turns line breaks into spaces (a heading's text). Answers the canonical form.
 */
export function readInline(
	input: unknown,
	at: string,
	report: Report,
	options: { oneLine?: boolean; maxLength: number },
): InlineText {
	if (input === undefined || input === null) return [];
	if (typeof input === "string") return checkLength([{ text: cleanText(input, options.oneLine) }], at, report, options);
	if (!Array.isArray(input)) {
		report(at, "Formatted text is a list of runs ({ text, marks, link }) or text alone.");
		return [];
	}
	const runs: Run[] = [];
	input.forEach((item: unknown, index) => {
		const here = `${at}[${index}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			report(here, "A run of text is { text, marks, link }.");
			return;
		}
		const { text, marks, link, ...rest } = item as Record<string, unknown>;
		for (const key of Object.keys(rest)) report(`${here}.${key}`, `A run of text has no ${key}.`);
		if (typeof text !== "string") {
			report(`${here}.text`, "A run's text is text.");
			return;
		}
		const run: Run = { text: cleanText(text, options.oneLine) };
		if (marks !== undefined) {
			if (!Array.isArray(marks) || marks.some((mark) => !(MARKS as readonly unknown[]).includes(mark))) {
				report(`${here}.marks`, `Marks are ${MARKS.join(", ")}.`);
			} else {
				run.marks = marks as Mark[];
			}
		}
		if (link !== undefined && link !== null) {
			const url = typeof link === "string" ? link.trim() : "";
			if (url === "" || url.length > LINK_MAX_LENGTH || !isSafeLink(url)) {
				report(
					`${here}.link`,
					`A link goes to an http, https, mailto or tel address, a path or an #anchor (at most ${LINK_MAX_LENGTH} characters).`,
				);
			} else {
				run.link = url;
			}
		}
		runs.push(run);
	});
	return checkLength(runs, at, report, options);
}

function checkLength(runs: readonly Run[], at: string, report: Report, options: { maxLength: number }): InlineText {
	const inline = canonicalInline(runs);
	if (inlineLength(inline) > options.maxLength) report(at, `At most ${options.maxLength} characters of text.`);
	return inline;
}

/** Text as Blocks keep it: line breaks as `\n`, without control characters (tabs stay). */
function cleanText(text: string, oneLine = false): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed.
	const kept = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
	return oneLine ? kept.replace(/\n/g, " ") : kept;
}

/** The canonical form of runs: see the module's comment. */
export function canonicalInline(runs: readonly Run[]): InlineText {
	const out: Run[] = [];
	for (const run of runs) {
		if (run.text === "") continue;
		const marks = MARKS.filter((mark) => run.marks?.includes(mark));
		const next: Run = { text: run.text };
		if (marks.length > 0) next.marks = marks;
		if (run.link) next.link = run.link;
		const last = out.at(-1);
		if (last && sameFormat(last, next)) last.text += next.text;
		else out.push(next);
	}
	return out;
}

function sameFormat(a: Run, b: Run): boolean {
	return (a.link ?? "") === (b.link ?? "") && (a.marks ?? []).join() === (b.marks ?? []).join();
}

/** Formatted text as plain text. */
export function inlineText(inline: readonly Run[]): string {
	return inline.map((run) => run.text).join("");
}

/** How many characters of text formatted text has. */
export function inlineLength(inline: readonly Run[]): number {
	return inline.reduce((length, run) => length + run.text.length, 0);
}

/** Whether formatted text has any text that isn't blank. */
export function hasText(inline: readonly Run[]): boolean {
	return inline.some((run) => run.text.trim() !== "");
}

const MARK_TAGS: Readonly<Record<Mark, string>> = { bold: "strong", italic: "em", strike: "s", code: "code" };

/**
 * Formatted text as HTML: every text escaped, line breaks as `<br>`, marks as `<strong>`, `<em>`,
 * `<s>` and `<code>`, and neighbouring runs with the same link inside one `<a>`. Links keep only
 * addresses the renderer allows (anything else becomes `#`).
 */
export function renderInline(inline: readonly Run[]): string {
	let html = "";
	let index = 0;
	while (index < inline.length) {
		const link = inline[index]?.link;
		let inner = "";
		while (index < inline.length && inline[index]?.link === link) {
			inner += renderRun(inline[index] as Run);
			index++;
		}
		html += link === undefined ? inner : `<a href="${escapeAttribute(safeUrl(link))}">${inner}</a>`;
	}
	return html;
}

function renderRun(run: Run): string {
	let html = escapeText(run.text).replaceAll("\n", "<br>");
	for (const mark of [...MARKS].reverse()) {
		if (run.marks?.includes(mark)) html = `<${MARK_TAGS[mark]}>${html}</${MARK_TAGS[mark]}>`;
	}
	return html;
}
