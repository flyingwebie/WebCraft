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
export {
	boundaryProblem,
	COMPONENT_LIMITS,
	type ComponentCatalogue,
	type ComponentFound,
	type ComponentInfo,
	componentsPlacedIn,
	isComponentInfo,
	isComponentTag,
	type PlacementNode,
	type PropArgument,
	type PropInfo,
	type PropValue,
	placementsIn,
} from "./components.ts";
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
export { type PlacementRenderer, type RenderOptions, renderTree } from "./html.ts";
export { readInlineStyle } from "./markup/inline-style.ts";
export { ID_ATTRIBUTE, type ParsedMarkup, type ParseMarkupOptions, parseTemplateMarkup } from "./markup/parse.ts";
export { type PrintMarkupOptions, printTemplateMarkup } from "./markup/print.ts";
export {
	type MarkupNotice,
	type MarkupPosition,
	type MarkupProblem,
	TemplateMarkupInvalidError,
} from "./markup/problems.ts";
export {
	type ImagePriority,
	type MediaReader,
	mediaReference,
	mediaReferencesIn,
	type PageMedia,
	renderMediaImage,
} from "./media.ts";
export {
	BUILT_IN_SITE_TEMPLATE,
	builtInNotFoundPage,
	directionOf,
	PAGE_HOOKS,
	type PageToRender,
	pageWords,
	renderPage,
} from "./page.ts";
export { checkSiteTemplate, OUTLET_ONLY_IN_SITE_TEMPLATE, refuseSiteTemplateCommands } from "./page-structure.ts";
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
	type OutletNode,
	type ParseTreeOptions,
	parseElementTree,
	randomElementId,
	TEMPLATE_ELEMENTS,
	type TextNode,
	TREE_LIMITS,
	type TreeCheck,
	type TreeNode,
	type TreeProblem,
	type ValueNode,
	VOID_ELEMENTS,
	valuePathsOf,
} from "./tree.ts";
export { type RichText, richText, type TemplateValue, type ValueReader } from "./values.ts";
