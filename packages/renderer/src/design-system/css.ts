/**
 * CSS that Staff write in the Design system: a Class's declarations (for every width and for each
 * breakpoint), a Class's own custom CSS, the base styles of elements and the Site-wide custom CSS.
 * Components' custom CSS (#63) is checked here too.
 *
 * Every piece is checked with a real CSS parser (css-tree) before it is stored: its syntax, that
 * each property exists and its value fits it (values using `var()` can't be checked until the page
 * runs), and the rules that keep each piece in its cascade layer and inside the Site's strict
 * Content Security Policy (ADR 0023): no `!important` (layers make it unnecessary), no `@import`,
 * no files from other hosts, nothing that ever ran script. The stylesheet is built from the parsed
 * CSS written out again, never from the text, so nothing can close a layer early.
 *
 * It is stored as written, with each reference to a token (`--primary-70`) and to a Class or utility
 * (`.card` in a selector) kept by id, so renaming one changes every use (ADR 0009).
 */
import { type CssNode, generate, lexer, parse, tokenize, tokenTypes, type WalkContext, walk } from "css-tree";

import type { TokenRef } from "./tokens.ts";

/** A piece of stored CSS: text as written, a token reference, or a Class or utility reference. */
export type CssPart = string | { token: string; step?: string } | { class: string };

/** CSS as stored: the text Staff wrote, with token and Class references by id. */
export type CssText = CssPart[];

/**
 * What a piece of CSS is: `declarations` only (a Class's styles, a base style), a Class's own
 * custom CSS (`nested`: declarations and nested rules written with `&`, such as `&:hover { … }`),
 * or a whole `stylesheet` (the Site-wide custom CSS, a Component's).
 */
export type CssKind = "declarations" | "nested" | "stylesheet";

/** One problem in a piece of CSS, where it is (1-based line and column within that piece). */
export type CssProblem = { line: number; column: number; message: string };

/** The names a piece of CSS may refer to while it is read. */
export type CssNames = {
	/** The token a custom property name (`--primary-70`) stands for. */
	token(property: string): TokenRef | undefined;
	/** The Class or utility a class name stands for, by id. */
	className(name: string): string | undefined;
};

/** The names references are written with when CSS is printed or built. */
export type CssPrintNames = {
	property(ref: TokenRef): string | undefined;
	className(id: string): string | undefined;
};

/** The longest piece of CSS one field holds, in characters. */
export const CSS_MAX_LENGTH = 100_000;

const MAX_PROBLEMS = 20;

/** At-rules each kind of CSS may hold. */
const CONDITIONAL_AT_RULES = ["media", "supports", "container", "layer", "scope", "starting-style"];
const ALLOWED_AT_RULES: Readonly<Record<CssKind, ReadonlySet<string>>> = {
	declarations: new Set(),
	nested: new Set(CONDITIONAL_AT_RULES),
	stylesheet: new Set([
		...CONDITIONAL_AT_RULES,
		"keyframes",
		"font-face",
		"property",
		"page",
		"counter-style",
		"font-feature-values",
		"font-palette-values",
		"view-transition",
		"position-try",
	]),
};

/** At-rules refused with a reason of their own. */
const REFUSED_AT_RULES: Readonly<Record<string, string>> = {
	import: "@import isn't allowed: the Site's stylesheet can't load others. Write the CSS here.",
	charset: "@charset isn't needed: stylesheets are always UTF-8.",
	namespace: "@namespace isn't allowed.",
};

/** Properties that only ever loaded script into a page. */
const SCRIPT_PROPERTIES = new Set(["behavior", "-ms-behavior", "-moz-binding"]);

/** Functions whose strings are addresses of files to load. */
const URL_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "src", "image"]);

/**
 * Reads a piece of CSS Staff wrote: answers it as stored (references by id), or every problem
 * found, each with its line and column.
 */
export function readCss(text: string, kind: CssKind, names: CssNames): { css: CssText } | { problems: CssProblem[] } {
	if (text.length > CSS_MAX_LENGTH) {
		return { problems: [{ line: 1, column: 1, message: `CSS holds at most ${CSS_MAX_LENGTH} characters.` }] };
	}
	const problems = checkCss(text, kind);
	if (problems.length > 0) return { problems: problems.slice(0, MAX_PROBLEMS) };
	return { css: withReferences(text, names) };
}

/** Writes stored CSS back as text, with today's names of the tokens and Classes it refers to. */
export function printCss(css: readonly CssPart[], names: CssPrintNames): string {
	let text = "";
	for (const part of css) {
		if (typeof part === "string") text += part;
		else if ("token" in part) text += names.property(part) ?? "--wc-missing-token";
		else text += names.className(part.class) ?? "wc-missing-class";
	}
	return text;
}

/**
 * Stored CSS as the stylesheet holds it: printed with `names`, parsed and written out again by the
 * parser (so it can't end a layer early), without comments or spaces that change nothing.
 */
export function buildCss(css: readonly CssPart[], kind: CssKind, names: CssPrintNames): string {
	const text = printCss(css, names);
	if (!text.trim()) return "";
	return generate(parse(text, { context: kind === "stylesheet" ? "stylesheet" : "declarationList" }));
}

/** Every token and Class (or utility) a piece of stored CSS refers to. */
export function referencesIn(css: readonly CssPart[]): { tokens: TokenRef[]; classes: string[] } {
	const tokens: TokenRef[] = [];
	const classes: string[] = [];
	for (const part of css) {
		if (typeof part === "string") continue;
		if ("token" in part) tokens.push(part.step === undefined ? { token: part.token } : { token: part.token, step: part.step });
		else classes.push(part.class);
	}
	return { tokens, classes };
}

