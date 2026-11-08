/**
 * Element trees: how Templates (and later Components and Page layouts) are stored (ADR 0002). This
 * is the one canonical, versioned format; Template markup (ADR 0017) is a lossless text view of it,
 * the visual builder edits it, and the renderer turns it into HTML.
 *
 * A tree is a list of nodes:
 * - an element: a stable `id`, an HTML `tag`, ordered `attributes`, Class references by id
 *   (`classes`, ADR 0009) and `children`;
 * - fixed text;
 * - a value: a binding to the value at `path` (`title`, a Field key; later `site.x`, `props.x`,
 *   `item.x`), optionally through a formatter, read where the page renders and escaped for where it
 *   lands;
 * - a comment: kept for the people who build the Site, never sent to visitors;
 * - a Template command's node, such as a Condition or the Site template's content outlet
 *   (`commands.ts`).
 *
 * Attributes are a list, not an object, because Postgres `jsonb` doesn't keep the order of keys and
 * a round trip must lose nothing. A canonical tree never has two text nodes side by side, nor empty
 * text, so printing it as Template markup and reading that back gives the same tree. A change that
 * old trees can't be read as bumps `ELEMENT_TREE_VERSION`.
 */
import { type CommandNode, commandForNode } from "./commands.ts";
import { checkExpression, type Expression, expressionPaths } from "./expressions.ts";
import { checkFormat, type ValueFormat } from "./formatters.ts";

/** The version of the element tree format, stored in every tree. */
export const ELEMENT_TREE_VERSION = 1;

export type ElementTree = {
	version: typeof ELEMENT_TREE_VERSION;
	nodes: TreeNode[];
};

export type TreeNode = ElementNode | TextNode | ValueNode | CommentNode | CommandNode;

export type ElementNode = {
	type: "element";
	/** Stable across every edit, move and Template markup round trip; unique within the tree. */
	id: string;
	/** A lower-case HTML element name from `TEMPLATE_ELEMENTS`. */
	tag: string;
	attributes: Attribute[];
	/** The ids of the Site's Classes the element has, in order (ADR 0009). */
	classes: string[];
	children: TreeNode[];
};

export type TextNode = { type: "text"; text: string };

/** A binding: the value at `path`, such as `title` or a Field key, optionally through a formatter. */
export type ValueNode = { type: "value"; path: string; format?: ValueFormat };

/** A comment: kept in the tree and in Template markup, never rendered. */
export type CommentNode = { type: "comment"; text: string };

/** A Condition (`{{@if}}`): the first branch whose test passes renders, else `otherwise` (`{{@else}}`). */
export type ConditionNode = {
	type: "condition";
	branches: ConditionBranch[];
	/** What renders when no test passes; null when there is no `{{@else}}`. */
	otherwise: TreeNode[] | null;
};

export type ConditionBranch = { test: Expression; children: TreeNode[] };

/** The content outlet (`{{@outlet}}`): where the Site template shows each page's content. */
export type OutletNode = { type: "outlet" };

export type Attribute = {
	/** A lower-case attribute name. */
	name: string;
	/** The value, as fixed text and values joined together; empty for an empty value. */
	value: AttributePart[];
};

export type AttributePart = TextNode | ValueNode;

/** HTML elements a Template may hold. Everything else is refused as an unknown name. */
export const TEMPLATE_ELEMENTS: ReadonlySet<string> = new Set([
	// Sections and landmarks
	"address",
	"article",
	"aside",
	"footer",
	"header",
	"hgroup",
	"main",
	"nav",
	"search",
	"section",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	// Grouping
	"blockquote",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"hr",
	"li",
	"menu",
	"ol",
	"p",
	"pre",
	"ul",
	// Text
	"a",
	"abbr",
	"b",
	"bdi",
	"bdo",
	"br",
	"cite",
	"code",
	"data",
	"del",
	"dfn",
	"em",
	"i",
	"ins",
	"kbd",
	"mark",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"small",
	"span",
	"strong",
	"sub",
	"sup",
	"time",
	"u",
	"var",
	"wbr",
	// Media
	"audio",
	"img",
	"picture",
	"source",
	"track",
	"video",
	// Tables
	"caption",
	"col",
	"colgroup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	// Disclosure
	"details",
	"summary",
]);

