import { VIDEO_SCRIPT } from "./body/video-script.ts";
import { THEME_TOGGLE_SCRIPT } from "./design-system/theme-toggle.ts";
import { escapeAttribute, escapeText, type PlacementRenderer, renderTree } from "./html.ts";
import type { MediaReader } from "./media.ts";
import type { ElementNode, ElementTree, ValueNode } from "./tree.ts";
import type { ValueReader } from "./values.ts";

/**
 * Names WebCraft keeps in every page for its accessibility defaults. The Design system styles them
 * from its base layer: the skip link stays out of sight until it has focus, and every focused
 * element shows a focus style drawn from Design tokens, which can be restyled but not removed.
 */
export const PAGE_HOOKS = {
	/** The id of the page's <main>, which the skip link points at. */
	mainId: "wc-main",
	/** The class of the skip link, the first thing in every page. */
	skipLinkClass: "wc-skip-link",
	/** The CSS custom properties the focus style reads; the Design system sets them from Design tokens. */
	focusStyle: { color: "--wc-focus-color", width: "--wc-focus-width", offset: "--wc-focus-offset" },
	/** The class of a body's callout (`<aside class="wc-callout" data-tone="…">`), the only class a body has besides videos'. */
	calloutClass: "wc-callout",
	/** The class of a body's video (`<figure class="wc-embed">`), which holds its play link, then the player. */
	embedClass: "wc-embed",
	/** The CSS custom properties a callout's tones read, set in the base layer; Staff restyle them in custom CSS. */
	calloutTones: {
		info: "--wc-callout-info",
		success: "--wc-callout-success",
		warning: "--wc-callout-warning",
		danger: "--wc-callout-danger",
	},
} as const;

/**
 * The built-in Site template, for a Site that hasn't published its own: the page's content in <main>,
 * with no header or footer.
 */
export const BUILT_IN_SITE_TEMPLATE: ElementTree = {
	version: 1,
	nodes: [
		{ type: "element", id: "builtInMain", tag: "main", attributes: [], classes: [], children: [{ type: "outlet" }] },
	],
};

/** One page of a Site, with everything it renders from. */
export type PageToRender = {
	site: {
		name: string;
		/** The page's language, a BCP 47 tag such as `en`. */
		language: string;
		direction: "ltr" | "rtl";
	};
	/** The page's own title; the document's title is `<title> · <Site name>`. */
	title: string;
	/**
	 * The page's content, shown where the Site template has `{{@outlet}}`: an Entry through its Entry
	 * template, a Page's layout.
	 */
	content: ElementTree;
	/** What the content's bindings read. */
	values: ValueReader;
	/** The Site template around the content; the built-in one when absent. */
	siteTemplate?: ElementTree;
	/** What the Site template's bindings read; nothing when absent. */
	siteValues?: ValueReader;
	/** The class name of a Class id, for both templates. */
	className?: (classId: string) => string | undefined;
	/** The Site's Media items that `media:<id>` refers to, for both templates. */
	media?: MediaReader;
	/** What Placements show, in both templates: their Components' published trees. */
	component?: PlacementRenderer;
	/** How the page is styled: the Site's published Design system (ADR 0009). */
	styles?: PageStyles;
	/**
	 * Renders the page for Edit mode (ADR 0022) rather than for visitors: never indexed, with WebCraft's
	 * own files first in `<head>` and the editable regions tagged. Edit mode pages carry no script but
	 * WebCraft's own: the Site's scripts (#99) are written only where this is absent or allows them,
	 * and outside scripts never are.
	 */
	editMode?: EditModePage;
};

/** What a page needs from the Site's published Design system. */
export type PageStyles = {
	/** The address of the Site's stylesheet, such as `/_wc/css/3f9a1c2b7d4e5f60.css`. */
	stylesheet: string;
	/** Whether the Design system has dark values, which follow the visitor's device (and the theme toggle). */
	darkMode: boolean;
};

/** What a page rendered for Edit mode adds to what visitors get. */
export type EditModePage = {
	/**
	 * The attributes that tag an element showing `value` alone as an editable region, or undefined
	 * when it isn't editable. `template` is where the binding is: the page's content or the Site template.
	 */
	region(value: ValueNode, template: "content" | "site"): readonly (readonly [string, string])[] | undefined;
	/** `<meta>` elements for WebCraft's own script, by name, such as the Edit mode session's header token. */
	meta: readonly (readonly [name: string, content: string])[];
	/** WebCraft's own scripts, as paths on the Site's domain; they run before anything else on the page. */
	scripts: readonly string[];
	/** WebCraft's own stylesheets, as paths on the Site's domain. */
	stylesheets: readonly string[];
};

/**
 * Renders a whole page as an HTML document: `lang` and `dir`, the title, a skip link to the main
 * content, then the Site template with the page's content at its `{{@outlet}}`. The Site template's
 * one <main> gets the id the skip link points at, and `tabindex="-1"` so following the link moves
 * focus there. The first Media image of the page's content loads eagerly with high priority; every
 * other Media image lazily. Pages link the Site's stylesheet and carry no inline styles and no inline
 * scripts: a page showing a theme toggle links its script file, and no other page has any script.
 */
