// Element trees for tests, written briefly: `tree(element("article", [element("h1", [value("title")])]))`.
// The shapes are the stored, canonical form (ADR 0002) that the Management API takes and answers.
// Element ids are left out, as a new element arrives from an editor; WebCraft fills them in.

/** A piece of an attribute's value: fixed text, or a value read where the page renders. */
export type TestAttributePart = { type: "text"; text: string } | { type: "value"; path: string };

export type TestNode =
	| {
			type: "element";
			id?: string;
			tag: string;
			attributes: { name: string; value: TestAttributePart[] }[];
			classes: string[];
			children: TestNode[];
	  }
	| { type: "text"; text: string }
	| { type: "value"; path: string };

export type TestTree = { version: 1; nodes: TestNode[] };

export function tree(...nodes: TestNode[]): TestTree {
	return { version: 1, nodes };
}

export function element(
	tag: string,
	children: TestNode[] = [],
	attributes: Record<string, string | TestAttributePart[]> = {},
): TestNode {
	return {
		type: "element",
		tag,
		attributes: Object.entries(attributes).map(([name, value]) => ({
			name,
			value: typeof value === "string" ? [{ type: "text", text: value }] : value,
		})),
		classes: [],
		children,
	};
}

export function text(content: string): TestNode {
	return { type: "text", text: content };
}

/** A binding: the value at `path` (`title`, a Field key) where the page renders. */
export function value(path: string): { type: "value"; path: string } {
	return { type: "value", path };
}
