/**
 * The Site's stylesheet (its Design system Draft compiled, `designSystem.preview`) as the Build tab's
 * sheet uses it (BA-26): the Form is drawn in a shadow root of the shell, so the Site's styles reach
 * only the Form and the shell's own styles never reach it. In a shadow root nothing is `:root`,
 * `html` or `body`, so those selectors are read as the root's host (`:host`, where the Site's tokens
 * then live) and the sheet standing in for the page's body (`[data-wcb-page]`). `@font-face` rules
 * only work in the document, so they come back apart, for the shell's document to hold.
 *
 * It is a small reader of CSS, not a parser: it keeps strings, comments and blocks whole, and changes
 * only the selectors of style rules, at the top level and inside `@media`, `@supports`, `@layer` and
 * `@container`.
 */

/** The attribute of the element that stands in for the page's body. */
export const PAGE_ATTRIBUTE = "data-wcb-page";

/** At-rules holding rules (whose blocks are read the same way); every other block is kept as it is. */
const GROUPING = /^@(?:media|supports|layer|container|scope|document|-moz-document)\b/i;

export function forShadowRoot(css: string): { css: string; fontFaces: string } {
	const fontFaces: string[] = [];
	const out = rules(css, 0, fontFaces);
	return { css: out.text, fontFaces: fontFaces.join("\n") };
}

/** Reads rules from `start` up to the `}` closing their block (or the end), answering the text and where it stopped. */
function rules(css: string, start: number, fontFaces: string[]): { text: string; end: number } {
	let text = "";
	let at = start;
	let prelude = "";
	while (at < css.length) {
		const char = css[at] as string;
		if (char === "/" && css[at + 1] === "*") {
			const close = css.indexOf("*/", at + 2);
			const end = close === -1 ? css.length : close + 2;
			prelude += css.slice(at, end);
			at = end;
			continue;
		}
		if (char === '"' || char === "'") {
			const end = stringEnd(css, at);
			prelude += css.slice(at, end);
			at = end;
			continue;
		}
		if (char === "}") return { text: text + prelude, end: at };
		if (char === ";") {
			// A statement at-rule (`@layer a, b;`, `@import …;`): kept as it is.
			text += `${prelude};`;
			prelude = "";
			at++;
			continue;
		}
		if (char === "{") {
			const head = prelude.trim();
			if (/^@font-face\b/i.test(head)) {
				const end = blockEnd(css, at);
				fontFaces.push(`${head}${css.slice(at, end)}`);
				prelude = "";
				at = end;
				continue;
			}
			if (GROUPING.test(head)) {
				const inner = rules(css, at + 1, fontFaces);
				text += `${prelude}{${inner.text}}`;
				prelude = "";
				at = inner.end + 1;
				continue;
			}
			const end = blockEnd(css, at);
			text += `${head.startsWith("@") ? prelude : selectors(prelude)}${css.slice(at, end)}`;
			prelude = "";
			at = end;
			continue;
		}
		prelude += char;
		at++;
	}
	return { text: text + prelude, end: at };
}

/** Where the string starting at `start` ends (after its closing quote). */
function stringEnd(css: string, start: number): number {
	const quote = css[start];
	let at = start + 1;
	while (at < css.length && css[at] !== quote) at += css[at] === "\\" ? 2 : 1;
	return Math.min(at + 1, css.length);
}

/** Where the block opening at `open` ends (after its closing brace), strings and comments kept whole. */
function blockEnd(css: string, open: number): number {
	let depth = 0;
	let at = open;
	while (at < css.length) {
		const char = css[at];
		if (char === "/" && css[at + 1] === "*") {
			const close = css.indexOf("*/", at + 2);
			at = close === -1 ? css.length : close + 2;
			continue;
		}
		if (char === '"' || char === "'") {
			at = stringEnd(css, at);
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return at + 1;
		}
		at++;
	}
	return css.length;
}

/** What may follow `:root`, `html` or `body` in the same compound selector: attributes and pseudo-classes. */
const COMPOUND = String.raw`((?:\[[^\]]*\]|:(?:not|is|where|has)\((?:[^()]|\([^()]*\))*\)|:[a-z-]+)*)`;
const ROOT = new RegExp(String.raw`(^|[\s>+~(,])(?::root|html)(?![\w-])${COMPOUND}`, "gi");
const BODY = /(^|[\s>+~(,])body(?![\w-])/gi;

/** A style rule's selectors, with `:root` and `html` read as the host and `body` as the sheet. */
function selectors(prelude: string): string {
	return prelude
		.replace(
			ROOT,
			(_whole, before: string, compound: string) => `${before}${compound ? `:host(${compound})` : ":host"}`,
		)
		.replace(BODY, (_whole, before: string) => `${before}[${PAGE_ATTRIBUTE}]`);
}
