/**
 * Loops in element trees and Template markup (GLOSSARY.md › Loop): what a Loop's items are called
 * and what bindings inside a Loop may read. A Loop's source is a Loop of the Site, by name
 * (`latest-posts`), or a list the place already reads, by its path (`gallery`, `post.tags`,
 * `props.lines`). Inside it the items are read as `<alias>.x` and the item's position as `loop.x`;
 * anywhere a Loop of the Site is read as `<name>.count`, `<name>.empty` and the rest of `LOOP_STATS`.
 */
import { EXPRESSION_KEYWORDS } from "./expressions.ts";
import { unknownValueMessage } from "./tree.ts";
import type { ValueReader } from "./values.ts";

/** What keeps one page from running unbounded work through its Loops. */
export const LOOP_LIMITS = {
	/** How deep Loops nest, inside Components too. */
	depth: 4,
	/** How many Loops of the Site one page runs (each runs at most one query). */
	perPage: 20,
	/** How many items a page shows through all its Loops. */
	items: 2_000,
} as const;

/**
 * The built-in Loop of Site search (ADR 0021): only the Search results template names it. Its items
 * are the hits for the visitor's query, best first (`search.total` counts them all), each an Entry's
 * values and its `snippet`; `search.query` is the query.
 */
export const SEARCH_LOOP = "search";

/** What the built-in Search results template calls the search Loop's items. */
export const SEARCH_HIT_NAME = "hit";

/** The visitor's query on the search results page, as the Search results template reads it. */
export const SEARCH_QUERY_VALUE = `${SEARCH_LOOP}.query`;

/** What a Loop's items are called when markup doesn't name them with `as`. */
export const DEFAULT_ITEM_NAME = "item";

/** What any binding reads of a Loop of the Site, as `<name>.<stat>`. */
export const LOOP_STATS = ["count", "empty", "total", "page", "pages"] as const;

/** What a binding inside a Loop reads of its item's place, as `loop.<name>`: the innermost Loop's. */
export const LOOP_POSITION = ["index", "first", "last", "odd", "even", "count"] as const;

/** One item of a Loop as a page shows it: its values (`""` reads the item itself), and which item it is for Edit mode. */
export type LoopItem = { read: ValueReader; key?: string };

/** What a Loop of the Site shows on a page: its items, how many match in all, and its pages when it paginates here. */
export type LoopRun = {
	items: readonly LoopItem[];
	/** How many items its query matches across all its pages; the items' count when it doesn't paginate. */
	total: number;
	/** Present when it paginates on this page: which page this is, how many, and each page's address. */
	pages?: { current: number; count: number; href(page: number): string };
};

/**
 * Where a binding inside a Loop is, for Edit mode's tags (#74 tags Loop items): the innermost Loop's
 * items' name and which item it is.
 */
export type LoopItemPlace = { alias: string; key?: string };

/** A Loop of the Site as checks see it: which paths its items have (`title`, `category.url`). */
export type LoopInfo = { isKnownValue(itemPath: string): boolean };

/**
 * The Loops of the Site a tree may name, by name: their items' values, or why one can't be used here
 * (`refused`: it isn't published yet).
 */
export type LoopCatalogue = { byName(name: string): LoopInfo | { refused: string } | undefined };

export function isLoopInfo(found: LoopInfo | { refused: string } | undefined): found is LoopInfo {
	return found !== undefined && "isKnownValue" in found;
}

/** What bindings may read where they are: the values around them, and the Loops they sit in. */
export type ValueScope = {
	/** Whether a path names a value here; every path is allowed when absent. */
	isKnownValue?: (path: string) => boolean;
	/** Why a path names no value here. */
	unknownValue: (path: string) => string;
	/** The Loops of the Site; `{{@loop name}}` names only lists when absent. */
	loops?: LoopCatalogue;
	/** What the items of the Loops around are called, outermost first. */
	aliases: readonly string[];
};

/**
 * The scope at the top of a tree: the values it reads, and `<name>.count` and the rest of
 * `LOOP_STATS` for every Loop of the Site.
 */
export function rootScope(options: {
	isKnownValue?: (path: string) => boolean;
	unknownValue?: (path: string) => string;
	loops?: LoopCatalogue;
}): ValueScope {
	const { isKnownValue, loops } = options;
	const unknown = options.unknownValue ?? unknownValueMessage;
	return {
		isKnownValue: isKnownValue && ((path) => isKnownValue(path) || isLoopInfo(statOf(path, loops)?.loop)),
		unknownValue: (path) => {
			const stat = statOf(path, loops);
			if (stat?.loop && !isLoopInfo(stat.loop)) return stat.loop.refused;
			return unknown(path);
		},
		loops,
		aliases: [],
	};
}

/** The Loop of the Site a path like `latest-posts.count` reads a stat of, if it is one. */
function statOf(
	path: string,
	loops: LoopCatalogue | undefined,
): { loop: LoopInfo | { refused: string } | undefined } | undefined {
	const [name = "", stat, ...rest] = path.split(".");
	if (rest.length > 0 || !(LOOP_STATS as readonly string[]).includes(stat ?? "")) return undefined;
	return { loop: loops?.byName(name) };
}

/** Names a Loop's items can't take: what bindings read from, and the words Conditions use. */
function isReservedItemName(name: string): boolean {
	return EXPRESSION_KEYWORDS.has(name) || name === "site" || name === "props" || name === "loop";
}

