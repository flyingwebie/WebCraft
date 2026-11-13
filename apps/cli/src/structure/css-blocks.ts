/**
 * Just enough CSS reading for the Design system's files: splitting a stylesheet into its top-level
 * blocks (`prelude { body }`), skipping comments and strings, so a Class's file can be read back
 * into its styles, breakpoint styles and own CSS. What is inside a block is never parsed: the
 * Install checks it when it is saved.
 */

/** One top-level block: its prelude (`.card`, `@media (--md)`) and the text between its braces. */
export type CssBlock = { prelude: string; body: string };

/** The top-level blocks of `text`, in order; null when a brace is left open or closed too often. */
export function topLevelBlocks(text: string): CssBlock[] | null {
	const blocks: CssBlock[] = [];
	let depth = 0;
	let prelude = "";
	let body = "";
	let index = 0;
	while (index < text.length) {
		const character = text[index] ?? "";
		const next = text[index + 1] ?? "";
		if (character === "/" && next === "*") {
			const end = text.indexOf("*/", index + 2);
			const stop = end === -1 ? text.length : end + 2;
			// Comments outside blocks are dropped; inside, they are part of the body.
			if (depth > 0) body += text.slice(index, stop);
			index = stop;
			continue;
		}
		if (character === '"' || character === "'") {
			let end = index + 1;
			while (end < text.length && text[end] !== character) end += text[end] === "\\" ? 2 : 1;
			const quoted = text.slice(index, end + 1);
			if (depth > 0) body += quoted;
			else prelude += quoted;
			index = end + 1;
			continue;
		}
		if (character === "{") {
			if (depth > 0) body += character;
			depth++;
		} else if (character === "}") {
			depth--;
			if (depth < 0) return null;
			if (depth === 0) {
				blocks.push({ prelude: prelude.trim().replace(/\s+/g, " "), body });
				prelude = "";
				body = "";
			} else body += character;
		} else if (depth > 0) body += character;
		else prelude += character;
		index++;
	}
	if (depth !== 0 || prelude.trim() !== "") return null;
	return blocks;
}

/** A block's body as stored: its lines without the indentation they share, blank lines at its ends dropped. */
export function dedent(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
	while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
	const indents = lines.filter((line) => line.trim() !== "").map((line) => /^[\t ]*/.exec(line)?.[0].length ?? 0);
	const shared = indents.length > 0 ? Math.min(...indents) : 0;
	return lines.map((line) => line.slice(Math.min(shared, /^[\t ]*/.exec(line)?.[0].length ?? 0))).join("\n");
}

/** Stored CSS written inside a block, one tab deeper than `indent`. */
export function indented(text: string, indent: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : `${indent}\t${line}`))
		.join("\n");
}
