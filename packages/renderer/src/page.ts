import { escapeAttribute, escapeText, renderTree } from "./html.ts";
import type { MediaReader } from "./media.ts";
import type { ElementNode, ElementTree } from "./tree.ts";
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
};

/**
 * Renders a whole page as an HTML document: `lang` and `dir`, the title, a skip link to the main
 * content, then the Site template with the page's content at its `{{@outlet}}`. The Site template's
 * one <main> gets the id the skip link points at, and `tabindex="-1"` so following the link moves
 * focus there. The first Media image of the page's content loads eagerly with high priority; every
 * other Media image lazily. Pages carry no JavaScript and no inline styles.
 */
export function renderPage(page: PageToRender): string {
	const { site } = page;
	const title = page.title.trim() ? `${page.title} · ${site.name}` : site.name;
	const content = renderTree(page.content, {
		values: page.values,
		language: site.language,
		className: page.className,
		media: page.media,
		priorityImage: { given: false },
	});
	const body = renderTree(page.siteTemplate ?? BUILT_IN_SITE_TEMPLATE, {
		values: page.siteValues ?? (() => undefined),
		language: site.language,
		className: page.className,
		media: page.media,
		outlet: () => content,
		extraAttributes: mainAttributes,
	});
	return [
		"<!doctype html>",
		`<html lang="${escapeAttribute(site.language)}" dir="${site.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeText(title)}</title>`,
		"</head>",
		"<body>",
		`<a class="${PAGE_HOOKS.skipLinkClass}" href="#${PAGE_HOOKS.mainId}">${escapeText(pageWords(site.language).skipLink)}</a>`,
		body,
		"</body>",
		"</html>",
		"",
	].join("\n");
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
type PageWords = { skipLink: string; notFoundTitle: string; notFoundText: string };

const PAGE_WORDS: Readonly<Record<string, PageWords>> = {
	en: {
		skipLink: "Skip to main content",
		notFoundTitle: "Page not found",
		notFoundText: "There is no page at this address.",
	},
	it: {
		skipLink: "Vai al contenuto principale",
		notFoundTitle: "Pagina non trovata",
		notFoundText: "Non c'è nessuna pagina a questo indirizzo.",
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
