/**
 * Expressions: the tests Conditions run (`{{@if summary}}`, `{{@else if status == "published"}}`),
 * stored in element trees as data and run by this small interpreter, never by `eval` (ADR 0017).
 *
 * The grammar, loosest first:
 *
 *     expression := or
 *     or         := and ("or" and)*
 *     and        := not ("and" not)*
 *     not        := "not" not | comparison
 *     comparison := primary (("==" | "!=") primary)?
 *     primary    := path | "string" | number | true | false | "(" expression ")"
 *
 * A path on its own passes when its value isn't empty. Loops extend the tests (compare, contains,
 * language, date window, Loop position) by adding operators and kinds here.
 */
import { textProblem, unknownValueMessage } from "./tree.ts";
import { isPresent, sameValue, type TemplateValue } from "./values.ts";

export type Expression =
	| { type: "value"; path: string }
	| { type: "literal"; value: string | number | boolean }
	| { type: "not"; operand: Expression }
	| { type: "and"; left: Expression; right: Expression }
	| { type: "or"; left: Expression; right: Expression }
	| { type: "compare"; operator: CompareOperator; left: Expression; right: Expression };

/** How two values compare: equal or not. */
export const COMPARE_OPERATORS = ["==", "!="] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

/** Words an expression gives a meaning of its own; a value with one of these names can't be tested. */
export const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set(["and", "or", "not", "true", "false"]);

/** The deepest an expression nests. */
export const EXPRESSION_MAX_DEPTH = 32;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** A number as expressions write it: digits, with an optional sign and decimals. */
const NUMBER = /^-?\d+(?:\.\d+)?$/;

// ---------------------------------------------------------------------------------------------
// Reading an expression written in Template markup

type Token =
	| { kind: "word"; text: string; offset: number }
	| { kind: "string"; text: string; offset: number }
	| { kind: "number"; text: string; offset: number }
	| { kind: "symbol"; text: "(" | ")" | "==" | "!="; offset: number }
	| { kind: "end"; offset: number };

/** Why an expression couldn't be read, and where in its text. */
export type ExpressionProblem = { offset: number; message: string };

/** A problem reading an expression; `offset` is within the expression's text. */
class ExpressionSyntaxError extends Error {
	readonly offset: number;
	constructor(offset: number, message: string) {
		super(message);
		this.offset = offset;
	}
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		const offset = index;
		if (char === "(" || char === ")") {
			tokens.push({ kind: "symbol", text: char, offset });
			index++;
		} else if (text.startsWith("==", index) || text.startsWith("!=", index)) {
			tokens.push({ kind: "symbol", text: text.slice(index, index + 2) as "==" | "!=", offset });
			index += 2;
		} else if (char === '"') {
			let value = "";
			index++;
			for (;;) {
				if (index >= text.length) throw new ExpressionSyntaxError(offset, 'This text never ends: close it with ".');
				const next = text[index] ?? "";
				if (next === '"') break;
				if (next === "\\") {
					const escaped = text[index + 1];
					if (escaped !== '"' && escaped !== "\\") {
						throw new ExpressionSyntaxError(index, 'In text, a backslash comes before " or another backslash only.');
					}
					value += escaped;
					index += 2;
					continue;
				}
				value += next;
				index++;
			}
			index++;
			tokens.push({ kind: "string", text: value, offset });
		} else if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(text[index + 1] ?? ""))) {
			const match = /^-?\d+(?:\.\d+)?/.exec(text.slice(index))?.[0] ?? "";
			tokens.push({ kind: "number", text: match, offset });
			index += match.length;
		} else if (/[A-Za-z_]/.test(char)) {
			const match = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(index))?.[0] ?? "";
			tokens.push({ kind: "word", text: match, offset });
			index += match.length;
		} else if (char === "=") {
			throw new ExpressionSyntaxError(offset, "Compare with == (two equals signs).");
		} else {
			throw new ExpressionSyntaxError(offset, `${char} can't be used in a test.`);
		}
	}
	tokens.push({ kind: "end", offset: text.length });
	return tokens;
}

/**
 * Reads an expression written in Template markup. Answers the expression, or the first problem and
 * where it is in `text`.
 */
