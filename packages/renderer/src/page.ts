import { PLAYER_ORIGINS } from "./body/video.ts";
import { VIDEO_SCRIPT } from "./body/video-script.ts";
import { COMPONENT_ROOT_ATTRIBUTE, COMPONENT_SCRIPT_RUNTIME } from "./component-scripts.ts";
import {
	consentBannerHtml,
	consentPlaceholderHtml,
	consentSettingsHtml,
	heldScriptsHtml,
	type PageConsent,
} from "./consent/banner.ts";
import { CONSENT_SCRIPT } from "./consent/script.ts";
import { THEME_TOGGLE_SCRIPT } from "./design-system/theme-toggle.ts";
import type { RenderTime } from "./expressions.ts";
import { FILTER_SCRIPT } from "./filters/script.ts";
import { FORM_SCRIPT } from "./forms/script.ts";
import { escapeAttribute, escapeText, type PlacementRenderer, renderTree, safeUrl } from "./html.ts";
import type { LoopRun, RegionPlace } from "./loops.ts";
import { SEARCH_HIT_NAME, SEARCH_LOOP, SEARCH_QUERY_VALUE } from "./loops.ts";
import type { MediaReader } from "./media.ts";
import { type PageSeo, seoTags, sharingTags } from "./seo.ts";
import type { Attribute, ElementNode, ElementTree, FilterNode, TreeNode, ValueNode } from "./tree.ts";
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
	/** The class of a Loop's pagination (`<nav class="wc-pagination">`), a row of links to its pages. */
	paginationClass: "wc-pagination",
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
	checkMarkup?: boolean;
	/** Link to the Site’s ordinary published Accessibility statement Page. */
	footerLink?: { href: string; label: string };
	site: {
		name: string;
		/** The page's language, a BCP 47 tag such as `en`. */
		language: string;
		direction: "ltr" | "rtl";
	};
	/**
	 * The page's own title; without `seo`, the document's title is `<title> · <Site name>`.
	 */
	title: string;
	/**
	 * What the page tells search engines and other sites (`seo.ts`): its whole title, description,
	 * canonical URL, robots noindex, Open Graph and social tags and structured data, worked out by core
	 * from its SEO fields and their fallbacks.
	 */
	seo?: PageSeo;
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
	/** What `{{@form <key>}}` shows, in both templates: the Form, rendered (`renderForm`). Nothing when absent. */
	form?: (formId: string) => string;
	popups?: {
		siteId: string;
		items: {
			id: string;
			title: string;
			tree: ElementTree;
			config: {
				key: string;
				layout: string;
				barPosition: string;
				barBehavior: string;
				animation: string;
				trigger: { kind: string };
				additionalTriggers: { kind: string }[];
			};
		}[];
		reveal: boolean;
	};
	/**
	 * Where the Search element (`{{@search}}`) sends visitors: the Site's search results page in the
	 * page's language, and the query it shows in its box (on the results page). The Search element shows
	 * nothing without it.
	 */
	search?: PageSearch;
	/**
	 * Outside scripts the page's Forms need (a Site's CAPTCHA), asked once the page's templates have
	 * rendered, so only a page showing a Form loads one. They join `outsideScripts`: never in Edit mode.
	 */
	formScripts?: () => readonly PageOutsideScript[];
	/** What each Loop of the Site the page names shows here, in both templates (`RenderOptions.loop`). */
	loop?: (name: string) => LoopRun | undefined;
	/**
	 * What `{{@filter}}` shows, in both templates: the Filter's controls as a GET form (`renderFilter`),
	 * or nothing. A page showing one links the Filter script, which updates its Loop in place.
	 */
	filter?: (node: FilterNode) => string;
	/** Whether a Loop of the Site is narrowed by a Filter the page shows: its output is then a region the script swaps. */
	filtered?: (loop: string) => boolean;
	/** The time the page is rendered, for Conditions reading `now`. */
	time?: RenderTime;
	/** How the page is styled: the Site's published Design system (ADR 0009). */
	styles?: PageStyles;
	/**
	 * The Site's Libraries (ADR 0023): copies WebCraft keeps of script packages, served from the Site's
	 * domain, loaded with `defer` in their order before the Site's own scripts, each checked against its
	 * integrity hash. They run in Edit mode too (ADR 0022), but not in Safe mode.
	 */
	libraries?: readonly PageLibrary[];
	/**
	 * The Site's own scripts the page runs (ADR 0023): the Site script, then the page's, as files on
	 * the Site's domain, loaded with `defer` after the Libraries. Never inline. They run in Edit mode
	 * too (ADR 0022), but not in Safe mode.
	 */
	scripts?: readonly PageScript[];
	/**
	 * The Component scripts of the Site's Components (GLOSSARY.md), by Component: a page loads the
	 * script of each Component whose Placement root it shows (`PlacementRenderer`'s `root`), once
	 * however many Placements it has, after the Site script and before the page script, in the order
	 * of each Component's first Placement on the page, behind WebCraft's runtime that calls each root.
	 * One outside Necessary is held back until visitors accept its category. Like the Site's own
	 * scripts, they run in Edit mode too (ADR 0022), but not in Safe mode.
	 */
	componentScripts?: readonly PageComponentScript[];
	/**
	 * The Site scripts of the Modules running on the Site (SDK 1.3): files on the Site's domain, loaded
	 * with `defer` after the Site's own scripts, each held back until visitors accept its Consent
	 * category, unless it runs before consent (`beforeConsent`, SDK 1.4: it holds back itself what
	 * needs its category, and the page still asks for it). Like outside scripts, they never run in
	 * Edit mode.
	 */
	moduleScripts?: readonly PageModuleScript[];
	/**
	 * The Site's outside scripts (ADR 0022): each loaded where Staff put it (the end of `<head>` or of
	 * `<body>`), its parts in order. They never run in Edit mode: there each shows as a labelled
	 * placeholder instead.
	 */
	outsideScripts?: readonly PageOutsideScript[];
	/**
	 * The Site's Consent banner (ADR 0020), when it asks for consent (not with the mode None). A page
	 * holding something back (an outside script outside Necessary, a body's video) holds it in inert
	 * markup, carries the banner (hidden) and links the consent script, which lets each through once its
	 * category is accepted; so does a page showing the "Cookie settings" button. Never in Edit mode.
	 */
	consent?: PageConsent;
	/**
	 * Renders the page for Edit mode (ADR 0022) rather than for visitors: never indexed, with WebCraft's
	 * own files first in `<head>` and the editable regions tagged. The Site's own scripts and Libraries
	 * run there too (ADR 0022), unless the page is in Safe mode (and leaves them out); outside scripts
	 * never do.
	 */
	editMode?: EditModePage;
};

