import type { Json } from "@webcraft/core";

/**
 * The Loops place's pure parts (BA-25, `places-assets/08`): its address (`loops` or `loops/<id>`) and
 * view (the definition as Form or Markup), the result's tree of values with the binding each key
 * copies, the order choices of a query, and the markup that places a Loop.
 */

/** How the place shows the open Loop's definition: as a form (the default) or as the markup that places it. */
export type LoopsView = { mode: "form" | "markup" };

export function readView(text: string | null): LoopsView {
	return { mode: new URLSearchParams(text ?? "").get("mode") === "markup" ? "markup" : "form" };
}

/** The view as `wc-view` holds it; null for the default. */
export function printView(view: LoopsView): string | null {
	return view.mode === "markup" ? "mode=markup" : null;
}

/** The Loop an address opens (`loops/<id>`), or null for the place alone (`loops`). */
export function loopIdOf(place: string): string | null {
	const [, id] = place.split("/");
	return id || null;
}

export function placeOf(loopId: string | null): string {
	return loopId ? `loops/${loopId}` : "loops";
}

/** What a Loop's items are called in markup unless it says otherwise (`{{@loop name as item}}`). */
export const ITEM_NAME = "item";

/** One line of the result's tree: a value at its path, and what markup writes to read it. */
export type ResultRow = {
	/** Its path under the item (`author.name`), also what the tree shows as its key. */
	path: string;
	/** The value as the tree shows it: text in quotes, a list by its length. */
	shown: string;
	/** What markup writes to read it: `{{ item.author.name }}`; a list: `{{@loop item.steps as step}}`. */
	binding: string;
};

/** What a Loop over a list calls its items: the list's name in the singular (`steps` → `step`), else `<name>Item`. */
export function itemNameOf(key: string): string {
	return key.length > 3 && key.endsWith("s") && !key.endsWith("ss") ? key.slice(0, -1) : `${key}Item`;
}

/** A value on one line: text in quotes, numbers, true/false and null as they are, a list by its length. */
function shownValue(value: Json): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.length}]`;
	return String(value);
}

/**
 * An item's values as the tree's lines: a Group, a choice (`{ value, label }`) or an Entry a
 * Relationship points at open into their parts by path (`author.name`), a list stays one line that
 * copies the Loop over it, every other value one line that copies its binding.
 */
export function resultRows(values: Readonly<Record<string, Json>>, item = ITEM_NAME): ResultRow[] {
	const rows: ResultRow[] = [];
	const visit = (value: Json, path: string) => {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			for (const [key, inner] of Object.entries(value)) visit(inner, `${path}.${key}`);
			return;
		}
		const last = path.split(".").pop() ?? path;
		rows.push({
			path,
			shown: shownValue(value),
			binding: Array.isArray(value) ? `{{@loop ${item}.${path} as ${itemNameOf(last)}}}` : `{{ ${item}.${path} }}`,
		});
	};
	for (const [key, value] of Object.entries(values)) visit(value, key);
	return rows;
}

/** How long ago the result was read, as the place says it: just now, then in minutes. */
export function freshness(readAt: number, now: number): { kind: "justNow" } | { kind: "minutes"; count: number } {
	const minutes = Math.floor((now - readAt) / 60_000);
	return minutes < 1 ? { kind: "justNow" } : { kind: "minutes", count: minutes };
}

/** How a sort's direction is worded, by what it orders. */
export type OrderKind = "date" | "text" | "number" | "boolean";

/** One choice of the Order menu: a sort (`by` and `direction`) and how its words read. */
export type OrderChoice = { key: string; by: string; direction: "asc" | "desc"; kind: OrderKind; label: string };

/** A sort's key in the Order menu (`publishedAt:desc`). */
export function orderKey(sort: { by: string; direction: "asc" | "desc" }): string {
	return `${sort.by}:${sort.direction}`;
}

/** Reads a key of the Order menu back into a sort; null for anything else. */
export function sortOf(key: string): { by: string; direction: "asc" | "desc" } | null {
	const at = key.lastIndexOf(":");
	if (at <= 0) return null;
	const direction = key.slice(at + 1);
	return direction === "asc" || direction === "desc" ? { by: key.slice(0, at), direction } : null;
}

/**
 * The Order menu's choices: each thing a query sorts by (the title, the built-in dates, the Fields it
 * may sort by), each way, dates newest first.
 */
export function orderChoices(
	sortable: readonly { by: string; label: string; kind: OrderKind }[],
): Omit<OrderChoice, "label">[] {
	return sortable.flatMap(({ by, kind }) =>
		(kind === "date" ? (["desc", "asc"] as const) : (["asc", "desc"] as const)).map((direction) => ({
			key: orderKey({ by, direction }),
			by,
			direction,
			kind,
		})),
	);
}

/** How a Field type's order is worded. */
export function orderKindOf(type: string): OrderKind {
	if (type === "date") return "date";
	if (type === "number") return "number";
	if (type === "boolean") return "boolean";
	return "text";
}

/**
 * The markup that places a Loop (`GLOSSARY.md` › Template markup): its opening and closing, a binding
 * of each of the first values its items have, what shows when there are none, and its pagination when
 * it goes page by page.
 */
export function placingMarkup(
	name: string,
	options: { bindings: readonly string[]; emptyText: string; paginate: boolean },
): string {
	const inside = options.bindings.length > 0 ? options.bindings : [`{{ ${ITEM_NAME}.title }}`];
	return [
		`{{@loop ${name} as ${ITEM_NAME}}}`,
		...inside.map((binding) => `  ${binding}`),
		"{{@empty}}",
		`  ${options.emptyText}`,
		"{{/loop}}",
		...(options.paginate ? [`{{@pagination ${name}}}`] : []),
	].join("\n");
}
