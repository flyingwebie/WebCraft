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
 *   `item.x`), read where the page renders and escaped for where it lands.
 *
 * Attributes are a list, not an object, because Postgres `jsonb` doesn't keep the order of keys and
 * a round trip must lose nothing. Later node types (Component placements, Loops, Conditions, the
 * content outlet) join the `TreeNode` union; a change that old trees can't be read as bumps
 * `ELEMENT_TREE_VERSION`.
 */

/** The version of the element tree format, stored in every tree. */
export const ELEMENT_TREE_VERSION = 1;

export type ElementTree = {
	version: typeof ELEMENT_TREE_VERSION;
	nodes: TreeNode[];
};

export type TreeNode = ElementNode | TextNode | ValueNode;

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

/** A binding: the value at `path`, such as `title` or a Field key. */
export type ValueNode = { type: "value"; path: string };

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

const TAG_NAME = /^[a-z][a-z0-9]*$/;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VALUE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The deepest a tree may nest, and the most nodes it may hold. */
export const TREE_LIMITS = { depth: 64, nodes: 10_000, textLength: 100_000 } as const;

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
	/** The ids of the Site's Classes; every Class reference is refused when absent (no Classes yet). */
	classIds?: ReadonlySet<string>;
	/**
	 * Refuses an element this kind of tree mustn't hold, answering why (an Entry template has no
	 * `<main>`: the Site template does); undefined allows it.
	 */
	refuseElement?: (tag: string) => string | undefined;
	/** Makes an id for an element that has none; random by default. */
	newId?: () => string;
};

/** The most problems one error reports; the first ones are enough to fix. */
const MAX_PROBLEMS = 20;

/**
 * Checks that `input` is a tree WebCraft may store and answers it in canonical form: element ids
 * filled in where missing, tag and attribute names in lower case. Throws `ElementTreeInvalidError`
 * listing what is wrong: unknown elements and attributes, scripts and `on…` attributes, inline styles,
 * values with unknown names, duplicate ids, children of void elements, and so on.
 */
export function parseElementTree(input: unknown, options: ParseTreeOptions = {}): ElementTree {
	const problems: TreeProblem[] = [];
	const ids = new Set<string>();
	const newId = options.newId ?? randomElementId;
	let count = 0;

	const problem = (at: string, message: string) => {
		if (problems.length < MAX_PROBLEMS) problems.push({ at, message });
	};

	const parsePath = (path: unknown, at: string): string | undefined => {
		if (typeof path !== "string" || !VALUE_PATH.test(path)) {
			problem(at, "A value's path is names joined by dots, such as title or summary.");
			return undefined;
		}
		if (options.isKnownValue && !options.isKnownValue(path)) problem(at, `There is no value named ${path} here.`);
		return path;
	};

	const parseText = (text: unknown, at: string): string | undefined => {
		if (typeof text !== "string") {
			problem(at, "Text must be a string.");
			return undefined;
		}
		if (text.length > TREE_LIMITS.textLength) problem(at, `Text is limited to ${TREE_LIMITS.textLength} characters.`);
		return text;
	};

	const parsePart = (part: unknown, at: string): AttributePart | undefined => {
		const { type } = (part ?? {}) as { type?: unknown };
		if (type === "text") {
			const text = parseText((part as { text?: unknown }).text, `${at}.text`);
			return text === undefined ? undefined : { type: "text", text };
		}
		if (type === "value") {
			const path = parsePath((part as { path?: unknown }).path, `${at}.path`);
			return path === undefined ? undefined : { type: "value", path };
		}
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
			if (!ATTRIBUTE_NAME.test(name)) {
				problem(here, "An attribute name is lower-case letters, digits and dashes.");
				return;
			}
			if (name.startsWith("on")) {
				problem(here, `${name}: event handler attributes aren't allowed.`);
				return;
			}
			if (name.startsWith("data-wc-")) {
				problem(here, `${name}: data-wc- attributes are kept for WebCraft.`);
				return;
			}
			const refused = REFUSED_ATTRIBUTES[name];
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
			parsed.push({ name, value: parts.filter((part): part is AttributePart => part !== undefined) });
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

	const parseNodes = (nodes: unknown, at: string, depth: number): TreeNode[] => {
		if (!Array.isArray(nodes)) {
			problem(at, "Nodes must be a list.");
			return [];
		}
		if (depth > TREE_LIMITS.depth) {
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
			const result = parseNode(node, here, depth);
			if (result) parsed.push(result);
		});
		return parsed;
	};

	const parseNode = (node: unknown, at: string, depth: number): TreeNode | undefined => {
		const { type } = (node ?? {}) as { type?: unknown };
		if (type === "text") {
			const text = parseText((node as { text?: unknown }).text, `${at}.text`);
			return text === undefined ? undefined : { type: "text", text };
		}
		if (type === "value") {
			const path = parsePath((node as { path?: unknown }).path, `${at}.path`);
			return path === undefined ? undefined : { type: "value", path };
		}
		if (type !== "element") {
			problem(at, "A node is an element, text or a value.");
			return undefined;
		}
		const element = node as Partial<Record<keyof ElementNode, unknown>>;
		const tag = typeof element.tag === "string" ? element.tag.toLowerCase() : "";
		if (tag === "script") {
			problem(`${at}.tag`, "Scripts aren't allowed in a Template.");
			return undefined;
		}
		if (!TAG_NAME.test(tag) || !TEMPLATE_ELEMENTS.has(tag)) {
			problem(`${at}.tag`, `There is no element named ${tag || String(element.tag)} in Templates.`);
			return undefined;
		}
		const refusal = options.refuseElement?.(tag);
		if (refusal) {
			problem(`${at}.tag`, refusal);
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
		const children = parseNodes(element.children ?? [], `${at}.children`, depth + 1);
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
	const tree: ElementTree = { version: ELEMENT_TREE_VERSION, nodes: parseNodes(nodes, "nodes", 1) };
	if (problems.length > 0) throw new ElementTreeInvalidError(problems);
	return tree;
}

/** Every element in the tree, depth first. */
export function* elementsOf(nodes: readonly TreeNode[]): Generator<ElementNode> {
	for (const node of nodes) {
		if (node.type !== "element") continue;
		yield node;
		yield* elementsOf(node.children);
	}
}

/** The path of every binding in the tree (in text and attributes), each once. */
export function valuePathsOf(tree: ElementTree): string[] {
	const paths = new Set<string>();
	const visit = (nodes: readonly TreeNode[]) => {
		for (const node of nodes) {
			if (node.type === "value") paths.add(node.path);
			if (node.type !== "element") continue;
			for (const attribute of node.attributes) {
				for (const part of attribute.value) if (part.type === "value") paths.add(part.path);
			}
			visit(node.children);
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