/** Where a page's Search elements send visitors, and what they show in their box. */
export type PageSearch = { action: string; query: string };

/**
 * One of the Site's Libraries on a page: its name, where the Site serves it and its integrity hash.
 * With `components`, it loads only on a page loading the Component script of one of them (those
 * Component scripts declare it).
 */
export type PageLibrary = { name: string; src: string; integrity: string; components?: readonly string[] };

/** A Component script a page may load: the Component, its name, its loader's address and its Consent category. */
export type PageComponentScript = { componentId: string; name: string; src: string; consentCategory: string };

/** One of the Site's own scripts on a page: the Site script or the page's own, as a file on the Site. */
export type PageScript = { kind: "site" | "page"; src: string };

/** A Module's Site script on a page: the Module, where the Site serves the script, and its Consent category. */
export type PageModuleScript = {
	components?: readonly string[];
	moduleId: string;
	src: string;
	consentCategory: string;
	beforeConsent?: boolean;
};

/** One script tag of an outside script: a file on another host, or one the Site serves. */
export type PageScriptTag = {
	src: string;
	async?: boolean;
	defer?: boolean;
	module?: boolean;
	/** Other attributes kept from a pasted snippet (`id`, `crossorigin`, `data-…`), in order. */
	attributes?: readonly (readonly [string, string])[];
};

/** One of the Site's outside scripts on a page. */
export type PageOutsideScript = {
	id: string;
	/** What Staff call it, shown on its placeholder in Edit mode. */
	name: string;
	placement: "head" | "bodyEnd";
	/** Its Consent category: the Consent banner holds it back until visitors accept it (but Necessary). */
	consentCategory: string;
	tags: readonly PageScriptTag[];
};

/** A rendered page, and what its Content Security Policy must allow for it to work. */
export type RenderedPage = {
	html: string;
	/** Origins the page frames: the players of a body's videos, when it shows one. */
	frames: readonly string[];
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
	placement?: import("./html.ts").RenderOptions["editPlacement"];
	/**
	 * The attributes that tag an element showing `value` alone (or an image whose `src` it is) as an
	 * editable region, or undefined when it isn't editable. `template` is where the binding is: the
	 * page's content or the Site template; `place`, the Loop item it sits in, if any, and whether it is
	 * an image's (`RegionPlace`).
	 */
	region(
		value: ValueNode,
		template: "content" | "site",
		place: RegionPlace,
	): readonly (readonly [string, string])[] | undefined;
	/**
	 * The words of the mark around a Loop of the Site (`RenderOptions.editLoop`): its id, where its
	 * items come from and its name; undefined for one not to mark.
	 */
	loop?(name: string): readonly string[] | undefined;
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
	return renderDocument(page).html;
}

