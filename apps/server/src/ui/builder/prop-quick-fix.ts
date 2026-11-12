import type { propsBlockAt } from "@webcraft/renderer/builder";

/**
 * The quick fix for `{{ props.x }}` when the Component has no Prop x (#134): where to declare it in
 * the markup's `{{@props}}` block (a new block at the top when there is none), and the Field type it
 * is guessed to have from where the markup reads it: an element's `src` reads media, a link's parts
 * (`props.x.url`, `props.x.text`) a link, a Condition's test alone true or false; anything else,
 * an address too, is text. The declaration is typed into the HTML panel, which saves it with the
 * rest through the usual checks. Self-contained: Code mode's asset carries it as text.
 */
export function declareMissingProp(
	markup: string,
	name: string,
	blockAt: typeof propsBlockAt,
): { type: string; at: number; text: string } {
	const path = `props\\.${name}`;
	let type = "text";
	if (new RegExp(`\\bsrc="[^"]*\\{\\{\\s*${path}\\s*\\}\\}`).test(markup)) type = "media";
	else if (new RegExp(`${path}\\.(?:url|text)\\b`).test(markup)) type = "link";
	else if (new RegExp(`\\{\\{@(?:if|elseif)\\s+(?:not\\s+)?${path}\\s*\\}\\}`).test(markup)) type = "boolean";
	const line = `  ${name}: ${type}\n`;
	// The block where the server's parser finds it (blank lines may come first): before its closing
	// line, or right after its opening one while it isn't closed yet.
	const block = blockAt(markup);
	if (!block) return { type, at: 0, text: `{{@props}}\n${line}{{/props}}\n` };
	const before = block.end >= 0 ? block.end : block.first + 1;
	const at = markup
		.split("\n")
		.slice(0, before)
		.reduce((sum, each) => sum + each.length + 1, 0);
	return { type, at: Math.min(at, markup.length), text: line };
}

/** The name of the Prop a markup problem says is missing, when it says so. */
export const MISSING_PROP = /There is no Prop named ([A-Za-z_][A-Za-z0-9_]*) on this Component/;