/** Elements that never have children or an end tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set(["br", "col", "hr", "img", "source", "track", "wbr"]);

/** Attributes that are never allowed, with the reason given back. */
const REFUSED_ATTRIBUTES: Readonly<Record<string, string>> = {
	style: "Inline styles aren't allowed: give the element a Class.",
	class: "Classes are given by id, in the element's classes.",
	srcdoc: "srcdoc isn't allowed.",
	is: "Custom element names aren't allowed.",
	xmlns: "xmlns isn't allowed.",
	formaction: "formaction isn't allowed.",
	"http-equiv": "http-equiv isn't allowed.",
};

/** Elements refused with a reason of their own rather than as unknown names. */
const REFUSED_ELEMENTS: Readonly<Record<string, string>> = {
	script: "Scripts aren't allowed in a Template.",
	style: "Style elements aren't allowed in a Template: give elements Classes.",
	meta: "Meta elements aren't allowed in a Template: WebCraft writes the page's <head>.",
	iframe: "Iframes aren't allowed in a Template.",
};

const TAG_NAME = /^[a-z][a-z0-9]*$/;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VALUE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The deepest a tree may nest, the most nodes it may hold and the longest text. */
export const TREE_LIMITS = { depth: 64, nodes: 10_000, textLength: 100_000 } as const;

/** Why a Template can't hold an element with this (lower-case) tag, or undefined when it can. */
export function elementProblem(tag: string): string | undefined {
	const refused = REFUSED_ELEMENTS[tag];
	if (refused) return refused;
	if (!TAG_NAME.test(tag) || !TEMPLATE_ELEMENTS.has(tag)) return `There is no element named ${tag} in Templates.`;
	return undefined;
}

/**
 * Why an element can't have an attribute with this (lower-case) name, or undefined when it can.
 * `class` and `style` are refused here because a tree gives Classes by id; Template markup reads
 * them itself (Class names, and an inline style that becomes a generated Class).
 */
export function attributeProblem(name: string): string | undefined {
	if (!ATTRIBUTE_NAME.test(name)) return "An attribute name is lower-case letters, digits and dashes.";
	if (name.startsWith("on")) return `${name}: event handler attributes aren't allowed.`;
	if (name.startsWith("data-wc-")) return `${name}: data-wc- attributes are kept for WebCraft.`;
	return REFUSED_ATTRIBUTES[name];
}

/** Whether `id` can be an element's id: 1 to 64 letters, digits, dashes and underscores. */
export function isElementId(id: string): boolean {
	return ELEMENT_ID.test(id);
}

/**
 * Why a binding's path names no value here: `item.` values are read inside a Loop, `props.` inside a
 * Component and `site.` are the Site's Globals; anything else is a Field or built-in it doesn't have.
 */
export function unknownValueMessage(path: string): string {
	if (path.startsWith("item.")) return `${path}: item. values are read inside a Loop, and there is none here.`;
	if (path.startsWith("props.")) return `${path}: props. values are read inside a Component, and this isn't one.`;
	if (path.startsWith("site.")) return `There is no Global named ${path.slice(5)} on this Site.`;
	return `There is no value named ${path} here.`;
}

/** Whether `path` is written as a value's path: names joined by dots, such as `title` or `site.phone`. */
export function isValuePath(path: string): boolean {
	return VALUE_PATH.test(path);
}

/** A UTF-16 surrogate without its pair: not a character, and not storable as JSON in Postgres. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why text can't be stored, or undefined. */
export function textProblem(text: string): string | undefined {
	if (text.length > TREE_LIMITS.textLength) return `Text is limited to ${TREE_LIMITS.textLength} characters.`;
	if (text.includes("\0")) return "Text can't hold the NUL character.";
	if (LONE_SURROGATE.test(text)) return "Text holds a broken character.";
	return undefined;
}

/**
 * Comment text in canonical form: line breaks as `\n`, as an HTML parser reads them (a comment has
 * no character references, so a carriage return couldn't survive a round trip).
 */
