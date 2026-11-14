/**
 * A Class as the Styles place edits it (`places-assets/05`): one rule, `.name { … }`, holding the
 * three pieces the Design system keeps apart (ADR 0009): its styles for every width (the rule's own
 * declarations), its own CSS (nested rules written with `&`, and any other conditional rule) and its
 * styles from each breakpoint up, each an `@media (width >= …px) { … }` block. `ruleOf` prints the
 * pieces as that rule; `piecesOf` reads them back, so what is typed saves to the same three pieces.
 */

/** The pieces of a Class the rule holds, as the Design system's Draft keeps them (text). */
export type RulePieces = {
	styles: string;
	css: string;
	/** Declarations from each breakpoint up, by the breakpoint's id. */
	breakpoints: Record<string, string>;
};

/** A breakpoint of the Design system: its styles apply from `width` up. */
export type RuleBreakpoint = { id: string; name: string; width: number };

/** What reading a rule gives: its pieces, or why it can't be read (and on which line). */
export type ReadRule = { ok: true; pieces: RulePieces } | { ok: false; problem: RuleProblem; line: number };

export type RuleProblem = "shape" | "name" | "unclosed";

const INDENT = "  ";

/** The query a breakpoint's block is written with: `(width >= 768px)`. */
export function breakpointQuery(width: number): string {
	return `(width >= ${width}px)`;
}

/** Each line of `text` moved in by `by`, empty lines left empty. */
function indent(text: string, by: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() ? `${by}${line}` : ""))
		.join("\n");
}

/** Each line of `text` moved out by up to `by` spaces. */
function dedent(text: string, by: number): string {
	return text
		.split("\n")
		.map((line) => line.replace(new RegExp(`^ {0,${by}}`), "").trimEnd())
		.join("\n");
}

/** A piece's text without the blank lines and spaces around it. */
function tidy(text: string): string {
	return text.replace(/^\s*\n/, "").trimEnd();
}

/**
 * The Class as one rule: its styles, then its own CSS, then its styles from each breakpoint up
 * (narrowest first), a blank line between the parts. A Class with none of them is an empty rule with
 * one line inside for the caret.
 */
export function ruleOf(name: string, pieces: RulePieces, breakpoints: readonly RuleBreakpoint[]): string {
	const parts: string[] = [];
	const styles = tidy(pieces.styles);
	if (styles) parts.push(indent(styles, INDENT));
	const css = tidy(pieces.css);
	if (css) parts.push(indent(css, INDENT));
	for (const breakpoint of [...breakpoints].sort((a, b) => a.width - b.width)) {
		const declarations = tidy(pieces.breakpoints[breakpoint.id] ?? "");
		if (!declarations) continue;
		parts.push(
			`${INDENT}@media ${breakpointQuery(breakpoint.width)} {\n${indent(declarations, INDENT + INDENT)}\n${INDENT}}`,
		);
	}
	return `.${name} {\n${parts.length ? parts.join("\n\n") : INDENT}\n}`;
}

/** One statement of a rule's body: a declaration, or a block (`prelude { … }`), where it is in the text. */
export type Statement =
	| { kind: "declaration"; start: number; end: number; text: string; property: string; value: string }
	| { kind: "block"; start: number; end: number; text: string; prelude: string; body: string };

/** What scanning a rule gives: where its body is, and its statements in order. */
export type ScannedRule = {
	/** The selector before the body's `{`, as written. */
	selector: string;
	/** Offsets of the body: just after `{`, and at the closing `}`. */
	bodyStart: number;
	bodyEnd: number;
	statements: Statement[];
};

/** The 1-based line an offset of `text` is on. */
export function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index++) if (text[index] === "\n") line++;
	return line;
}

/**
 * Reads a rule's shape: its selector, where its body is, and the body's statements (declarations end
 * at a `;` outside brackets, strings and comments; blocks at the `}` that closes them). A comment
 * goes with the statement after it.
 */
export function scanRule(text: string): ScannedRule | { problem: RuleProblem; at: number } {
	let at = skipSpace(text, 0);
	const open = findOpen(text, at);
	if (open === -1) return { problem: "shape", at };
	const selector = text.slice(at, open).trim();
	const statements: Statement[] = [];
	at = open + 1;
	for (;;) {
		const start = skipSpace(text, at);
		if (start >= text.length) return { problem: "unclosed", at: text.length };
		if (text[start] === "}") {
			if (text.slice(start + 1).trim()) return { problem: "shape", at: start + 1 };
			return { selector, bodyStart: open + 1, bodyEnd: start, statements };
		}
		const found = statementAt(text, start);
		if (!found) return { problem: "unclosed", at: start };
		statements.push(found);
		at = found.end;
	}
}

/** Where the whitespace and comments from `at` end. */
function skipSpace(text: string, at: number): number {
	let index = at;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	return index;
}

