import { escapeAttribute, escapeText, type RenderOptions, renderTree } from "./html.ts";
import type { ElementTree } from "./tree.ts";

/** One page of a Site, with everything it renders from. */
export type PageToRender = RenderOptions & {
	site: {
		name: string;
		/** The page's language, a BCP 47 tag such as `en`. */
		language: string;
		direction: "ltr" | "rtl";
	};
	/** The page's own title; the document's title is `<title> · <Site name>`. */
	title: string;
	/** The Entry template the page's content renders through. */
	template: ElementTree;
};

/**
 * Renders a whole page as an HTML document: `lang` and `dir`, the title, and the Entry template's
 * output inside `<main>`. Until Sites have their own Site template, the built-in one is just that
 * `<main>` landmark. Pages carry no JavaScript and no inline styles.
 */
export function renderPage(page: PageToRender): string {
	const { site } = page;
	const title = page.title.trim() ? `${page.title} · ${site.name}` : site.name;
	return [
		"<!doctype html>",
		`<html lang="${escapeAttribute(site.language)}" dir="${site.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeText(title)}</title>`,
		"</head>",
		"<body>",
		`<main>${renderTree(page.template, { ...page, language: site.language })}</main>`,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/** Right-to-left scripts, by the language's primary subtag. */
const RIGHT_TO_LEFT = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "ks", "ku", "ps", "sd", "ug", "ur", "yi"]);

/** The text direction of a language, from its BCP 47 tag. */
export function directionOf(language: string): "ltr" | "rtl" {
	const [primary = ""] = language.toLowerCase().split("-");
	return RIGHT_TO_LEFT.has(primary) ? "rtl" : "ltr";
}
