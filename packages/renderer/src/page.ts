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
	 * What the Language switcher links to: the page in each of the Site's languages, in their order.
	 * It shows nothing with fewer than two.
	 */
	languageLinks?: readonly LanguageLink[];
	/**
	 * The page in each of the Site's languages it exists in, as `hreflang` alternates (absolute
	 * addresses), `x-default` last; none on a Site with one language.
	 */
	alternates?: readonly PageAlternate[];
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
	 * The Site's own scripts the page runs (ADR 0023): the Site script, then the page's, as paths of
	 * files on the Site's domain, loaded with `defer` after everything else in `<head>`. Never inline.
	 * They run in Edit mode too (ADR 0022); Safe mode (#99) leaves them out.
	 */
	scripts?: readonly string[];
	/**
	 * Renders the page for Edit mode (ADR 0022) rather than for visitors: never indexed, with WebCraft's
	 * own files first in `<head>` and the editable regions tagged. The Site's own scripts (`scripts`)
	 * run there too (ADR 0022); outside scripts never do, and Safe mode (#99) runs none.
	 */
	editMode?: EditModePage;
};

/**
 * One link of the Language switcher: a language's code, its name in its own words and its text
 * direction, where the link goes, and whether it is the page's own language.
 */
export type LanguageLink = { code: string; name: string; direction: "ltr" | "rtl"; href: string; current: boolean };

/** One `hreflang` alternate of a page: a BCP 47 tag (or `x-default`) and the absolute address there. */
export type PageAlternate = { hreflang: string; href: string };

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
	/**
	 * Code mode (ADR 0016): every element is tagged with the Template or Component it comes from
	 * (`RenderOptions.codeSource`: `content` for the page's content, `site` for the Site template)
	 * instead of the editable regions, since selecting an element opens its code.
	 */
	code?: boolean;
};

/**
 * Renders a whole page as an HTML document: `lang` and `dir`, the title, a skip link to the main
 * content, then the Site template with the page's content at its `{{@outlet}}`. The Site template's
 * one <main> gets the id the skip link points at, and `tabindex="-1"` so following the link moves
 * focus there. The first Media image of the page's content loads eagerly with high priority; every
 * other Media image lazily. Pages link the Site's stylesheet and carry no inline styles and no inline
 * scripts: a page showing a theme toggle links its script file, and the Site script and the page's
 * script are files too.
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
	const languageSwitcher = () => languageSwitcherHtml(page.languageLinks ?? [], site);
	const content = renderTree(page.content, {
		values: page.values,
		language: site.language,
		className: page.className,
		media: page.media,
		priorityImage: { given: false },
		component: page.component,
		themeToggle,
		languageSwitcher,
		editRegion: editMode && !editMode.code ? (value) => editMode.region(value, "content") : undefined,
		codeSource: editMode?.code ? "content" : undefined,
	});
	const body = renderTree(page.siteTemplate ?? BUILT_IN_SITE_TEMPLATE, {
		values: page.siteValues ?? (() => undefined),
		language: site.language,
		className: page.className,
		media: page.media,
		outlet: () => content,
		extraAttributes: mainAttributes,
		component: page.component,
		themeToggle,
		languageSwitcher,
		editRegion: editMode && !editMode.code ? (value) => editMode.region(value, "site") : undefined,
		codeSource: editMode?.code ? "site" : undefined,
	});
	return [
		"<!doctype html>",
		`<html lang="${escapeAttribute(site.language)}" dir="${site.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		...(editMode ? editModeHead(editMode) : []),
		`<title>${escapeText(title)}</title>`,
		...(page.alternates ?? []).map(
			(alternate) =>
				`<link rel="alternate" hreflang="${escapeAttribute(alternate.hreflang)}" href="${escapeAttribute(alternate.href)}">`,
		),
		...headStyles(page.styles),
		...(toggles > 0 ? [`<script src="${THEME_TOGGLE_SCRIPT.href}"></script>`] : []),
		...(page.scripts ?? []).map((src) => `<script src="${escapeAttribute(src)}" defer></script>`),
		"</head>",
		"<body>",
		`<a class="${PAGE_HOOKS.skipLinkClass}" href="#${PAGE_HOOKS.mainId}">${escapeText(pageWords(site.language).skipLink)}</a>`,
		body,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/**
 * The Language switcher: a <nav> named in the page's language, holding a list with a link to the page
 * in each language, each named in its own language (`lang`, and `dir` when it differs from the
 * page's), the page's own language marked `aria-current`. Nothing with fewer than two languages.
 */
function languageSwitcherHtml(links: readonly LanguageLink[], site: PageToRender["site"]): string {
	if (links.length < 2) return "";
	const items = links.map((link) => {
		let attributes = ` href="${escapeAttribute(link.href)}" hreflang="${escapeAttribute(link.code)}" lang="${escapeAttribute(link.code)}"`;
		if (link.direction !== site.direction) attributes += ` dir="${link.direction}"`;
		if (link.current) attributes += ' aria-current="true"';
		return `<li><a${attributes}>${escapeText(link.name)}</a></li>`;
	});
	const label = escapeAttribute(pageWords(site.language).languages);
	return `<nav class="wc-language-switcher" aria-label="${label}"><ul>${items.join("")}</ul></nav>`;
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
	/** The Language switcher's name. */
	languages: string;
};

const PAGE_WORDS: Readonly<Record<string, PageWords>> = {
	en: {
		skipLink: "Skip to main content",
		notFoundTitle: "Page not found",
		notFoundText: "There is no page at this address.",
		themeToggle: "Dark theme",
		languages: "Language",
	},
	it: {
		skipLink: "Vai al contenuto principale",
		notFoundTitle: "Pagina non trovata",
		notFoundText: "Non c'è nessuna pagina a questo indirizzo.",
		themeToggle: "Tema scuro",
		languages: "Lingua",
	},
	fr: {
		skipLink: "Aller au contenu principal",
		notFoundTitle: "Page introuvable",
		notFoundText: "Il n’y a aucune page à cette adresse.",
		themeToggle: "Thème sombre",
		languages: "Langue",
	},
	de: {
		skipLink: "Zum Hauptinhalt springen",
		notFoundTitle: "Seite nicht gefunden",
		notFoundText: "Unter dieser Adresse gibt es keine Seite.",
		themeToggle: "Dunkles Design",
		languages: "Sprache",
	},
	es: {
		skipLink: "Ir al contenido principal",
		notFoundTitle: "Página no encontrada",
		notFoundText: "No hay ninguna página en esta dirección.",
		themeToggle: "Tema oscuro",
		languages: "Idioma",
	},
	pt: {
		skipLink: "Ir para o conteúdo principal",
		notFoundTitle: "Página não encontrada",
		notFoundText: "Não há nenhuma página neste endereço.",
		themeToggle: "Tema escuro",
		languages: "Idioma",
	},
	nl: {
		skipLink: "Naar de hoofdinhoud",
		notFoundTitle: "Pagina niet gevonden",
		notFoundText: "Er is geen pagina op dit adres.",
		themeToggle: "Donker thema",
		languages: "Taal",
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