/** Renders a whole page as `renderPage` does, and says what its policy must allow (`RenderedPage`). */
export function renderDocument(page: PageToRender): RenderedPage {
	const { site } = page;
	const title = page.seo ? page.seo.title : page.title.trim() ? `${page.title} · ${site.name}` : site.name;
	const { editMode } = page;
	// The theme toggle shows only with dark values to switch to; its script comes only with it.
	let toggles = 0;
	const themeToggle = () => {
		if (!page.styles?.darkMode) return "";
		toggles++;
		return `<button type="button" class="wc-theme-toggle" aria-pressed="false" hidden>${escapeText(pageWords(site.language).themeToggle)}</button>`;
	};
	const languageSwitcher = () => languageSwitcherHtml(page.languageLinks ?? [], site);
	const words = pageWords(site.language);
	let searches = 0;
	const search = () => (page.search ? searchElementHtml(page.search, ++searches, words) : "");
	// Visitors are asked for consent; people editing never are (ADR 0022).
	const consent = editMode ? undefined : page.consent;
	// The embed script comes only with a video to play; the consent script with something held back.
	const shown = { videos: 0, held: 0, settings: 0 };
	const shownComponents = new Set<string>();
	const loopItemsShown = { count: 0 };
	// The regions of filtered Loops, numbered across both templates; the Filter script comes with a Filter.
	const regions = new Map<string, number>();
	// The forms script comes only with a Form to fill in.
	let formsShown = 0;
	const form = page.form
		? (formId: string) => {
				const html = page.form?.(formId) ?? "";
				if (html.includes('class="wc-form"')) formsShown++;
				return html;
			}
		: undefined;
	let filtersShown = 0;
	const filter = (node: FilterNode) => {
		const html = page.filter?.(node) ?? "";
		if (html) filtersShown++;
		return html;
	};
	const held = consent
		? (embed: { category: string; label: string; source: string }) => {
				shown.held++;
				return { placeholder: consentPlaceholderHtml(consent.words, { ...embed, n: shown.held }) };
			}
		: undefined;
	const consentSettings = () => {
		if (!consent || consent.mode === "outside") return "";
		shown.settings++;
		return consentSettingsHtml(consent.words);
	};
	const popup = (id: string) => {
		const item = page.popups?.items.find((p) => p.id === id);
		return item
			? `<a href="#popup-${escapeAttribute(item.config.key)}" data-wc-popup-open="${id}">${escapeText(item.title)}</a>`
			: "";
	};
	const content = renderTree(page.content, {
		checkMarkup: page.checkMarkup,
		values: page.values,
		language: site.language,
		words,
		shown,
		shownComponents,
		className: page.className,
		media: page.media,
		priorityImage: { given: false },
		component: page.component,
		form,
		popup,
		search,
		loop: page.loop,
		filter,
		filtered: page.filtered,
		regions,
		time: page.time,
		loopItemsShown,
		themeToggle,
		languageSwitcher,
		consentSettings,
		held,
		editRegion: editMode && !editMode.code ? (value, place) => editMode.region(value, "content", place) : undefined,
		editPlacement: editMode && !editMode.code ? editMode.placement : undefined,
		editLoop: editMode && !editMode.code ? (name) => editMode.loop?.(name) : undefined,
		markBodyBlocks: Boolean(editMode && !editMode.code),
		codeSource: editMode?.code || page.checkMarkup ? "content" : undefined,
		showHiddenPlacements: Boolean(editMode),
	});
	let linked = false;
	const footer = () => {
		if (linked || !page.footerLink) return "";
		linked = true;
		return `<a href="${escapeAttribute(safeUrl(page.footerLink.href))}">${escapeText(page.footerLink.label)}</a>`;
	};
	let body = renderTree(page.siteTemplate ?? BUILT_IN_SITE_TEMPLATE, {
		checkMarkup: page.checkMarkup,
		values: page.siteValues ?? (() => undefined),
		language: site.language,
		words,
		shown,
		shownComponents,
		className: page.className,
		media: page.media,
		outlet: () =>
			editMode?.placement && !editMode.code
				? `<!--wc-page-layout-start-->${content}<!--wc-page-layout-end-->`
				: content,
		footer,
		extraAttributes: mainAttributes,
		component: page.component,
		form,
		popup,
		search,
		loop: page.loop,
		filter,
		filtered: page.filtered,
		regions,
		time: page.time,
		loopItemsShown,
		themeToggle,
		languageSwitcher,
		consentSettings,
		held,
		editRegion: editMode && !editMode.code ? (value, place) => editMode.region(value, "site", place) : undefined,
		editLoop: editMode && !editMode.code ? (name) => editMode.loop?.(name) : undefined,
		markBodyBlocks: Boolean(editMode && !editMode.code),
		codeSource: editMode?.code || page.checkMarkup ? "site" : undefined,
		showHiddenPlacements: Boolean(editMode),
	});
	if (page.footerLink && !linked) body += `<footer>${footer()}</footer>`;

	const popupHtml = (page.popups?.items ?? [])
		.map((item) => {
			const inside = renderTree(item.tree, {
				shownComponents,
				values: page.values,
				language: site.language,
				words,
				shown,
				className: page.className,
				media: page.media,
				component: page.component,
				form,
				popup,
				search,
				regions,
				loopItemsShown,
				themeToggle,
				languageSwitcher,
				consentSettings,
				loop: page.loop,
				filter,
				filtered: page.filtered,
				time: page.time,
				held,
			});
			const heading = `<h2 id="wc-popup-title-${item.id}">${escapeText(item.title)}</h2>`;
			const section = `<section id="popup-${escapeAttribute(item.config.key)}" aria-labelledby="wc-popup-title-${item.id}">${heading}${inside}</section>`;
			if (page.popups?.reveal) return section;
			const config = item.config;
			const close = escapeAttribute(words.popupClose);
			return `<template data-site="${escapeAttribute(page.popups?.siteId ?? "")}" data-popup-id="${item.id}" data-wc-popup="${escapeAttribute(JSON.stringify(item.config))}"><dialog class="wc-popup" data-layout="${escapeAttribute(config.layout)}" data-bar-position="${escapeAttribute(config.barPosition)}" data-bar-behavior="${escapeAttribute(config.barBehavior)}" data-animation="${escapeAttribute(item.config.animation)}" aria-labelledby="wc-popup-title-${item.id}"><button type="button" data-wc-popup-close aria-label="${close}">${close}</button>${heading}${inside}</dialog></template>${[item.config.trigger, ...item.config.additionalTriggers].some((t) => t.kind === "click") ? `<noscript>${section}</noscript>` : ""}`;
		})
		.join("");
	// Component scripts, in the order of their Components' first Placement root on the page.
	const rooted = new Set<string>();
	for (const match of `${body}${popupHtml}`.matchAll(new RegExp(` ${COMPONENT_ROOT_ATTRIBUTE}="([^"]*)"`, "g")))
		for (const id of (match[1] ?? "").split(" ")) if (id) rooted.add(id);
	const componentScripts = [...rooted].flatMap((id) => {
		const script = page.componentScripts?.find((candidate) => candidate.componentId === id);
		return script ? [script] : [];
	});
	const libraries = (page.libraries ?? []).filter(
		(library) =>
			!library.components || componentScripts.some((script) => library.components?.includes(script.componentId)),
	);
	const outside = [...(page.outsideScripts ?? []), ...(page.formScripts?.() ?? [])];
	const heldBack = (category: string) => consent !== undefined && category !== "necessary";
	// The banner and its script come only to a page that asks something.
	// Modules' Site scripts, like outside scripts, never run in Edit mode.
	const moduleScripts = editMode
		? []
		: (page.moduleScripts ?? []).filter(
				(script) => !script.components || script.components.some((id) => shownComponents.has(id)),
			);
	const asks =
		consent !== undefined &&
		(shown.held > 0 ||
			shown.settings > 0 ||
			[...outside, ...moduleScripts, ...componentScripts].some((script) => heldBack(script.consentCategory)));
	// Outside scripts never run in Edit mode (ADR 0022): each shows as a placeholder instead. Visitors
	// get those outside Necessary held back until they accept their category.
	const outsideIn = (placement: PageOutsideScript["placement"]) =>
		editMode
			? []
			: outside
					.filter((script) => script.placement === placement)
					.map((script) =>
						heldBack(script.consentCategory)
							? heldScriptsHtml(script.consentCategory, outsideTags(script))
							: outsideTags(script).join("\n"),
					);
	const html = [
		"<!doctype html>",
		`<html lang="${escapeAttribute(site.language)}" dir="${site.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		...(editMode ? editModeHead(editMode) : []),
		`<title>${escapeText(title)}</title>`,
		...(page.seo ? seoTags(page.seo, { editMode: editMode !== undefined }) : []),
		...(page.alternates ?? []).map(
			(alternate) =>
				`<link rel="alternate" hreflang="${escapeAttribute(alternate.hreflang)}" href="${escapeAttribute(alternate.href)}">`,
		),
		// Edit mode is never indexed nor shared: its pages carry the title, description and canonical URL only.
		...(page.seo && !editMode ? sharingTags(page.seo) : []),
		...headStyles(page.styles),
		...(toggles > 0 ? [`<script src="${THEME_TOGGLE_SCRIPT.href}"></script>`] : []),
		...(asks && consent ? consentHead(consent) : []),
		...(shown.videos > 0 ? [`<script src="${VIDEO_SCRIPT.href}" defer></script>`] : []),
		...(filtersShown > 0 ? [`<script src="${FILTER_SCRIPT.href}" defer></script>`] : []),
		...(formsShown > 0 ? [`<script src="${FORM_SCRIPT.href}" defer></script>`] : []),
		...libraries.map((library) => {
			const tag = editMode ? ` data-wc-library="${escapeAttribute(library.name)}"` : "";
			return `<script src="${escapeAttribute(library.src)}" integrity="${escapeAttribute(library.integrity)}" defer${tag}></script>`;
		}),
		...ownScriptTags(page.scripts ?? [], "site", editMode),
		...componentScriptTags(componentScripts, heldBack, editMode),
		...ownScriptTags(page.scripts ?? [], "page", editMode),
		...moduleScripts.map((script) => {
			const tag = `<script src="${escapeAttribute(script.src)}" defer data-wc-module="${escapeAttribute(script.moduleId)}"></script>`;
			return heldBack(script.consentCategory) && !script.beforeConsent
				? heldScriptsHtml(script.consentCategory, [tag])
				: tag;
		}),
		...outsideIn("head"),
		"</head>",
		"<body>",
		`<a class="${PAGE_HOOKS.skipLinkClass}" href="#${PAGE_HOOKS.mainId}">${escapeText(pageWords(site.language).skipLink)}</a>`,
		...(asks && consent && consent.mode !== "outside" ? [consentBannerHtml(consent)] : []),
		body,
		...(popupHtml ? [popupHtml] : []),
		...outsideIn("bodyEnd"),
		...(editMode && outside.length > 0 ? [outsidePlaceholders(outside, words)] : []),
		"</body>",
		"</html>",
		"",
	].join("\n");
	return { html, frames: shown.videos > 0 ? PLAYER_ORIGINS : [] };
}

/** The Site's own scripts of one kind, as a page loads them: deferred, saying which they are in Edit mode. */
function ownScriptTags(scripts: readonly PageScript[], kind: PageScript["kind"], editMode: EditModePage | undefined) {
	return scripts
		.filter((script) => script.kind === kind)
		.map((script) => {
			const tag = editMode ? ` data-wc-script="${script.kind}"` : "";
			return `<script src="${escapeAttribute(script.src)}" defer${tag}></script>`;
		});
}

/**
 * The Component scripts a page loads: WebCraft's runtime (deferred, watching for Placements added
 * later in Edit mode), then each loader as a module script, which runs in order with the deferred
 * scripts; one outside Necessary held back until visitors accept its category. In Edit mode each says
 * which Component it is, so an error can name it.
 */
function componentScriptTags(
	scripts: readonly PageComponentScript[],
	heldBack: (category: string) => boolean,
	editMode: EditModePage | undefined,
): string[] {
	if (scripts.length === 0) return [];
	return [
		`<script src="${COMPONENT_SCRIPT_RUNTIME.href}" defer${editMode ? " data-wc-watch" : ""}></script>`,
		...scripts.map((script) => {
			const tag = editMode
				? ` data-wc-component-script="${escapeAttribute(script.componentId)}" data-wc-component-name="${escapeAttribute(script.name)}"`
				: "";
			const loader = `<script type="module" src="${escapeAttribute(script.src)}"${tag}></script>`;
			return heldBack(script.consentCategory) ? heldScriptsHtml(script.consentCategory, [loader]) : loader;
		}),
	];
}

/**
 * What a page asking for consent says in `<head>`: the Site's mode and banner version, which the
 * consent script (and any other script) reads, then the consent script, deferred and before any other
 * deferred script, so `webcraft.consent` is there for them.
 */
function consentHead(consent: PageConsent): string[] {
	return [
		`<meta name="webcraft-consent-mode" content="${consent.mode}">`,
		`<meta name="webcraft-consent-version" content="${consent.version}">`,
		`<script src="${CONSENT_SCRIPT.href}" defer></script>`,
	];
}

/** An outside script's tags, as visitors' pages load them. */
function outsideTags(script: PageOutsideScript): string[] {
	return script.tags.map((tag) => {
		let attributes = ` src="${escapeAttribute(tag.src)}"`;
		if (tag.module) attributes += ' type="module"';
		if (tag.async) attributes += " async";
		if (tag.defer) attributes += " defer";
		for (const [name, value] of tag.attributes ?? []) attributes += ` ${name}="${escapeAttribute(value)}"`;
		return `<script${attributes}></script>`;
	});
}

/**
 * Where the Site's outside scripts would load, in Edit mode: a labelled placeholder for each, saying it
 * doesn't run while editing (ADR 0022). Edit mode's own stylesheet shows them at the end of the page.
 */
function outsidePlaceholders(scripts: readonly PageOutsideScript[], words: PageWords): string {
	const items = scripts.map(
		(script) =>
			`<li class="wc-outside-script" data-wc-outside-script="${escapeAttribute(script.id)}"><span class="wc-outside-script-name">${escapeText(script.name)}</span> <span class="wc-outside-script-note">${escapeText(words.notWhileEditing)}</span></li>`,
	);
	return `<aside class="wc-outside-scripts" aria-label="${escapeAttribute(words.outsideScripts)}"><ul>${items.join("")}</ul></aside>`;
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

/** The class names WebCraft gives the Search element's parts, styled in the Design system's base layer. */
export const SEARCH_HOOKS = { form: "wc-search", input: "wc-search-input", button: "wc-search-button" } as const;

/** The longest query the Search element's box takes, as Site search reads it (`SEARCH_QUERY_MAX_LENGTH`). */
export const SEARCH_BOX_MAX_LENGTH = 200;

/**
 * The Search element: a GET form to the search results page with one search box, `q`, labelled for
 * screen readers (its button names it for everyone), and the query being shown in it. The first on
 * the page is the page's search landmark; the others are plain forms, so the page has one.
 */
function searchElementHtml(search: PageSearch, index: number, words: PageWords): string {
	const id = `wc-search-${index}`;
	const role = index === 1 ? ' role="search"' : "";
	const value = search.query ? ` value="${escapeAttribute(search.query)}"` : "";
	return [
		`<form class="${SEARCH_HOOKS.form}"${role} method="get" action="${escapeAttribute(safeUrl(search.action))}">`,
		`<label class="wc-visually-hidden" for="${id}">${escapeText(words.searchLabel)}</label>`,
		`<input class="${SEARCH_HOOKS.input}" type="search" id="${id}" name="q"${value} maxlength="${SEARCH_BOX_MAX_LENGTH}" enterkeyhint="search">`,
		`<button class="${SEARCH_HOOKS.button}" type="submit">${escapeText(words.searchButton)}</button>`,
		"</form>",
	].join("");
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
	popupClose: string;
	skipLink: string;
	notFoundTitle: string;
	notFoundText: string;
	themeToggle: string;
	/** The Language switcher's name. */
	languages: string;
	/** A body's video link, before its title: "Play video: Our ovens". */
	playVideo: string;
	/** A video's player title when the video has none. */
	video: string;
	/** Pagination's name, its previous and next links, and a page's link ("Page {n}"). */
	pagination: string;
	previousPage: string;
	nextPage: string;
	pageNumber: string;
	/** The name of the list of outside scripts' placeholders in Edit mode. */
	outsideScripts: string;
	/** What an outside script's placeholder says in Edit mode. */
	notWhileEditing: string;
	/** The built-in Search results template's heading. */
	search: string;
	/** The Search element's label (out of sight, for screen readers) and its button. */
	searchLabel: string;
	searchButton: string;
	/** The hit count: "1 result for “{query}”", "{count} results for “{query}”". */
	searchResult: string;
	searchResults: string;
	/** What the built-in Search results template says when nothing matches, and what to try. */
	searchNone: string;
	searchNoneHint: string;
	/** A search results page's title with a query: "Results for “{query}”". */
	searchTitle: string;
};

const PAGE_WORDS: Readonly<Record<string, PageWords>> = {
	en: {
		popupClose: "Close",
		skipLink: "Skip to main content",
		notFoundTitle: "Page not found",
		notFoundText: "There is no page at this address.",
		themeToggle: "Dark theme",
		languages: "Language",
		playVideo: "Play video",
		video: "Video",
		pagination: "Pages",
		previousPage: "Previous",
		nextPage: "Next",
		pageNumber: "Page {n}",
		outsideScripts: "Outside scripts",
		notWhileEditing: "doesn't run while editing",
		search: "Search",
		searchLabel: "Search the site",
		searchButton: "Search",
		searchResult: "1 result for “{query}”",
		searchResults: "{count} results for “{query}”",
		searchNone: "No results for “{query}”.",
		searchNoneHint: "Check the spelling, or try other words.",
		searchTitle: "Results for “{query}”",
	},
	it: {
		popupClose: "Chiudi",
		skipLink: "Vai al contenuto principale",
		notFoundTitle: "Pagina non trovata",
		notFoundText: "Non c'è nessuna pagina a questo indirizzo.",
		themeToggle: "Tema scuro",
		languages: "Lingua",
		playVideo: "Riproduci il video",
		video: "Video",
		pagination: "Pagine",
		previousPage: "Precedente",
		nextPage: "Successiva",
		pageNumber: "Pagina {n}",
		outsideScripts: "Script esterni",
		notWhileEditing: "non viene eseguito durante la modifica",
		search: "Cerca",
		searchLabel: "Cerca nel sito",
		searchButton: "Cerca",
		searchResult: "1 risultato per «{query}»",
		searchResults: "{count} risultati per «{query}»",
		searchNone: "Nessun risultato per «{query}».",
		searchNoneHint: "Controlla l'ortografia o prova con altre parole.",
		searchTitle: "Risultati per «{query}»",
	},
	fr: {
		popupClose: "Fermer",
		skipLink: "Aller au contenu principal",
		notFoundTitle: "Page introuvable",
		notFoundText: "Il n’y a aucune page à cette adresse.",
		themeToggle: "Thème sombre",
		languages: "Langue",
		playVideo: "Lire la vidéo",
		video: "Vidéo",
		pagination: "Pages",
		previousPage: "Précédente",
		nextPage: "Suivante",
		pageNumber: "Page {n}",
		outsideScripts: "Scripts externes",
		notWhileEditing: "ne s’exécute pas pendant la modification",
		search: "Recherche",
		searchLabel: "Rechercher sur le site",
		searchButton: "Rechercher",
		searchResult: "1 résultat pour « {query} »",
		searchResults: "{count} résultats pour « {query} »",
		searchNone: "Aucun résultat pour « {query} ».",
		searchNoneHint: "Vérifiez l’orthographe ou essayez d’autres mots.",
		searchTitle: "Résultats pour « {query} »",
	},
	de: {
		popupClose: "Schließen",
		skipLink: "Zum Hauptinhalt springen",
		notFoundTitle: "Seite nicht gefunden",
		notFoundText: "Unter dieser Adresse gibt es keine Seite.",
		themeToggle: "Dunkles Design",
		languages: "Sprache",
		playVideo: "Video abspielen",
		video: "Video",
		pagination: "Seiten",
		previousPage: "Zurück",
		nextPage: "Weiter",
		pageNumber: "Seite {n}",
		outsideScripts: "Externe Skripte",
		notWhileEditing: "läuft nicht während der Bearbeitung",
		search: "Suche",
		searchLabel: "Website durchsuchen",
		searchButton: "Suchen",
		searchResult: "1 Ergebnis für „{query}“",
		searchResults: "{count} Ergebnisse für „{query}“",
		searchNone: "Keine Ergebnisse für „{query}“.",
		searchNoneHint: "Prüfen Sie die Schreibweise oder versuchen Sie andere Wörter.",
		searchTitle: "Ergebnisse für „{query}“",
	},
	es: {
		popupClose: "Cerrar",
		skipLink: "Ir al contenido principal",
		notFoundTitle: "Página no encontrada",
		notFoundText: "No hay ninguna página en esta dirección.",
		themeToggle: "Tema oscuro",
		languages: "Idioma",
		playVideo: "Reproducir el vídeo",
		video: "Vídeo",
		pagination: "Páginas",
		previousPage: "Anterior",
		nextPage: "Siguiente",
		pageNumber: "Página {n}",
		outsideScripts: "Scripts externos",
		notWhileEditing: "no se ejecuta mientras se edita",
		search: "Búsqueda",
		searchLabel: "Buscar en el sitio",
		searchButton: "Buscar",
		searchResult: "1 resultado para «{query}»",
		searchResults: "{count} resultados para «{query}»",
		searchNone: "No hay resultados para «{query}».",
		searchNoneHint: "Revisa la ortografía o prueba con otras palabras.",
		searchTitle: "Resultados para «{query}»",
	},
	pt: {
		popupClose: "Fechar",
		skipLink: "Ir para o conteúdo principal",
		notFoundTitle: "Página não encontrada",
		notFoundText: "Não há nenhuma página neste endereço.",
		themeToggle: "Tema escuro",
		languages: "Idioma",
		playVideo: "Reproduzir o vídeo",
		video: "Vídeo",
		pagination: "Páginas",
		previousPage: "Anterior",
		nextPage: "Seguinte",
		pageNumber: "Página {n}",
		outsideScripts: "Scripts externos",
		notWhileEditing: "não é executado durante a edição",
		search: "Pesquisa",
		searchLabel: "Pesquisar no site",
		searchButton: "Pesquisar",
		searchResult: "1 resultado para «{query}»",
		searchResults: "{count} resultados para «{query}»",
		searchNone: "Nenhum resultado para «{query}».",
		searchNoneHint: "Verifique a ortografia ou experimente outras palavras.",
		searchTitle: "Resultados para «{query}»",
	},
	nl: {
		popupClose: "Sluiten",
		skipLink: "Naar de hoofdinhoud",
		notFoundTitle: "Pagina niet gevonden",
		notFoundText: "Er is geen pagina op dit adres.",
		themeToggle: "Donker thema",
		languages: "Taal",
		playVideo: "Video afspelen",
		video: "Video",
		pagination: "Pagina's",
		previousPage: "Vorige",
		nextPage: "Volgende",
		pageNumber: "Pagina {n}",
		outsideScripts: "Externe scripts",
		notWhileEditing: "wordt niet uitgevoerd tijdens het bewerken",
		search: "Zoeken",
		searchLabel: "Zoeken op de site",
		searchButton: "Zoeken",
		searchResult: "1 resultaat voor ‘{query}’",
		searchResults: "{count} resultaten voor ‘{query}’",
		searchNone: "Geen resultaten voor ‘{query}’.",
		searchNoneHint: "Controleer de spelling of probeer andere woorden.",
		searchTitle: "Resultaten voor ‘{query}’",
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

/**
 * The built-in Search results template (ADR 0021), for a Site that hasn't published its own: a
 * heading, the Search element, then for a query either what was found (the hit count, each hit's
 * title linked to its page with its snippet, and links to the other pages of hits) or a message that
 * nothing was, saying what to try. In the page's language.
 */
export function builtInSearchTemplate(language: string): ElementTree {
	const words = pageWords(language);
	const element = (id: string, tag: string, children: TreeNode[], attributes: Attribute[] = []): ElementNode => ({
		type: "element",
		id,
		tag,
		attributes,
		classes: [],
		children,
	});
	const value = (path: string): ValueNode => ({ type: "value", path });
	// A sentence of WebCraft's words with the query and the count in their places.
	const sentence = (text: string): TreeNode[] =>
		text
			.split(/(\{query\}|\{count\})/)
			.filter((part) => part !== "")
			.map((part) =>
				part === "{query}"
					? value(SEARCH_QUERY_VALUE)
					: part === "{count}"
						? value(`${SEARCH_LOOP}.total`)
						: { type: "text", text: part },
			);
	const hit = SEARCH_HIT_NAME;
	const hits: TreeNode[] = [
		{
			type: "condition",
			branches: [
				{
					test: {
						type: "compare",
						operator: "==",
						left: { type: "value", path: `${SEARCH_LOOP}.total` },
						right: { type: "literal", value: 1 },
					},
					children: [element("searchCountOne", "p", sentence(words.searchResult))],
				},
			],
			otherwise: [element("searchCount", "p", sentence(words.searchResults))],
		},
		element("searchHits", "ol", [
			{
				type: "loop",
				source: SEARCH_LOOP,
				alias: hit,
				children: [
					element("searchHit", "li", [
						element("searchHitTitle", "h2", [
							element("searchHitLink", "a", [value(`${hit}.title`)], [{ name: "href", value: [value(`${hit}.url`)] }]),
						]),
						{
							type: "condition",
							branches: [
								{
									test: { type: "value", path: `${hit}.snippet` },
									children: [element("searchHitSnippet", "p", [value(`${hit}.snippet`)])],
								},
							],
							otherwise: null,
						},
					]),
				],
				empty: null,
			},
		]),
		{ type: "pagination", loop: SEARCH_LOOP },
	];
	return {
		version: 1,
		nodes: [
			element("searchHeading", "h1", [{ type: "text", text: words.search }]),
			{ type: "search" },
			{
				type: "condition",
				branches: [
					{
						test: { type: "value", path: SEARCH_QUERY_VALUE },
						children: [
							{
								type: "condition",
								branches: [
									{
										test: { type: "value", path: `${SEARCH_LOOP}.empty` },
										children: [
											element("searchNone", "p", sentence(words.searchNone)),
											element("searchNoneHint", "p", [{ type: "text", text: words.searchNoneHint }]),
										],
									},
								],
								otherwise: hits,
							},
						],
					},
				],
				otherwise: null,
			},
		],
	};
}

/** A search results page's title: its Page's title, or with a query, what it shows hits for. */
export function searchPageTitle(title: string, query: string, language: string): string {
	return query ? pageWords(language).searchTitle.replace("{query}", query) : title;
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
