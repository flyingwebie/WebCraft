/**
 * The renderer (ADRs 0002, 0005, 0017): the canonical element tree format Templates are stored in,
 * Template markup (the lossless text view of a tree: parse, check, print), and the code that turns
 * a tree and its values into semantic HTML. It reads nothing itself: core finds the Entry and its
 * published Template and hands them over. It runs inside the web process.
 */
export * from "./body/index.ts";
export { VIDEO_SCRIPT } from "./body/video-script.ts";
export { type QualityCheck, type QualityCheckKind, renderedCheckReport, renderedChecks } from "./checks.ts";
export {
	type CommandNode,
	RESERVED_COMMANDS,
	TEMPLATE_COMMANDS,
	type TemplateCommand,
} from "./commands.ts";
export {
	COMPONENT_ROOT_ATTRIBUTE,
	COMPONENT_SCRIPT_RUNTIME,
	componentLoaderName,
	componentLoaderText,
	componentRootAttributes,
	readComponentLoaderName,
} from "./component-scripts.ts";
export {
	blockPlacement,
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
	placementsInValues,
} from "./components.ts";
export * from "./consent/index.ts";
export {
	type ColourMode,
	normaliseHex,
	normaliseHexWithAlpha,
	SHADE_STEPS,
	TRANSPARENCY_STEPS,
} from "./design-system/colour.ts";
export {
	CASCADE_LAYERS,
	compileStylesheet,
	contentHash,
	phoneWidthOf,
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
	colourSteps,
	DEFAULT_TOKENS,
	type Dimension,
	type DimensionToken,
	type FontToken,
	type Range,
	type Scale,
	type ScaleStep,
	type ShadowLayer,
	type ShadowToken,
	stepRange,
	type TokenRef,
	type Tokens,
	tokenNames,
	UTILITY_ID_PREFIX,
	utilitiesOf,
} from "./design-system/tokens.ts";
export { escapeAttribute, escapeText, safeUrl, schemeOf } from "./escape.ts";
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
export { stableJson } from "./json.ts";
export { canonicalLanguage, type Translations, textIn } from "./languages.ts";
export {
	DEFAULT_ITEM_NAME,
	isLoopInfo,
	isLoopValuePath,
	LOOP_LIMITS,
	LOOP_POSITION,
	LOOP_STATS,
	type LoopCatalogue,
	type LoopInfo,
	type LoopItem,
	type LoopItemPlace,
	type LoopRun,
	type RegionPlace,
	SEARCH_HIT_NAME,
	SEARCH_LOOP,
	SEARCH_QUERY_VALUE,
} from "./loops.ts";
export { escapeMarkdown, escapeMarkdownLine, markdownLink, markdownUrl } from "./markdown.ts";
export { readInlineStyle } from "./markup/inline-style.ts";
export {
	ID_ATTRIBUTE,
	LABEL_ATTRIBUTE,
	type MarkupLocations,
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
export { propsBlockAt } from "./markup/props-block.ts";
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
	type PageComponentScript,
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
export { popupsPlacedIn } from "./popups.ts";
export { boundRoot, mappedBindingPath, type PropBinding, readMetadataJson, readPropBinding } from "./prop-bindings.ts";
export { isPropDeclarationId } from "./prop-identities.ts";
export {
	RETAINED_KEY,
	RETAINED_MAX_LENGTH,
	type RetainedJsonValue,
	retainedPropProblem,
	retainedPropsProblem,
	retainedValueIdentity,
	retainedValues,
} from "./prop-retention.ts";
export { cleanRichText, RICH_TEXT_MAX_LENGTH, richTextToText, richTextTranslation } from "./rich-text.ts";
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
	type InlinePiece,
	inlinePiece,
	MARKER,
	markersOf,
	type RichTextPieces,
	sameMarkers,
	TranslationMarkersError,
} from "./translation.ts";
export {
	type Attribute,
	type AttributePart,
	attributeProblem,
	type CommentNode,
	type ConditionBranch,
	type ConditionNode,
	type ConsentSettingsNode,
	childListsOf,
	commentProblem,
	ELEMENT_TREE_VERSION,
	type ElementNode,
	type ElementTree,
	ElementTreeInvalidError,
	elementProblem,
	elementsOf,
	type FilterCatalogue,
	type FilterFound,
	type FilterNode,
	type FormCatalogue,
	type FormFound,
	type FormNode,
	fixedTextsOf,
	hasText,
	LABEL_MAX_LENGTH,
	type LanguageSwitcherNode,
	type LoopNode,
	labelProblem,
	loopNamesIn,
	type OutletNode,
	type PaginationNode,
	type ParseTreeOptions,
	type PopupCatalogue,
	type PopupFound,
	type PopupNode,
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
	textProblem,
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
