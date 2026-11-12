/**
 * The quick fix for `{{ props.x }}` when the Component has no Prop x (#134): where to declare it in
 * the markup's `{{@props}}` block (a new block at the top when there is none), and the Field type it
 * is guessed to have from where the markup reads it: an element's `src` reads media, a link's parts
 * (`props.x.url`, `props.x.text`) a link, a Condition's test alone true or false; anything else,
 * an address too, is text. The declaration is typed into the HTML panel, which saves it with the
 * rest through the usual checks. Self-contained: Code mode's asset carries it as text.
 */
export function declareMissingProp(markup: string, name: string): { type: string; at: number; text: string } {
	const path = `props\\.${name}`;
	let type = "text";
	if (new RegExp(`\\bsrc="[^"]*\\{\\{\\s*${path}\\s*\\}\\}`).test(markup)) type = "media";
	else if (new RegExp(`${path}\\.(?:url|text)\\b`).test(markup)) type = "link";
	else if (new RegExp(`\\{\\{@(?:if|elseif)\\s+(?:not\\s+)?${path}\\s*\\}\\}`).test(markup)) type = "boolean";
	const line = `  ${name}: ${type}\n`;
	const block = /^\{\{@props\}\}[ \t]*\n(?:.*\n)*?\{\{\/props\}\}/.exec(markup);
	if (block) return { type, at: block[0].lastIndexOf("{{/props}}"), text: line };
	return { type, at: 0, text: `{{@props}}\n${line}{{/props}}\n` };
}

/** The name of the Prop a markup problem says is missing, when it says so. */
export const MISSING_PROP = /There is no Prop named ([A-Za-z_][A-Za-z0-9_]*) on this Component/;
