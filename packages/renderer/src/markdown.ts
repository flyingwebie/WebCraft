/**
 * Markdown as WebCraft writes it (`llms.txt` and Entries' Markdown copies, spec story 118): text from
 * Content is always escaped, so it reads as the words it is and never as Markdown's own syntax, and
 * nothing passes through as HTML (a `<` is written `\<`, an `&` `\&`). Addresses go in `<…>`-free
 * link destinations with spaces and parentheses percent-encoded.
 */

/** Characters escaped wherever they are: those that start or end Markdown's inline syntax, and HTML. */
const INLINE_SPECIAL = /[\\`*_[\]<>|~&]/g;

/**
 * Text as Markdown shows it, word for word: every character Markdown or HTML would read as syntax is
 * backslash-escaped (CommonMark escapes any ASCII punctuation this way), and so is what would start a
 * heading, a list, a quote or a thematic break at the start of a line. Line breaks are kept.
 */
export function escapeMarkdown(text: string): string {
	return text
		.replace(INLINE_SPECIAL, (character) => `\\${character}`)
		.split("\n")
		.map((line) => line.replace(/^(\s*)([#+\-=:])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2"))
		.join("\n");
}

/** Text on one line, escaped: line breaks and runs of spaces become one space. */
export function escapeMarkdownLine(text: string): string {
	return escapeMarkdown(text.replace(/\s+/g, " ").trim());
}

/**
 * An address as a link destination: absolute, without spaces, parentheses or angle brackets that
 * would end it early (each percent-encoded).
 */
export function markdownUrl(address: string): string {
	return address.replace(/[\s()<>]/g, (character) =>
		character === " " ? "%20" : `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

/** A link: its text escaped, its address as a link destination. */
export function markdownLink(text: string, address: string): string {
	return `[${escapeMarkdownLine(text)}](${markdownUrl(address)})`;
}
