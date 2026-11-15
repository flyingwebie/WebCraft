import { fill, type Words } from "../api.ts";

/**
 * What typing offers in the HTML pane (BA-33; Code mode's suggestions, `code-mode` 152, 192, 205):
 * `{{` the values the source may read (the Entry's Fields, the Globals, Props), its Loops and the
 * Site's Components, each placed with its required Props; `{{@` the Template commands and the ready-made
 * presets; `<` and a capital the Components. What `code/open` answers as `suggestions`.
 */
export type MarkupSuggestions = {
	values: { path: string; label: string | null; type: string; group: string; sample?: string }[];
	components: { name: string; props: { key: string; label: string; required: boolean }[] }[];
	commands: { name: string; block: boolean; snippet: string }[];
	presets: { id: string; snippet: string }[];
	loops: { name: string }[];
};

/** One suggestion: what the list shows, and the text it puts in (`$0` is where the caret goes). */
export type Suggestion = { group: string; label: string; detail?: string; insert: string };

/** The suggestions open at the caret: the text they replace (`from` to `to`) and what they are. */
export type SuggestContext = { from: number; to: number; items: Suggestion[] };

/** A Component placed with its required Props, the caret in the first one (or before ` />`). */
function componentSuggestion(component: MarkupSuggestions["components"][number], words: Words): Suggestion {
	const required = component.props.filter((prop) => prop.required);
	const props = required.map((prop, index) => ` ${prop.key}="${index === 0 ? "$0" : ""}"`).join("");
	return {
		group: words.suggest.groups.components,
		label: `<${component.name}>`,
		detail: component.props.map((prop) => prop.key).join(", ") || undefined,
		insert: `<${component.name}${props}${required.length === 0 ? "$0" : ""} />`,
	};
}

/** What is offered at the caret, or null when nothing is being typed that asks for it. */
export function markupSuggestions(
	text: string,
	caret: number,
	offered: MarkupSuggestions,
	words: Words,
): SuggestContext | null {
	const said = words.suggest;
	const before = text.slice(Math.max(0, caret - 400), caret);
	const offset = caret - before.length;
	const open = before.lastIndexOf("{{");
	if (open >= 0 && !before.slice(open).includes("}}") && before[open - 1] !== "\\") {
		const inside = before.slice(open + 2);
		const from = offset + open;
		const to = text.startsWith("}}", caret) ? caret + 2 : text.startsWith(" }}", caret) ? caret + 3 : caret;
		if (inside.startsWith("@")) {
			const query = inside.slice(1).trimStart().toLowerCase();
			const presets = said.presets as Record<string, string>;
			return {
				from,
				to,
				items: [
					...offered.commands
						.filter((command) => command.name.toLowerCase().startsWith(query))
						.map((command) => ({
							group: said.groups.commands,
							label: `{{@${command.name}}}`,
							insert: command.snippet,
						})),
					...offered.presets
						.filter((preset) => !query || preset.snippet.slice(3).toLowerCase().startsWith(query))
						.map((preset) => ({
							group: said.groups.presets,
							label: presets[preset.id] ?? preset.id,
							detail: preset.snippet.split("\n")[0],
							insert: preset.snippet,
						})),
				],
			};
		}
		const query = inside.trimStart().toLowerCase();
		const groups = said.groups as Record<string, string>;
		return {
			from,
			to,
			items: [
				...offered.values
					.filter((value) => value.path.toLowerCase().includes(query))
					.map((value) => ({
						group: groups[value.group] ?? value.group,
						label: `{{ ${value.path} }}`,
						detail: value.sample ?? value.label ?? undefined,
						insert: `{{ ${value.path} }}`,
					})),
				...offered.loops
					.filter((loop) => loop.name.toLowerCase().includes(query))
					.map((loop) => ({
						group: said.groups.loops,
						label: loop.name,
						insert: `{{@loop ${loop.name}}}$0{{/loop}}`,
					})),
				...offered.components
					.filter((each) => each.name.toLowerCase().includes(query))
					.map((each) => componentSuggestion(each, words)),
			],
		};
	}
	const tagOpen = before.lastIndexOf("<");
	if (tagOpen >= 0 && !before.slice(tagOpen).includes(">")) {
		const component = /^<([A-Z][A-Za-z0-9]*)$/.exec(before.slice(tagOpen));
		if (component) {
			const query = component[1] ?? "";
			return {
				from: offset + tagOpen,
				to: caret,
				items: offered.components
					.filter((each) => each.name.startsWith(query))
					.map((each) => componentSuggestion(each, words)),
			};
		}
	}
	return null;
}

/** Puts a suggestion in: the text with it in place of what it replaces, and where the caret goes. */
export function applySuggestion(
	text: string,
	context: SuggestContext,
	item: Suggestion,
): { text: string; caret: number } {
	const marker = item.insert.indexOf("$0");
	const inserted = item.insert.replace("$0", "");
	const caret = context.from + (marker >= 0 ? marker : inserted.length);
	return { text: `${text.slice(0, context.from)}${inserted}${text.slice(context.to)}`, caret };
}

/** How many suggestions there are, in words. */
export function suggestionCount(count: number, words: Words): string {
	if (count === 0) return words.suggest.none;
	return count === 1 ? words.suggest.one : fill(words.suggest.other, { count: String(count) });
}