const ITEM_NAME = /^[a-z][A-Za-z0-9_]*$/;
const SOURCE = /^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*)*$/;

/** `{{@loop source as alias}}`'s argument read: where the source and the name are in it. */
export type LoopArgument = { source: string; sourceAt: number; alias: string; aliasAt: number };

/**
 * Reads the argument of `{{@loop …}}`: a Loop's name or a list's path, then optionally `as` and
 * what its items are called (`item` when left out). Answers why it can't be read, and where.
 */
export function readLoopArgument(argument: string): LoopArgument | { problem: string; at: number } {
	const match = /^(\s*)(\S*)(?:(\s+)as(?:(\s+)(\S*))?)?\s*$/.exec(argument);
	if (!match)
		return {
			problem: "Write {{@loop latest-posts as post}}: a Loop or a list, then as and a name for its items.",
			at: 0,
		};
	const [, lead = "", source = "", gap = "", space, alias] = match;
	const sourceAt = lead.length;
	if (!source) return { problem: "{{@loop}} names a Loop or a list, such as {{@loop latest-posts as post}}.", at: 0 };
	if (!SOURCE.test(source)) return { problem: `${source} isn't a Loop's name or a value's name.`, at: sourceAt };
	const asAt = sourceAt + source.length + gap.length;
	if (gap && space === undefined) {
		return { problem: "as is followed by a name for the Loop's items, such as as post.", at: asAt };
	}
	if (alias === undefined) return { source, sourceAt, alias: DEFAULT_ITEM_NAME, aliasAt: sourceAt };
	return { source, sourceAt, alias, aliasAt: asAt + 2 + (space?.length ?? 0) };
}

/** Why `alias` can't name a Loop's items here, or undefined. */
export function itemNameProblem(alias: string, around: ValueScope): string | undefined {
	if (!ITEM_NAME.test(alias) || isReservedItemName(alias)) {
		return `${alias} can't name a Loop's items: use a lower-case name such as post, other than site, props, loop and the words Conditions use.`;
	}
	if (around.aliases.includes(alias)) {
		return `${alias} already names the items of a Loop around this one: choose another name with as.`;
	}
	if (around.isKnownValue?.(alias)) return `${alias} already names a value here: choose another name with as.`;
	return undefined;
}

/**
 * What bindings inside a Loop's items may read: the item as `alias` and its values (`alias.title`),
 * the item's position (`loop.index`), and everything around the Loop. Answers why the Loop can't be
 * here (too deep, a source naming nothing, a name taken) with `on` saying which part; its scope then
 * allows every path under `alias`, so one mistake isn't reported again on every binding inside.
 */
export function loopBodyScope(
	source: string,
	alias: string,
	around: ValueScope,
): { scope: ValueScope; problem?: { on: "loop" | "source" | "alias"; message: string } } {
	let problem: { on: "loop" | "source" | "alias"; message: string } | undefined;
	let itemKnown: ((path: string) => boolean) | undefined;
	if (around.aliases.length >= LOOP_LIMITS.depth) {
		problem = { on: "loop", message: `Loops nest at most ${LOOP_LIMITS.depth} deep.` };
	}
	const site = source.includes(".") ? undefined : around.loops?.byName(source);
	if (isLoopInfo(site)) itemKnown = (path) => site.isKnownValue(path);
	else if (site) problem ??= { on: "source", message: site.refused };
	else if (around.isKnownValue === undefined) itemKnown = undefined;
	else if (around.isKnownValue(source)) {
		const outer = around.isKnownValue;
		itemKnown = (path) => outer(`${source}.${path}`);
	} else {
		problem ??= {
			on: "source",
			message: `There is no Loop or list named ${source} here: name a Loop of the Site, a Repeater or a Relationship.`,
		};
	}
	const named = itemNameProblem(alias, around);
	if (named) problem ??= { on: "alias", message: named };
	const allowsItem = problem ? () => true : itemKnown;
	const outer = around.isKnownValue;
	const prefix = `${alias}.`;
	return {
		problem,
		scope: {
			isKnownValue:
				outer &&
				((path) => {
					if (path === alias) return true;
					if (path.startsWith(prefix)) return allowsItem?.(path.slice(prefix.length)) ?? true;
					if (path.startsWith("loop.")) return (LOOP_POSITION as readonly string[]).includes(path.slice(5));
					return outer(path);
				}),
			unknownValue: (path) => {
				if (path.startsWith(prefix)) return `${source} items have no ${path.slice(prefix.length)}.`;
				if (path.startsWith("loop.")) {
					return `${path}: a Loop's position is ${LOOP_POSITION.map((name) => `loop.${name}`).join(", ")}.`;
				}
				return around.unknownValue(path);
			},
			loops: around.loops,
			aliases: [...around.aliases, alias],
		},
	};
}

/** Why `{{@pagination name}}` can't show a Loop's pages, or undefined. */
export function paginationProblem(name: string, scope: ValueScope): string | undefined {
	if (!name) return "{{@pagination}} names the Loop whose pages it links to, such as {{@pagination latest-posts}}.";
	const found = scope.loops?.byName(name);
	if (found && !isLoopInfo(found)) return found.refused;
	if (!found) return `There is no Loop named ${name}: {{@pagination}} links to the pages of a Loop of the Site.`;
	return undefined;
}