export function readExpression(text: string): { expression: Expression } | { problem: ExpressionProblem } {
	let tokens: Token[];
	try {
		tokens = tokenize(text);
	} catch (error) {
		if (error instanceof ExpressionSyntaxError) return { problem: { offset: error.offset, message: error.message } };
		throw error;
	}
	let index = 0;
	const peek = () => tokens[index] as Token;
	const isWord = (token: Token, word: string) => token.kind === "word" && token.text === word;
	const fail = (token: Token, message: string): never => {
		throw new ExpressionSyntaxError(token.offset, message);
	};

	// Each `and` or `or` in a chain nests the tree one level deeper, so a chain is bounded while it is
	// read: a very long one is refused before its tree is built, never walked until the stack runs out.
	const tooDeep = (): never => {
		throw new ExpressionSyntaxError(0, `A test nests at most ${EXPRESSION_MAX_DEPTH} deep.`);
	};
	const parseOr = (depth: number): Expression => {
		let left = parseAnd(depth);
		for (let chained = 1; isWord(peek(), "or"); chained++) {
			if (depth + chained > EXPRESSION_MAX_DEPTH) tooDeep();
			index++;
			left = { type: "or", left, right: parseAnd(depth) };
		}
		return left;
	};
	const parseAnd = (depth: number): Expression => {
		let left = parseNot(depth);
		for (let chained = 1; isWord(peek(), "and"); chained++) {
			if (depth + chained > EXPRESSION_MAX_DEPTH) tooDeep();
			index++;
			left = { type: "and", left, right: parseNot(depth) };
		}
		return left;
	};
	const parseNot = (depth: number): Expression => {
		if (depth > EXPRESSION_MAX_DEPTH) fail(peek(), `A test nests at most ${EXPRESSION_MAX_DEPTH} deep.`);
		if (isWord(peek(), "not")) {
			index++;
			return { type: "not", operand: parseNot(depth + 1) };
		}
		return parseComparison(depth);
	};
	const parseComparison = (depth: number): Expression => {
		const left = parsePrimary(depth);
		const next = peek();
		if (next.kind === "symbol" && (next.text === "==" || next.text === "!=")) {
			index++;
			return { type: "compare", operator: next.text, left, right: parsePrimary(depth) };
		}
		return left;
	};
	const parsePrimary = (depth: number): Expression => {
		const token = peek();
		index++;
		switch (token.kind) {
			case "string":
				return { type: "literal", value: token.text };
			case "number":
				return { type: "literal", value: canonicalNumber(Number(token.text)) };
			case "word":
				if (token.text === "true" || token.text === "false") return { type: "literal", value: token.text === "true" };
				if (EXPRESSION_KEYWORDS.has(token.text)) return fail(token, `Expected a value before ${token.text}.`);
				return { type: "value", path: token.text };
			case "symbol":
				if (token.text === "(") {
					if (depth > EXPRESSION_MAX_DEPTH) fail(token, `A test nests at most ${EXPRESSION_MAX_DEPTH} deep.`);
					const inner = parseOr(depth + 1);
					const close = peek();
					if (close.kind !== "symbol" || close.text !== ")") fail(close, "Expected ) to close the (.");
					index++;
					return inner;
				}
				return fail(token, `Expected a value before ${token.text}.`);
			case "end":
				return fail(token, "Expected a value here.");
		}
	};

	try {
		const expression = parseOr(1);
		const rest = peek();
		if (rest.kind !== "end") {
			fail(rest, `Expected and, or, == or != before ${rest.kind === "string" ? `"${rest.text}"` : rest.text}.`);
		}
		if (depthOf(expression) > EXPRESSION_MAX_DEPTH) {
			return { problem: { offset: 0, message: `A test nests at most ${EXPRESSION_MAX_DEPTH} deep.` } };
		}
		return { expression };
	} catch (error) {
		if (error instanceof ExpressionSyntaxError) return { problem: { offset: error.offset, message: error.message } };
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------
// Writing an expression as Template markup

/** How tightly each kind binds: a child that binds more loosely than its place allows is put in brackets. */
const BINDING = { or: 1, and: 2, not: 3, compare: 4, primary: 5 } as const;

/** Writes an expression as Template markup reads it, with brackets only where they are needed. */
export function writeExpression(expression: Expression): string {
	return write(expression).text;
}

function write(expression: Expression): { text: string; binding: number } {
	const at = (child: Expression, least: number) => {
		const written = write(child);
		return written.binding >= least ? written.text : `(${written.text})`;
	};
	switch (expression.type) {
		case "value":
			return { text: expression.path, binding: BINDING.primary };
		case "literal":
			return { text: writeLiteral(expression.value), binding: BINDING.primary };
		case "not":
			return { text: `not ${at(expression.operand, BINDING.not)}`, binding: BINDING.not };
		case "and":
			return {
				text: `${at(expression.left, BINDING.and)} and ${at(expression.right, BINDING.not)}`,
				binding: BINDING.and,
			};
		case "or":
			return {
				text: `${at(expression.left, BINDING.or)} or ${at(expression.right, BINDING.and)}`,
				binding: BINDING.or,
			};
		case "compare":
			return {
				text: `${at(expression.left, BINDING.primary)} ${expression.operator} ${at(expression.right, BINDING.primary)}`,
				binding: BINDING.compare,
			};
	}
}

function writeLiteral(value: string | number | boolean): string {
	if (typeof value === "string") return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	return String(value);
}

// ---------------------------------------------------------------------------------------------
// Checking a stored expression

export type CheckExpressionOptions = {
	/** Adds a problem at `at`, a path such as `nodes[0].branches[1].test.left`. */
	problem: (at: string, message: string) => void;
	/** Whether a value's path names a value the tree may read; every path is allowed when absent. */
	isKnownValue?: (path: string) => boolean;
};

/** Checks a stored expression and answers it in canonical form, or undefined after adding problems. */
export function checkExpression(input: unknown, at: string, options: CheckExpressionOptions): Expression | undefined {
	const check = (node: unknown, here: string, depth: number): Expression | undefined => {
		if (depth > EXPRESSION_MAX_DEPTH) {
			options.problem(here, `A test nests at most ${EXPRESSION_MAX_DEPTH} deep.`);
			return undefined;
		}
		const raw = (node ?? {}) as Record<string, unknown>;
		switch (raw.type) {
			case "value": {
				const path = raw.path;
				if (typeof path !== "string" || !PATH.test(path) || EXPRESSION_KEYWORDS.has(path)) {
					options.problem(`${here}.path`, "A value's path is names joined by dots, such as title or summary.");
					return undefined;
				}
				if (options.isKnownValue && !options.isKnownValue(path)) {
					options.problem(`${here}.path`, unknownValueMessage(path));
					return undefined;
				}
				return { type: "value", path };
			}
			case "literal": {
				const value = raw.value;
				if (typeof value === "string") {
					// Line breaks as an HTML parser reads them: a test is written inside the markup's text.
					const text = value.replace(/\r\n?/g, "\n");
					const refused = textProblem(text);
					if (refused) {
						options.problem(`${here}.value`, refused);
						return undefined;
					}
					return { type: "literal", value: text };
				}
				if (typeof value === "boolean") return { type: "literal", value };
				if (typeof value === "number" && NUMBER.test(String(value))) {
					return { type: "literal", value: canonicalNumber(value) };
				}
				options.problem(`${here}.value`, "A literal is text, a number written with digits, true or false.");
				return undefined;
			}
			case "not": {
				const operand = check(raw.operand, `${here}.operand`, depth + 1);
				return operand && { type: "not", operand };
			}
			case "and":
			case "or": {
				const left = check(raw.left, `${here}.left`, depth + 1);
				const right = check(raw.right, `${here}.right`, depth + 1);
				return left && right && { type: raw.type, left, right };
			}
			case "compare": {
				const operator = raw.operator;
				if (!(COMPARE_OPERATORS as readonly unknown[]).includes(operator)) {
					options.problem(`${here}.operator`, `A comparison is one of ${COMPARE_OPERATORS.join(", ")}.`);
					return undefined;
				}
				const left = check(raw.left, `${here}.left`, depth + 1);
				const right = check(raw.right, `${here}.right`, depth + 1);
				return left && right && { type: "compare", operator: operator as CompareOperator, left, right };
			}
			default:
				options.problem(here, "A test is a value, a literal, not, and, or, or a comparison.");
				return undefined;
		}
	};
	return check(input, at, 1);
}

/** The paths of the values an expression reads. */
export function expressionPaths(expression: Expression): string[] {
	switch (expression.type) {
		case "value":
			return [expression.path];
		case "literal":
			return [];
		case "not":
			return expressionPaths(expression.operand);
		case "and":
		case "or":
		case "compare":
			return [...expressionPaths(expression.left), ...expressionPaths(expression.right)];
	}
}

/** How deep an expression nests, counted as `checkExpression` counts it. */
function depthOf(expression: Expression): number {
	switch (expression.type) {
		case "value":
		case "literal":
			return 1;
		case "not":
			return 1 + depthOf(expression.operand);
		case "and":
		case "or":
		case "compare":
			return 1 + Math.max(depthOf(expression.left), depthOf(expression.right));
	}
}

/** -0 is stored as 0, so a number reads back the way it was written. */
function canonicalNumber(value: number): number {
	return value === 0 ? 0 : value;
}

// ---------------------------------------------------------------------------------------------
// Running an expression

/** Whether an expression's test passes, reading values with `read`. */
export function passes(expression: Expression, read: (path: string) => TemplateValue): boolean {
	return isPresent(evaluate(expression, read));
}

function evaluate(expression: Expression, read: (path: string) => TemplateValue): TemplateValue {
	switch (expression.type) {
		case "value":
			return read(expression.path);
		case "literal":
			return expression.value;
		case "not":
			return !passes(expression.operand, read);
		case "and":
			return passes(expression.left, read) && passes(expression.right, read);
		case "or":
			return passes(expression.left, read) || passes(expression.right, read);
		case "compare": {
			const same = sameValue(evaluate(expression.left, read), evaluate(expression.right, read));
			return expression.operator === "==" ? same : !same;
		}
	}
}