export function canonicalCommentText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Why a comment's text can't be stored (it must read back as the same comment), or undefined. */
export function commentProblem(text: string): string | undefined {
	if (text.length > TREE_LIMITS.textLength) return `A comment is limited to ${TREE_LIMITS.textLength} characters.`;
	if (text.includes("-->") || text.includes("--!>") || text.startsWith(">") || text.startsWith("->")) {
		return "A comment can't hold --> or --!>, nor start with > or ->.";
	}
	if (text.endsWith("<!-") || text.includes("\0")) return "A comment can't end with <!- or hold the NUL character.";
	if (LONE_SURROGATE.test(text)) return "A comment holds a broken character.";
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Nesting a browser would change: an HTML parser silently moves or closes these, so the page
// would no longer match the tree (and Edit mode couldn't find its elements).

const HEADINGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Elements whose start tag ends an open `<p>`. */
const CLOSES_PARAGRAPH: ReadonlySet<string> = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"details",
	"div",
	"dl",
	"figcaption",
	"figure",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"main",
	"menu",
	"nav",
	"ol",
	"p",
	"pre",
	"search",
	"section",
	"table",
	"ul",
]);

/** Where `<p>` and `<a>` stop looking for an open paragraph or link. */
const TABLE_BOUNDARIES: ReadonlySet<string> = new Set(["table", "td", "th", "caption"]);

/** The HTML parser's "special" elements a Template may hold: where `<li>`, `<dd>` and `<dt>` stop looking. */
const SPECIAL: ReadonlySet<string> = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"caption",
	"col",
	"colgroup",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"img",
	"li",
	"main",
	"menu",
	"nav",
	"ol",
	"p",
	"pre",
	"search",
	"section",
	"source",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"track",
	"ul",
	"wbr",
]);

/** Table parts and the only elements they may sit directly inside. */
const TABLE_PARENTS: Readonly<Record<string, readonly string[]>> = {
	caption: ["table"],
	colgroup: ["table"],
	thead: ["table"],
	tbody: ["table"],
	tfoot: ["table"],
	tr: ["thead", "tbody", "tfoot"],
	td: ["tr"],
	th: ["tr"],
	col: ["colgroup"],
};

/** Table elements and the only elements they may hold directly. */
const TABLE_CHILDREN: Readonly<Record<string, readonly string[]>> = {
	table: ["caption", "colgroup", "thead", "tbody", "tfoot"],
	thead: ["tr"],
	tbody: ["tr"],
	tfoot: ["tr"],
	tr: ["td", "th"],
	colgroup: ["col"],
};

/**
 * Why an element `tag` can't sit inside `ancestors` (outermost first), because a browser would move
 * or close it, or undefined.
 */
export function nestingProblem(tag: string, ancestors: readonly string[]): string | undefined {
	const parent = ancestors.at(-1);
	const parents = TABLE_PARENTS[tag];
	if (parents && !(parent && parents.includes(parent))) {
		return `<${tag}> goes directly inside ${parents.map((name) => `<${name}>`).join(" or ")}.`;
	}
	const allowed = parent ? TABLE_CHILDREN[parent] : undefined;
	if (allowed && !allowed.includes(tag)) {
		return `<${parent}> holds only ${allowed.map((name) => `<${name}>`).join(", ")}.`;
	}
	const inward = [...ancestors].reverse();
	if (CLOSES_PARAGRAPH.has(tag)) {
		for (const ancestor of inward) {
			if (TABLE_BOUNDARIES.has(ancestor)) break;
			if (ancestor === "p") return `<${tag}> can't go inside <p>: a browser would end the paragraph before it.`;
		}
	}
	if (tag === "a") {
		for (const ancestor of inward) {
			if (TABLE_BOUNDARIES.has(ancestor) && ancestor !== "table") break;
			if (ancestor === "a") return "A link can't go inside another link.";
		}
	}
	if (HEADINGS.has(tag) && parent && HEADINGS.has(parent)) {
		return `<${tag}> can't go directly inside <${parent}>.`;
	}
	const closesSame = tag === "li" ? ["li"] : tag === "dd" || tag === "dt" ? ["dd", "dt"] : undefined;
	if (closesSame) {
		for (const ancestor of inward) {
			if (closesSame.includes(ancestor)) {
				return `<${tag}> can't go inside <${ancestor}>: a browser would end the <${ancestor}> before it.`;
			}
			if (SPECIAL.has(ancestor) && ancestor !== "address" && ancestor !== "div" && ancestor !== "p") break;
		}
	}
	return undefined;
}

