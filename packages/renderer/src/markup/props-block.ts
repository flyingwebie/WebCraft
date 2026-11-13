/**
 * Where a Component's `{{@props}}` block is in its markup: the line holding `{{@props}}` (the first
 * line that isn't blank, so blank lines may come before it) and the line holding `{{/props}}` (or
 * -1 when it isn't closed); null when the markup has no block. Line endings are `\n`. The one rule
 * the server's parser (`readPropDeclarations`) and the editors' Prop quick fix share; self-contained,
 * so Code mode's asset can carry it as text.
 */
export function propsBlockAt(markup: string): { first: number; end: number } | null {
	const lines = markup.split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	if (first < 0 || lines[first]?.trim() !== "{{@props}}") return null;
	return { first, end: lines.findIndex((line, index) => index > first && line.trim() === "{{/props}}") };
}