/** Plain text as stored CSS: no references. */
export function plainCss(text: string): CssText {
	return text ? [text] : [];
}

function checkCss(text: string, kind: CssKind): CssProblem[] {
	const problems: CssProblem[] = [];
	const at = (node: CssNode | null | undefined, message: string) => {
		problems.push({ line: node?.loc?.start.line ?? 1, column: node?.loc?.start.column ?? 1, message });
	};
	let ast: CssNode;
	try {
		ast = parse(text, {
			context: kind === "stylesheet" ? "stylesheet" : "declarationList",
			positions: true,
			onParseError: (error) => {
				const hint = kind === "nested" ? " Nested rules start with &, such as & h2 { … } or &:hover { … }." : "";
				problems.push({ line: error.line, column: error.column, message: `${error.message}.${hint}` });
			},
		});
	} catch (error) {
		return [{ line: 1, column: 1, message: error instanceof Error ? error.message : "This isn't CSS." }];
	}
	if (problems.length > 0) return problems;

	walk(ast, function (this: WalkContext, node: CssNode) {
		switch (node.type) {
			case "Atrule": {
				const name = node.name.toLowerCase();
				const refused = REFUSED_AT_RULES[name];
				if (refused) at(node, refused);
				else if (lexer.checkAtruleName(name)) at(node, `There is no at-rule @${node.name}.`);
				else if (!ALLOWED_AT_RULES[kind].has(name.replace(/^-webkit-/, ""))) {
					at(
						node,
						kind === "declarations"
							? `@${node.name} can't go here: write declarations only, such as color: var(--primary-70);`
							: `@${node.name} can't go here.`,
					);
				}
				return;
			}
			case "Rule":
				if (kind === "declarations") {
					at(node, "Rules can't go here: write declarations only, such as color: var(--primary-70);");
				}
				return;
			case "Declaration":
				checkDeclaration(this, node, at);
				return;
			case "Url":
				checkAddress(node, node.value, at);
				return;
			case "Function": {
				const name = node.name.toLowerCase();
				if (name === "expression") at(node, "expression() isn't allowed in CSS.");
				if (URL_FUNCTIONS.has(name)) {
					node.children.forEach((child) => {
						if (child.type === "String") checkAddress(child, child.value, at);
					});
				}
				return;
			}
		}
	});
	return problems;
}

function checkDeclaration(
	context: WalkContext,
	node: Extract<CssNode, { type: "Declaration" }>,
	at: (node: CssNode, message: string) => void,
): void {
	// A test in an at-rule's prelude, such as @supports (display: grid), isn't a declaration.
	if (context.atrulePrelude) return;
	const property = node.property;
	if (node.important) {
		at(
			node,
			"!important isn't needed: base styles, Classes, utilities and custom CSS each have a cascade layer, and later layers win.",
		);
		return;
	}
	if (SCRIPT_PROPERTIES.has(property.toLowerCase())) {
		at(node, `${property} isn't allowed in CSS.`);
		return;
	}
	if (property.startsWith("--")) return;
	const atrule = context.atrule;
	const descriptor = atrule && !context.rule && lexer.getAtrule(atrule.name)?.descriptors;
	const match = descriptor ? lexer.matchAtruleDescriptor(atrule.name, property, node.value) : lexer.matchDeclaration(node);
	const error = match.error;
	if (!error || /var\(\)/.test(error.message)) return;
	if (/^Unknown (?:property|at-rule descriptor)/.test(error.message)) {
		at(node, descriptor ? `${property} isn't a descriptor of @${atrule.name}.` : `${property} isn't a CSS property.`);
	} else {
		at(node.value, `${generate(node.value)} isn't a value ${property} takes.`);
	}
}

/**
 * Styles may load only the Site's own files (an address starting with one `/`, such as
 * `/_media/…`) and refer to parts of the page (`#id`): anything else would come from another host
 * or run script, which the Site's Content Security Policy blocks.
 */
function checkAddress(node: CssNode, address: string, at: (node: CssNode, message: string) => void): void {
	const url = address.trim();
	if ((url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) || url.startsWith("#")) return;
	at(node, `${url || "An empty address"} isn't on this Site: styles may load only the Site's own files, such as /_media/….`);
}

/** The text with token and Class references kept by id: `--primary-70` and `.card` (in selectors). */
function withReferences(text: string, names: CssNames): CssText {
	const tokens: { type: number; start: number; end: number }[] = [];
	tokenize(text, (type, start, end) => tokens.push({ type, start, end }));
	const css: CssText = [];
	let plain = "";
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as { type: number; start: number; end: number };
		const value = text.slice(token.start, token.end);
		const next = tokens[index + 1];
		if (token.type === tokenTypes.Ident && value.startsWith("--")) {
			const ref = names.token(value);
			if (ref) {
				if (plain) css.push(plain);
				plain = "";
				css.push(ref.step === undefined ? { token: ref.token } : { token: ref.token, step: ref.step });
				index++;
				continue;
			}
		}
		if (token.type === tokenTypes.Delim && value === "." && next?.type === tokenTypes.Ident && next.start === token.end) {
			const classId = names.className(text.slice(next.start, next.end));
			if (classId) {
				css.push(plain + ".");
				plain = "";
				css.push({ class: classId });
				index += 2;
				continue;
			}
		}
		plain += value;
		index++;
	}
	if (plain) css.push(plain);
	return css;
}
