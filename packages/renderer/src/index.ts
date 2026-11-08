/**
 * The renderer (ADRs 0002, 0005, 0017): the canonical element tree format Templates are stored in,
 * Template markup (the lossless text view of a tree: parse, check, print), and the code that turns
 * a tree and its values into semantic HTML. It reads nothing itself: core finds the Entry and its
 * published Template and hands them over. It runs inside the web process.
 */
export {
	type CommandNode,
	RESERVED_COMMANDS,
	TEMPLATE_COMMANDS,
	type TemplateCommand,
} from "./commands.ts";
export { escapeAttribute, escapeText, safeUrl } from "./escape.ts";
export {
	COMPARE_OPERATORS,
	type CompareOperator,
	EXPRESSION_KEYWORDS,
	type Expression,
	passes,
	readExpression,
	writeExpression,
} from "./expressions.ts";
export {
	DATE_STYLES,
	type DateStyle,
	FORMATTER_NAMES,
	NUMBER_MAX_DIGITS,
	TRUNCATE_MAX_LENGTH,
	type ValueFormat,
} from "./formatters.ts";
export { type RenderOptions, renderTree } from "./html.ts";
export { readInlineStyle } from "./markup/inline-style.ts";
export { ID_ATTRIBUTE, type ParsedMarkup, type ParseMarkupOptions, parseTemplateMarkup } from "./markup/parse.ts";
export { type PrintMarkupOptions, printTemplateMarkup } from "./markup/print.ts";
export {
	type MarkupNotice,
	type MarkupPosition,
	type MarkupProblem,
	TemplateMarkupInvalidError,
} from "./markup/problems.ts";
export { directionOf, type PageToRender, renderPage } from "./page.ts";
export { cleanRichText, RICH_TEXT_MAX_LENGTH, richTextToText } from "./rich-text.ts";
export {
	type Attribute,
	type AttributePart,
	type CommentNode,
	type ConditionBranch,
	type ConditionNode,
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
export { type RichText, richText, type TemplateValue, type ValueReader } from "./values.ts";
