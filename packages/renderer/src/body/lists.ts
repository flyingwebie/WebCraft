import type { ListItem } from "./blocks.ts";
import type { InlineText } from "./inline.ts";

/** One line of a list, with its depth (0 at the top) and formatted text. */
export type ListLine = { depth: number; text: InlineText };

/** Each line sits under the closest preceding line that is less deep, for paste and both editors. */
export function listItemsFromLines(lines: readonly ListLine[]): ListItem[] {
	const root: ListItem[] = [];
	const stack: { depth: number; items: ListItem[] }[] = [{ depth: -1, items: root }];
	for (const line of lines) {
		while ((stack.at(-1)?.depth ?? -1) >= line.depth) stack.pop();
		const parent = stack.at(-1) ?? { depth: -1, items: root };
		const item: ListItem = { text: line.text };
		parent.items.push(item);
		item.items = [];
		stack.push({ depth: Math.min(line.depth, parent.depth + 1), items: item.items });
	}
	const tidy = (items: ListItem[]): ListItem[] =>
		items.map((item) =>
			item.items && item.items.length > 0 ? { text: item.text, items: tidy(item.items) } : { text: item.text },
		);
	return tidy(root);
}
