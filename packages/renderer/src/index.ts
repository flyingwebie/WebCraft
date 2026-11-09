/**
 * The renderer (ADRs 0002, 0005, 0017): the canonical element tree format Templates are stored in,
 * Template markup (the lossless text view of a tree: parse, check, print), and the code that turns
 * a tree and its values into semantic HTML. It reads nothing itself: core finds the Entry and its
 * published Template and hands them over. It runs inside the web process.
 */
export * from "./body/index.ts";
export { VIDEO_SCRIPT } from "./body/video-script.ts";
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
	expansionProblem,
	isComponentInfo,
	isComponentTag,
	type PlacementNode,
	type PropArgument,
	type PropInfo,
	type PropValue,
	placementProblems,
	placementsIn,
} from "./components.ts";
export * from "./consent/index.ts";
export {
	CASCADE_LAYERS,
	compileStylesheet,
	contentHash,
	type StylesheetUse,
} from "./design-system/compile.ts";
export {
	CSS_MAX_LENGTH,
	type CssKind,
	type CssNames,
	type CssPart,
	type CssPrintNames,
	type CssProblem,
	type CssText,
	printCss,
	readCss,
	referencesIn,
} from "./design-system/css.ts";
export {
	BASE_TARGETS,
	CLASS_NAME,
	DESIGN_SYSTEM_LIMITS,
	type DesignClass,
	type DesignSystem,
	DesignSystemInvalidError,
	type DesignSystemNames,
	type DesignSystemProblem,
	defaultDesignSystem,
	designSystemNames,
	designSystemProblems,
	isReservedName,
	readCssAt,
	readDesignSystem,
} from "./design-system/document.ts";
export { DTCG_EXTENSION, type DtcgProblem, exportTokens, importTokens } from "./design-system/dtcg.ts";
export { SCRIPT_PATH, THEME_TOGGLE_SCRIPT } from "./design-system/theme-toggle.ts";
export {
	type Breakpoint,
	type ColourToken,
	DEFAULT_TOKENS,
	type Dimension,
	type DimensionToken,
	type FontToken,
	type Range,
	type Scale,
	type ScaleStep,
	type ShadowLayer,
	type ShadowToken,
	type TokenRef,
	type Tokens,
	tokenNames,
	UTILITY_ID_PREFIX,
	utilitiesOf,
} from "./design-system/tokens.ts";
export { escapeAttribute, escapeText, safeUrl } from "./escape.ts";
export {
	COMPARE_OPERATORS,
	type CompareOperator,
	EXPRESSION_KEYWORDS,
	type Expression,
	passes,
	type RenderTime,
	readExpression,
	writeExpression,
} from "./expressions.ts";
export * from "./filters/index.ts";
export {
	DATE_STYLES,
	type DateStyle,
	FORMATTER_NAMES,
	NUMBER_MAX_DIGITS,
	TRUNCATE_MAX_LENGTH,
	type ValueFormat,
} from "./formatters.ts";
export * from "./forms/index.ts";
export {
	CODE_ATTRIBUTE,
	FILTER_REGION_MARK,
	type PaginationWords,
	type PlacementRenderer,
	type RenderOptions,
	renderTree,
} from "./html.ts";
export { canonicalLanguage, type Translations, textIn } from "./languages.ts";
export {
	DEFAULT_ITEM_NAME,
	isLoopInfo,
	LOOP_LIMITS,
	LOOP_POSITION,
	LOOP_STATS,
	type LoopCatalogue,
	type LoopInfo,
	type LoopItem,
	type LoopItemPlace,
	type LoopRun,
	SEARCH_HIT_NAME,
	SEARCH_LOOP,
	SEARCH_QUERY_VALUE,
} from "./loops.ts";
export { readInlineStyle } from "./markup/inline-style.ts";
export {
	ID_ATTRIBUTE,
	LABEL_ATTRIBUTE,
	type ParsedMarkup,
	type ParseMarkupOptions,
	parseTemplateMarkup,
} from "./markup/parse.ts";
export { type PrintMarkupOptions, printTemplateMarkup } from "./markup/print.ts";
export {
	type MarkupNotice,
	type MarkupPosition,
	type MarkupProblem,
	TemplateMarkupInvalidError,
} from "./markup/problems.ts";
export {
	FOCAL_POINT_STEP,
	focalPointClasses,
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
	builtInSearchTemplate,
	directionOf,
	type EditModePage,
	type LanguageLink,
	PAGE_HOOKS,
	type PageAlternate,
	type PageLibrary,
	type PageModuleScript,
	type PageOutsideScript,
	type PageScript,
	type PageScriptTag,
	type PageSearch,
	type PageStyles,
	type PageToRender,
	pageWords,
	type RenderedPage,
	renderDocument,
	renderPage,
	SEARCH_BOX_MAX_LENGTH,
	SEARCH_HOOKS,
	searchPageTitle,
} from "./page.ts";
export { checkSiteTemplate, OUTLET_ONLY_IN_SITE_TEMPLATE, refuseSiteTemplateCommands } from "./page-structure.ts";
export { cleanRichText, RICH_TEXT_MAX_LENGTH, richTextToText } from "./rich-text.ts";
export {
	cutText,
	type JsonLd,
	jsonLdText,
	type PageSeo,
	type PageSharing,
	type SocialImage,
	seoTags,
	sharingTags,
} from "./seo.ts";
export {
	type Attribute,
	type AttributePart,
	type CommentNode,
	type ConditionBranch,
	type ConditionNode,
	type ConsentSettingsNode,
	childListsOf,
	ELEMENT_TREE_VERSION,
	type ElementNode,
	type ElementTree,
	ElementTreeInvalidError,
	elementsOf,
	type FilterCatalogue,
	type FilterFound,
	type FilterNode,
	type FormCatalogue,
	type FormFound,
	type FormNode,
	hasText,
	LABEL_MAX_LENGTH,
	type LanguageSwitcherNode,
	type LoopNode,
	labelProblem,
	loopNamesIn,
	type OutletNode,
	type PaginationNode,
	type ParseTreeOptions,
	parseElementTree,
	randomElementId,
	type SearchNode,
	searchElementIn,
	TEMPLATE_ELEMENTS,
	type TextNode,
	type ThemeToggleNode,
	TREE_LIMITS,
	type TreeCheck,
	type TreeNode,
	type TreeProblem,
	type ValueNode,
	VOID_ELEMENTS,
	valuePathsOf,
} from "./tree.ts";
export {
	type BodyValue,
	bodyValue,
	isBody,
	isList,
	isPresent,
	isRichText,
	type RichText,
	richText,
	type TemplateValue,
	type TocValue,
	textOf,
	tocValue,
	type ValueReader,
} from "./values.ts";
