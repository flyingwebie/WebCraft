/**
 * The renderer (ADRs 0002, 0005, 0017): the canonical element tree format Templates are stored in,
 * and the code that turns a tree and its values into semantic HTML. It reads nothing itself: core
 * finds the Entry and its published Template and hands them over. It runs inside the web process.
 * Template markup (parse, validate, print) joins it later.
 */
export { escapeAttribute, escapeText, type RenderOptions, renderTree, safeUrl, type ValueReader } from "./html.ts";
export { directionOf, type PageToRender, renderPage } from "./page.ts";
export {
	type Attribute,
	type AttributePart,
	ELEMENT_TREE_VERSION,
	type ElementNode,
	type ElementTree,
	ElementTreeInvalidError,
	elementsOf,
	type ParseTreeOptions,
	parseElementTree,
	randomElementId,
	TEMPLATE_ELEMENTS,
	type TextNode,
	TREE_LIMITS,
	type TreeNode,
	type TreeProblem,
	type ValueNode,
	VOID_ELEMENTS,
	valuePathsOf,
} from "./tree.ts";