/** The first `{` from `at` outside strings and comments, or -1 (also when a `;` or `}` comes first). */
function findOpen(text: string, at: number): number {
	for (let index = at; index < text.length; index++) {
		const char = text[index];
		if (char === "/" && text[index + 1] === "*") {
			index = endOfComment(text, index);
			continue;
		}
		if (char === '"' || char === "'") {
			index = endOfString(text, index);
			continue;
		}
		if (char === "{") return index;
		if (char === ";" || char === "}") return -1;
	}
	return -1;
}

function endOfComment(text: string, at: number): number {
	const end = text.indexOf("*/", at + 2);
	return end === -1 ? text.length : end + 1;
}

function endOfString(text: string, at: number): number {
	const quote = text[at];
	for (let index = at + 1; index < text.length; index++) {
		if (text[index] === "\\") index++;
		else if (text[index] === quote || text[index] === "\n") return index;
	}
	return text.length;
}

/** The statement starting at `start`: up to its `;` (a declaration) or the `}` closing its block. */
function statementAt(text: string, start: number): Statement | null {
	let parens = 0;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (char === "/" && text[index + 1] === "*") {
			index = endOfComment(text, index);
			continue;
		}
		if (char === '"' || char === "'") {
			index = endOfString(text, index);
			continue;
		}
		if (char === "(") parens++;
		else if (char === ")") parens = Math.max(0, parens - 1);
		else if (parens > 0) continue;
		else if (char === ";") return declaration(text, start, withTrailingComment(text, index + 1));
		else if (char === "}") return declaration(text, start, index);
		else if (char === "{") {
			const close = closing(text, index);
			if (close === -1) return null;
			return {
				kind: "block",
				start,
				end: close + 1,
				text: text.slice(start, close + 1),
				prelude: withoutComments(text.slice(start, index)).trim(),
				body: text.slice(index + 1, close),
			};
		}
	}
	return declaration(text, start, text.length);
}