export function renderPage(page: PageToRender): string {
	const { site } = page;
	const title = page.title.trim() ? `${page.title} · ${site.name}` : site.name;
	const { editMode } = page;
	// The theme toggle shows only with dark values to switch to; its script comes only with it.
	let toggles = 0;
	const themeToggle = () => {
		if (!page.styles?.darkMode) return "";
		toggles++;
		return `<button type="button" class="wc-theme-toggle" aria-pressed="false" hidden>${escapeText(pageWords(site.language).themeToggle)}</button>`;
	};
	const words = pageWords(site.language);
	// The embed script comes only with a video to play.
	const shown = { videos: 0 };
	const content = renderTree(page.content, {
		values: page.values,
		language: site.language,
		words,
		shown,
		className: page.className,
		media: page.media,
		priorityImage: { given: false },
		component: page.component,
		themeToggle,
		editRegion: editMode && ((value) => editMode.region(value, "content")),
	});
	const body = renderTree(page.siteTemplate ?? BUILT_IN_SITE_TEMPLATE, {
		values: page.siteValues ?? (() => undefined),
		language: site.language,
		words,
		shown,
		className: page.className,
		media: page.media,
		outlet: () => content,
		extraAttributes: mainAttributes,
		component: page.component,
		themeToggle,
		editRegion: editMode && ((value) => editMode.region(value, "site")),
	});
	return [
		"<!doctype html>",
		`<html lang="${escapeAttribute(site.language)}" dir="${site.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		...(editMode ? editModeHead(editMode) : []),
		`<title>${escapeText(title)}</title>`,
		...headStyles(page.styles),
		...(toggles > 0 ? [`<script src="${THEME_TOGGLE_SCRIPT.href}"></script>`] : []),
		...(shown.videos > 0 ? [`<script src="${VIDEO_SCRIPT.href}" defer></script>`] : []),
		"</head>",
		"<body>",
		`<a class="${PAGE_HOOKS.skipLinkClass}" href="#${PAGE_HOOKS.mainId}">${escapeText(pageWords(site.language).skipLink)}</a>`,
		body,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/** The page's stylesheet, and the colour schemes it supports when it has dark values. */
function headStyles(styles: PageStyles | undefined): string[] {
	if (!styles) return [];
	return [
		...(styles.darkMode ? ['<meta name="color-scheme" content="light dark">'] : []),
		`<link rel="stylesheet" href="${escapeAttribute(styles.stylesheet)}">`,
	];
}

/**
 * What Edit mode puts in `<head>`, before anything else the page loads: `noindex`, the meta for
 * WebCraft's script, then WebCraft's own scripts (classic and not deferred, so they run before any
 * Site script) and stylesheets. Every one is a file on the Site's domain: nothing is inline.
 */
function editModeHead(editMode: EditModePage): string[] {
	return [
		'<meta name="robots" content="noindex, nofollow">',
		...editMode.meta.map(
			([name, content]) => `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}">`,
		),
		...editMode.scripts.map((src) => `<script src="${escapeAttribute(src)}"></script>`),
		...editMode.stylesheets.map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}">`),
	];
}

function mainAttributes(element: ElementNode): readonly (readonly [string, string])[] {
	return element.tag === "main"
		? [
				["id", PAGE_HOOKS.mainId],
				["tabindex", "-1"],
			]
		: [];
}

/** The words WebCraft itself writes into Site pages, by language. */
type PageWords = {
	skipLink: string;
	notFoundTitle: string;
	notFoundText: string;
	themeToggle: string;
	/** A body's video link, before its title: "Play video: Our ovens". */
	playVideo: string;
	/** A video's player title when the video has none. */
	video: string;
};

const PAGE_WORDS: Readonly<Record<string, PageWords>> = {
	en: {
		skipLink: "Skip to main content",
		notFoundTitle: "Page not found",
		notFoundText: "There is no page at this address.",
		themeToggle: "Dark theme",
		playVideo: "Play video",
		video: "Video",
	},
	it: {
		skipLink: "Vai al contenuto principale",
		notFoundTitle: "Pagina non trovata",
		notFoundText: "Non c'è nessuna pagina a questo indirizzo.",
		themeToggle: "Tema scuro",
		playVideo: "Riproduci il video",
		video: "Video",
	},
};

/**
 * The built-in 404 page, for a Site that hasn't chosen one: its title, and its content for the Site
 * template's outlet (a heading and one sentence), in the page's language.
 */
export function builtInNotFoundPage(language: string): { title: string; content: ElementTree } {
	const words = pageWords(language);
	const element = (id: string, tag: string, text: string): ElementNode => ({
		type: "element",
		id,
		tag,
		attributes: [],
		classes: [],
		children: [{ type: "text", text }],
	});
	return {
		title: words.notFoundTitle,
		content: {
			version: 1,
			nodes: [element("notFoundTitle", "h1", words.notFoundTitle), element("notFoundText", "p", words.notFoundText)],
		},
	};
}

/** WebCraft's own words in a page's language (by its primary subtag), English when it has none. */
export function pageWords(language: string): PageWords {
	const [primary = ""] = language.toLowerCase().split("-");
	return PAGE_WORDS[primary] ?? (PAGE_WORDS.en as PageWords);
}

/** Right-to-left scripts, by the language's primary subtag. */
const RIGHT_TO_LEFT = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "ks", "ku", "ps", "sd", "ug", "ur", "yi"]);

/** The text direction of a language, from its BCP 47 tag. */
export function directionOf(language: string): "ltr" | "rtl" {
	const [primary = ""] = language.toLowerCase().split("-");
	return RIGHT_TO_LEFT.has(primary) ? "rtl" : "ltr";
}