/** Why text or a value can't sit directly inside `parent` (a browser would move it), or undefined. */
export function textPlacementProblem(parent: string | undefined): string | undefined {
	if (parent && TABLE_CHILDREN[parent]) {
		return parent === "tr"
			? "Text can't go directly inside <tr>: put it in a <td> or <th>."
			: `Text can't go directly inside <${parent}>.`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Checking a stored tree

/** One reason a tree was refused, and where: `nodes[0].children[2].attributes[1]`. */
export type TreeProblem = { at: string; message: string };

/** The tree can't be stored: `problems` says what and where. */
export class ElementTreeInvalidError extends Error {
	override name = "ElementTreeInvalidError";
	readonly problems: readonly TreeProblem[];
	constructor(problems: readonly TreeProblem[]) {
		super(
			`The element tree can't be saved: ${problems.map((problem) => `${problem.at || "tree"}: ${problem.message}`).join("; ")}`,
		);
		this.problems = problems;
	}
}

export type ParseTreeOptions = {
	/** Whether a binding's path names a value the tree may read; every path is allowed when absent. */
	isKnownValue?: (path: string) => boolean;
	/** The ids of the Site's Classes; every Class reference is refused when absent. */
	classIds?: ReadonlySet<string>;
	/**
	 * Refuses an element this kind of tree mustn't hold, answering why (an Entry template has no
	 * `<main>`: the Site template does); undefined allows it.
	 */
	refuseElement?: (tag: string) => string | undefined;
	/**
	 * Refuses a Template command this kind of tree mustn't hold, by its name, answering why (only the
	 * Site template holds `{{@outlet}}`); undefined allows it.
	 */
	refuseCommand?: (name: string) => string | undefined;
	/**
	 * Checks rules about the tree as a whole once every node is read (the Site template holds one
	 * `{{@outlet}}`), reporting each problem on the node it is about, or on the tree.
	 */
	checkTree?: TreeCheck;
	/** Makes an id for an element that has none; random by default. */
	newId?: () => string;
};

/** A check of a whole tree: reports `problem(node, message)` for a node, `problem(undefined, …)` for the tree. */
export type TreeCheck = (
	nodes: readonly TreeNode[],
	problem: (node: TreeNode | undefined, message: string) => void,
) => void;

/** The most problems one error reports; the first ones are enough to fix. */
export const MAX_PROBLEMS = 20;

/** Nodes in canonical form: text next to text joined, empty text dropped. */
export function canonicalNodes<Node extends TreeNode | AttributePart>(nodes: readonly Node[]): Node[] {
	const joined: Node[] = [];
	for (const node of nodes) {
		if (node.type === "text" && node.text === "") continue;
		const previous = joined.at(-1);
		if (node.type === "text" && previous?.type === "text") {
			joined[joined.length - 1] = { type: "text", text: previous.text + node.text } as Node;
		} else {
			joined.push(node);
		}
	}
	return joined;
}

/**
 * Checks that `input` is a tree WebCraft may store and answers it in canonical form: element ids
 * filled in where missing, tag and attribute names in lower case, text next to text joined. Throws
 * `ElementTreeInvalidError` listing what is wrong: unknown elements and attributes, scripts and
 * `on…` attributes, inline styles, values with unknown names, nesting a browser would change,
 * duplicate ids, children of void elements, and so on.
 */
export function parseElementTree(input: unknown, options: ParseTreeOptions = {}): ElementTree {
	const problems: TreeProblem[] = [];
	const ids = new Set<string>();
	const newId = options.newId ?? randomElementId;
	/** Where each node was read, for problems `checkTree` reports on a node. */
	const where = new WeakMap<object, string>();
	let count = 0;

	const problem = (at: string, message: string) => {
		if (problems.length < MAX_PROBLEMS) problems.push({ at, message });
	};

	const parsePath = (path: unknown, at: string): string | undefined => {
		if (typeof path !== "string" || !VALUE_PATH.test(path)) {
			problem(at, "A value's path is names joined by dots, such as title or summary.");
			return undefined;
		}
		if (options.isKnownValue && !options.isKnownValue(path)) problem(at, unknownValueMessage(path));
		return path;
	};

	const parseText = (text: unknown, at: string): string | undefined => {
		if (typeof text !== "string") {
			problem(at, "Text must be a string.");
			return undefined;
		}
		const refused = textProblem(text);
		if (refused) problem(at, refused);
		return text;
	};

	const parseValue = (node: Record<string, unknown>, at: string): ValueNode | undefined => {
		const path = parsePath(node.path, `${at}.path`);
		if (path === undefined) return undefined;
		if (node.format === undefined) return { type: "value", path };
		const checked = checkFormat(node.format);
		if ("problem" in checked) {
			problem(`${at}.format`, checked.problem);
			return undefined;
		}
		return { type: "value", path, format: checked.format };
	};

	const parsePart = (part: unknown, at: string): AttributePart | undefined => {
		const raw = (part ?? {}) as Record<string, unknown>;
		if (raw.type === "text") {
			const text = parseText(raw.text, `${at}.text`);
			return text === undefined ? undefined : { type: "text", text };
		}
		if (raw.type === "value") return parseValue(raw, at);
		problem(at, "An attribute's value is made of text and values.");
		return undefined;
	};

	const parseAttributes = (attributes: unknown, at: string): Attribute[] => {
		if (!Array.isArray(attributes)) {
			problem(at, "attributes must be a list.");
			return [];
		}
		const seen = new Set<string>();
		const parsed: Attribute[] = [];
		attributes.forEach((attribute: unknown, index) => {
			const here = `${at}[${index}]`;
			const { name: rawName, value } = (attribute ?? {}) as { name?: unknown; value?: unknown };
			const name = typeof rawName === "string" ? rawName.toLowerCase() : "";
			const refused = attributeProblem(name);
			if (refused) {
				problem(here, refused);
				return;
			}
			if (seen.has(name)) {
				problem(here, `${name} is given twice.`);
				return;
			}
			seen.add(name);
			if (!Array.isArray(value)) {
				problem(`${here}.value`, "An attribute's value is a list of text and values.");
				return;
			}
			const parts = value.map((part: unknown, partIndex) => parsePart(part, `${here}.value[${partIndex}]`));
			parsed.push({ name, value: canonicalNodes(parts.filter((part): part is AttributePart => part !== undefined)) });
		});
		return parsed;
	};

	const parseClasses = (classes: unknown, at: string): string[] => {
		if (!Array.isArray(classes)) {
			problem(at, "classes must be a list of Class ids.");
			return [];
		}
		const parsed: string[] = [];
		classes.forEach((classId: unknown, index) => {
			if (typeof classId !== "string" || !options.classIds?.has(classId)) {
				problem(`${at}[${index}]`, `There is no Class with the id ${String(classId)} on this Site.`);
			} else if (!parsed.includes(classId)) {
				parsed.push(classId);
			}
		});
		return parsed;
	};

	const parseNodes = (nodes: unknown, at: string, ancestors: readonly string[], depth: number): TreeNode[] => {
		if (!Array.isArray(nodes)) {
			problem(at, "Nodes must be a list.");
			return [];
		}
		if (depth > TREE_LIMITS.depth && nodes.length > 0) {
			problem(at, `Elements nest at most ${TREE_LIMITS.depth} deep.`);
			return [];
		}
		const parsed: TreeNode[] = [];
		nodes.forEach((node: unknown, index) => {
			const here = `${at}[${index}]`;
			count++;
			if (count > TREE_LIMITS.nodes) {
				if (count === TREE_LIMITS.nodes + 1) problem(here, `A tree holds at most ${TREE_LIMITS.nodes} nodes.`);
				return;
			}
			const result = parseNode(node, here, ancestors, depth);
			if (result) {
				where.set(result, here);
				parsed.push(result);
			}
		});
		return canonicalNodes(parsed);
	};

	const parseNode = (node: unknown, at: string, ancestors: readonly string[], depth: number): TreeNode | undefined => {
		const raw = (node ?? {}) as Record<string, unknown>;
		const placement = () => {
			const refused = textPlacementProblem(ancestors.at(-1));
			if (refused) problem(at, refused);
		};
		switch (raw.type) {
			case "text": {
				const text = parseText(raw.text, `${at}.text`);
				if (text?.trim()) placement();
				return text === undefined ? undefined : { type: "text", text };
			}
			case "value":
				placement();
				return parseValue(raw, at);
			case "comment": {
				if (typeof raw.text !== "string") {
					problem(`${at}.text`, "A comment's text must be a string.");
					return undefined;
				}
				const text = canonicalCommentText(raw.text);
				const refused = commentProblem(text);
				if (refused) problem(`${at}.text`, refused);
				return { type: "comment", text };
			}
			case "element":
				return parseElement(raw, at, ancestors, depth);
		}
		const command = commandForNode(raw.type);
		if (command) {
			const refused = options.refuseCommand?.(command.name);
			if (refused) {
				problem(at, refused);
				return undefined;
			}
			return command.check(raw, at, {
				problem,
				expression: (expression, here) =>
					checkExpression(expression, here, { problem, isKnownValue: options.isKnownValue }),
				nodes: (children, here) => parseNodes(children, here, ancestors, depth + 1),
			});
		}
		problem(at, "A node is an element, text, a value, a comment or a Template command.");
		return undefined;
	};

	const parseElement = (
		element: Record<string, unknown>,
		at: string,
		ancestors: readonly string[],
		depth: number,
	): ElementNode | undefined => {
		const tag = typeof element.tag === "string" ? element.tag.toLowerCase() : "";
		const refused =
			elementProblem(tag) ?? options.refuseElement?.(tag) ?? (tag ? nestingProblem(tag, ancestors) : undefined);
		if (refused) {
			problem(`${at}.tag`, tag ? refused : `There is no element named ${String(element.tag)} in Templates.`);
			return undefined;
		}
		let id = element.id;
		if (id === undefined || id === null) {
			id = newId();
		} else if (typeof id !== "string" || !ELEMENT_ID.test(id)) {
			problem(`${at}.id`, "An element id is 1 to 64 letters, digits, dashes and underscores.");
			return undefined;
		} else if (ids.has(id)) {
			problem(`${at}.id`, `The id ${id} is used by another element.`);
			return undefined;
		}
		ids.add(id as string);
		const children = parseNodes(element.children ?? [], `${at}.children`, [...ancestors, tag], depth + 1);
		if (VOID_ELEMENTS.has(tag) && children.length > 0) problem(`${at}.children`, `${tag} can't have children.`);
		return {
			type: "element",
			id: id as string,
			tag,
			attributes: parseAttributes(element.attributes ?? [], `${at}.attributes`),
			classes: parseClasses(element.classes ?? [], `${at}.classes`),
			children,
		};
	};

	const { version, nodes } = (input ?? {}) as { version?: unknown; nodes?: unknown };
	if (version !== ELEMENT_TREE_VERSION) problem("version", `The element tree version is ${ELEMENT_TREE_VERSION}.`);
	const tree: ElementTree = { version: ELEMENT_TREE_VERSION, nodes: parseNodes(nodes, "nodes", [], 1) };
	if (problems.length === 0) {
		options.checkTree?.(tree.nodes, (node, message) => problem((node && where.get(node)) || "nodes", message));
	}
	if (problems.length > 0) throw new ElementTreeInvalidError(problems);
	return tree;
}

// ---------------------------------------------------------------------------------------------
// Walking a tree

/** The lists of children a node holds: an element's children, each branch of a command. */
export function childListsOf(node: TreeNode): readonly (readonly TreeNode[])[] {
	if (node.type === "element") return [node.children];
	if (node.type === "text" || node.type === "value" || node.type === "comment") return [];
	const command = commandForNode(node.type);
	return command ? command.children(node) : [];
}

/** Every element in the tree, depth first, including those inside Template commands. */
export function* elementsOf(nodes: readonly TreeNode[]): Generator<ElementNode> {
	for (const node of nodes) {
		if (node.type === "element") yield node;
		for (const children of childListsOf(node)) yield* elementsOf(children);
	}
}

/** The path of every binding in the tree (in text, attributes and Conditions' tests), each once. */
export function valuePathsOf(tree: ElementTree): string[] {
	const paths = new Set<string>();
	const visit = (nodes: readonly TreeNode[]) => {
		for (const node of nodes) {
			if (node.type === "value") paths.add(node.path);
			if (node.type === "element") {
				for (const attribute of node.attributes) {
					for (const part of attribute.value) if (part.type === "value") paths.add(part.path);
				}
			}
			if (node.type === "condition") {
				for (const branch of node.branches) for (const path of expressionPaths(branch.test)) paths.add(path);
			}
			for (const children of childListsOf(node)) visit(children);
		}
	};
	visit(tree.nodes);
	return [...paths];
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random element id: 12 letters and digits. */
export function randomElementId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}