/** The `}` closing the `{` at `open`, or -1. */
function closing(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index++) {
		const char = text[index];
		if (char === "/" && text[index + 1] === "*") {
			index = endOfComment(text, index);
			continue;
		}
		if (char === '"' || char === "'") {
			index = endOfString(text, index);
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** A comment after a declaration on the same line belongs to it: where the declaration then ends. */
function withTrailingComment(text: string, end: number): number {
	const rest = /^[ \t]*\/\*[^\n]*?\*\//.exec(text.slice(end));
	return rest ? end + rest[0].length : end;
}

function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
}

function declaration(text: string, start: number, end: number): Statement {
	const written = text.slice(start, end);
	const plain = withoutComments(written).replace(/;\s*$/, "");
	const colon = plain.indexOf(":");
	return {
		kind: "declaration",
		start,
		end,
		text: written,
		property: (colon === -1 ? plain : plain.slice(0, colon)).trim().toLowerCase(),
		value: colon === -1 ? "" : plain.slice(colon + 1).trim(),
	};
}

/** The breakpoint a block's prelude names (`@media (width >= 768px)` or `(min-width: 768px)`), if any. */
function breakpointOf(prelude: string, breakpoints: readonly RuleBreakpoint[]): RuleBreakpoint | undefined {
	const query = /^@media\s*\(\s*(?:width\s*>=\s*([\d.]+)px|min-width\s*:\s*([\d.]+)px)\s*\)$/i.exec(prelude);
	if (!query) return undefined;
	const width = Number(query[1] ?? query[2]);
	return breakpoints.find((each) => each.width === width);
}

/**
 * Reads a rule back into the Class's pieces: the rule's own declarations are its styles; a block for
 * a breakpoint's width holding declarations only is that breakpoint's styles; anything else (nested
 * rules, other queries) is its own CSS, as written. The selector must stay the Class's own.
 */
export function piecesOf(text: string, name: string, breakpoints: readonly RuleBreakpoint[]): ReadRule {
	const scanned = scanRule(text);
	if ("problem" in scanned) return { ok: false, problem: scanned.problem, line: lineAt(text, scanned.at) };
	if (scanned.selector !== `.${name}`) return { ok: false, problem: "name", line: lineAt(text, 0) };
	const styles: string[] = [];
	const css: string[] = [];
	const byBreakpoint: Record<string, string[]> = {};
	for (const statement of scanned.statements) {
		const written = dedent(statement.text.trim(), 0);
		if (statement.kind === "declaration") {
			styles.push(withoutComments(written).trimEnd().endsWith(";") ? written : `${written};`);
			continue;
		}
		const breakpoint = breakpointOf(statement.prelude, breakpoints);
		if (breakpoint && !/[{}]/.test(withoutComments(statement.body))) {
			const body = tidy(dedent(statement.body.replace(/^[^\S\n]*\n/, ""), INDENT.length * 2));
			const parts = byBreakpoint[breakpoint.id] ?? [];
			parts.push(body);
			byBreakpoint[breakpoint.id] = parts;
			continue;
		}
		css.push(dedent(indentFirst(statement.text, text, statement.start), INDENT.length));
	}
	const pieces: RulePieces = { styles: styles.join("\n"), css: css.join("\n\n"), breakpoints: {} };
	for (const [id, parts] of Object.entries(byBreakpoint)) {
		const joined = parts.filter(Boolean).join("\n");
		if (joined) pieces.breakpoints[id] = joined;
	}
	return { ok: true, pieces };
}

/** A statement's text with the spaces before it on its first line, so every line dedents alike. */
function indentFirst(statement: string, text: string, start: number): string {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const before = text.slice(lineStart, start);
	return /^\s*$/.test(before) ? `${before}${statement}` : statement;
}

/** Whether two sets of pieces save the same: each piece compared as text. */
export function samePieces(a: RulePieces, b: RulePieces): boolean {
	const keys = new Set([...Object.keys(a.breakpoints), ...Object.keys(b.breakpoints)]);
	return (
		tidy(a.styles) === tidy(b.styles) &&
		tidy(a.css) === tidy(b.css) &&
		[...keys].every((key) => tidy(a.breakpoints[key] ?? "") === tidy(b.breakpoints[key] ?? ""))
	);
}

/** The rule with its selector changed to `.name` (after a rename), the rest as typed. */
export function renamedRule(text: string, name: string): string {
	const scanned = scanRule(text);
	if ("problem" in scanned) return text;
	const open = scanned.bodyStart - 1;
	const head = skipSpace(text, 0);
	return `${text.slice(0, head)}.${name} ${text.slice(open)}`;
}

/** The rule's own declaration of `property`, if it has one (not one inside a nested block). */
export function declarationOf(text: string, property: string): Extract<Statement, { kind: "declaration" }> | null {
	const scanned = scanRule(text);
	if ("problem" in scanned) return null;
	for (const statement of scanned.statements) {
		if (statement.kind === "declaration" && statement.property === property) return statement;
	}
	return null;
}

/**
 * The rule with its own declaration of `property` set to `value` (null removes it): changed where it
 * is, else added after the rule's last declaration (before its blocks). Answers the new text and where
 * the caret goes (after the value), or null when the rule can't be read.
 */
export function withDeclaration(
	text: string,
	property: string,
	value: string | null,
): { text: string; caret: number } | null {
	const scanned = scanRule(text);
	if ("problem" in scanned) return null;
	const found = scanned.statements.find(
		(statement): statement is Extract<Statement, { kind: "declaration" }> =>
			statement.kind === "declaration" && statement.property === property,
	);
	if (found) {
		if (value === null) {
			// The whole line goes when the declaration is alone on it.
			const lineStart = text.lastIndexOf("\n", found.start - 1) + 1;
			const lineEnd = text.indexOf("\n", found.end);
			const alone = !text.slice(lineStart, found.start).trim() && !text.slice(found.end, lineEnd).trim();
			const from = alone ? lineStart : found.start;
			const to = alone && lineEnd !== -1 ? lineEnd + 1 : found.end;
			return { text: `${text.slice(0, from)}${text.slice(to)}`, caret: from };
		}
		const written = `${property}: ${value};`;
		return {
			text: `${text.slice(0, found.start)}${written}${text.slice(found.end)}`,
			caret: found.start + written.length,
		};
	}
	if (value === null) return { text, caret: 0 };
	const declarations = scanned.statements.filter((statement) => statement.kind === "declaration");
	const last = declarations[declarations.length - 1];
	const line = `${INDENT}${property}: ${value};`;
	if (last) {
		const insertAt = last.end;
		const added = `\n${line}`;
		return { text: `${text.slice(0, insertAt)}${added}${text.slice(insertAt)}`, caret: insertAt + added.length };
	}
	// No declaration yet: the first line of the body, replacing an empty line there.
	const bodyStart = scanned.bodyStart;
	const firstLineEnd = text.indexOf("\n", bodyStart + 1);
	const firstLine = firstLineEnd === -1 ? "" : text.slice(bodyStart + 1, firstLineEnd);
	if (text[bodyStart] === "\n" && firstLineEnd !== -1 && !firstLine.trim()) {
		const next = `${text.slice(0, bodyStart + 1)}${line}${text.slice(firstLineEnd)}`;
		return { text: next, caret: bodyStart + 1 + line.length };
	}
	const added = `\n${line}${scanned.statements.length ? "\n" : ""}`;
	return {
		text: `${text.slice(0, bodyStart)}${added}${text.slice(bodyStart)}`,
		caret: bodyStart + 1 + line.length,
	};
}

/**
 * The rule with an empty `@media query { }` block added at its end, the caret inside it on its own
 * line. Null when the rule can't be read.
 */
export function withQuery(text: string, query: string): { text: string; caret: number } | null {
	const scanned = scanRule(text);
	if ("problem" in scanned) return null;
	const body = text.slice(scanned.bodyStart, scanned.bodyEnd);
	const kept = body.trimEnd();
	const lead = kept.trim() ? `${kept}\n\n` : "\n";
	const block = `${INDENT}@media ${query} {\n${INDENT}${INDENT}`;
	const before = `${text.slice(0, scanned.bodyStart)}${lead}${block}`;
	return { text: `${before}\n${INDENT}}\n${text.slice(scanned.bodyEnd)}`, caret: before.length };
}
