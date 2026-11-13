// Element trees for tests, written briefly: `tree(element("article", [element("h1", [value("title")])]))`.
// Comments, Conditions and value formatters are written out as the stored shapes they are;
// `outlet()` is the Site template's `{{@outlet}}`; `placement(componentId, { heading: "Hi" })` places
// a Component with its Prop values.
// The shapes are the stored, canonical form (ADR 0002) that the Management API takes and answers.
// Element ids are left out, as a new element arrives from an editor; WebCraft fills them in.

/** A value's formatter, as stored. */
export type TestFormat =
	| { type: "date"; style?: string }
	| { type: "number"; digits?: number }
	| { type: "truncate"; length: number };

/** A value read where the page renders, optionally through a formatter. */
export type TestValue = { type: "value"; path: string; format?: TestFormat };

/** A piece of an attribute's value: fixed text, or a value read where the page renders. */
export type TestAttributePart = { type: "text"; text: string } | TestValue;

/** A Condition's test, as stored. */
export type TestExpression =
	| { type: "value"; path: string }
	| { type: "literal"; value: string | number | boolean }
	| { type: "now" }
	| { type: "not"; operand: TestExpression }
	| { type: "and" | "or"; left: TestExpression; right: TestExpression }
	| {
			type: "compare";
			operator: "==" | "!=" | "<" | "<=" | ">" | ">=" | "contains";
			left: TestExpression;
			right: TestExpression;
	  };

export type TestNode =
	| {
			type: "element";
			id?: string;
			tag: string;
			/** The layer label Staff gave it in the builder, never rendered. */
			label?: string;
			attributes: { name: string; value: TestAttributePart[] }[];
			classes: string[];
			children: TestNode[];
	  }
	| { type: "text"; text: string }
	| TestValue
	| { type: "comment"; text: string }
	| {
			type: "condition";
			branches: { test: TestExpression; children: TestNode[] }[];
			otherwise: TestNode[] | null;
	  }
	| { type: "outlet" }
	| { type: "form"; form: string }
	| { type: "search" }
	| { type: "loop"; source: string; alias: string; children: TestNode[]; empty: TestNode[] | null }
	| { type: "pagination"; loop: string }
	| {
			type: "component";
			id?: string;
			component: string;
			props: { name: string; value: TestAttributePart[] }[];
	  };

export type TestTree = { version: 1; nodes: TestNode[] };

/** `{{@search}}`: the Search element, sending visitors to the Site's search results page. */
export function searchElement(): TestNode {
	return { type: "search" };
}

/** `{{@form <key>}}`: one of the Site's Forms, by id. */
export function placedForm(formId: string): TestNode {
	return { type: "form", form: formId };
}

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

/**
 * An element (or Placement) with the id a test refers to it by, and optionally its layer label and
 * Classes, as the visual builder sends them.
 */
export function withId(id: string, node: TestNode, more: { label?: string; classes?: string[] } = {}): TestNode {
	return { ...node, id, ...more } as TestNode;
}

export function text(content: string): TestNode {
	return { type: "text", text: content };
}

/** The Site template's content outlet, `{{@outlet}}`: where each page's content goes. */
export function outlet(): TestNode {
	return { type: "outlet" };
}

/** A Placement of a Component, with its Prop values (fixed text, or text and values). */
export function placement(componentId: string, props: Record<string, string | TestAttributePart[]> = {}): TestNode {
	return {
		type: "component",
		component: componentId,
		props: Object.entries(props).map(([name, value]) => ({
			name,
			value: typeof value === "string" ? (value ? [{ type: "text", text: value }] : []) : value,
		})),
	};
}

/** A binding: the value at `path` (`title`, a Field key) where the page renders. */
export function value(path: string): { type: "value"; path: string } {
	return { type: "value", path };
}
