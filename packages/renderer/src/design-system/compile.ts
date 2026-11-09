/**
 * The Design system compiler (ADR 0009): a Site's published Design system, and what its published
 * pages use, become one stylesheet in cascade layers, declared first so their order never depends on
 * which rules exist:
 *
 * 1. `reset`: a small reset, reduced motion, `[hidden]` always hidden;
 * 2. `tokens`: every token as a custom property on `:root`, and the dark values when dark mode is on
 *    (following the device, or the theme toggle's choice in `data-wc-theme`);
 * 3. `base`: base styles of plain elements, the focus style (its custom properties set from tokens)
 *    and WebCraft's own page parts (the skip link, the theme toggle, a body's callouts and videos,
 *    Forms, the Consent banner);
 * 4. `classes`: the Classes some published element has, then their styles from each breakpoint up;
 * 5. `utilities`: the token utilities some published element has;
 * 6. `custom`: those Classes' own custom CSS, Components' (#63), then the Site-wide custom CSS.
 *
 * Later layers win whatever their selectors, so nobody needs `!important`.
 */
import { createHash } from "node:crypto";
import { focalPointRules } from "../media.ts";
import { buildCss, type CssKind, type CssText } from "./css.ts";
import { BASE_TARGETS, type DesignSystem, designSystemNames } from "./document.ts";

/** The cascade layers, in order. */
export const CASCADE_LAYERS = ["reset", "tokens", "base", "classes", "utilities", "custom"] as const;

/** What a stylesheet is built for: the Classes and utilities published elements use, by id. */
export type StylesheetUse = {
	classIds: ReadonlySet<string>;
	/** Custom CSS of the published Components (#63), in order. */
	componentCss?: readonly CssText[];
};

const RESET = [
	"*,*::before,*::after{box-sizing:border-box}",
	"html{-webkit-text-size-adjust:100%;text-size-adjust:100%}",
	"body{margin:0}",
	"img,picture,video,canvas,svg{max-inline-size:100%;block-size:auto}",
	"input,button,textarea,select{font:inherit}",
	// Hidden is hidden, whatever a Class says (the theme toggle stays hidden without its script).
	"[hidden]{display:none!important}",
	"@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}}",
];

/**
 * WebCraft's own parts of every page: the focus style (from the focus token), the skip link (out of
 * sight until it has focus), the theme toggle, the Language switcher and a Loop's pagination (rows of
 * links, each big enough to tap). They use no token names, which Staff may change,
 * and can be restyled in the Site's custom CSS, never removed.
 */
const PAGE_PARTS = [
	":focus-visible{outline:var(--wc-focus-width) solid var(--wc-focus-color);outline-offset:var(--wc-focus-offset)}",
	".wc-skip-link{position:absolute;inset-block-start:0.5rem;inset-inline-start:0.5rem;z-index:2147483647;padding:0.5rem 1rem;background-color:Canvas;color:CanvasText;text-decoration:underline}",
	".wc-skip-link:not(:focus){clip-path:inset(50%);block-size:1px;inline-size:1px;overflow:hidden;white-space:nowrap;padding:0}",
	".wc-theme-toggle{display:inline-flex;align-items:center;min-block-size:24px;min-inline-size:24px;padding:0.25em 0.75em;border:1px solid currentColor;border-radius:999px;background-color:transparent;color:inherit;font:inherit;cursor:pointer}",
	".wc-language-switcher ul{display:flex;flex-wrap:wrap;gap:0.25em 1em;margin:0;padding:0;list-style:none}",
	".wc-language-switcher a{display:inline-flex;align-items:center;min-block-size:24px;min-inline-size:24px}",
	".wc-language-switcher a[aria-current]{font-weight:bolder}",
	".wc-pagination ul{display:flex;flex-wrap:wrap;align-items:center;gap:0.25em 0.75em;margin:0;padding:0;list-style:none}",
	".wc-pagination a{display:inline-flex;align-items:center;justify-content:center;min-block-size:24px;min-inline-size:24px}",
	".wc-pagination a[aria-current]{font-weight:bolder;text-decoration:none}",
];

/**
 * A body's own hooks (ADR 0018), the only classes a body's HTML has: callouts (`wc-callout`, toned
 * by `data-tone`) and videos (`wc-embed`, a 16:9 box holding the play link, then the player). Each
 * tone's colour is a custom property Staff can set in the Site's custom CSS; the background is the
 * tone mixed into the page's own background colour, so it follows dark values too.
 */
const BODY_PARTS = [
	".wc-callout{--wc-callout-tone:var(--wc-callout-info);margin-block:1em;padding:0.75em 1em;border-inline-start:0.25em solid var(--wc-callout-tone);border-radius:0.25em;background-color:color-mix(in oklab,var(--wc-callout-tone) 12%,Canvas)}",
	".wc-callout[data-tone=success]{--wc-callout-tone:var(--wc-callout-success)}",
	".wc-callout[data-tone=warning]{--wc-callout-tone:var(--wc-callout-warning)}",
	".wc-callout[data-tone=danger]{--wc-callout-tone:var(--wc-callout-danger)}",
	".wc-callout>p{margin:0}",
	".wc-embed{position:relative;margin-inline:0;margin-block:1em;aspect-ratio:16/9;background-color:CanvasText;color:Canvas}",
	".wc-embed>a,.wc-embed>iframe{position:absolute;inset:0;inline-size:100%;block-size:100%;border:0}",
	".wc-embed>a{display:flex;align-items:center;justify-content:center;gap:0.75em;padding:1em;color:inherit;text-align:center;text-decoration:underline}",
	'.wc-embed>a::before{content:"";flex:none;border-block:0.75em solid transparent;border-inline-start:1.25em solid currentColor}',
];

/**
 * Forms' own hooks (`FORM_HOOKS`): fields in a column, labels above their controls, errors in bold
 * beside a bar in the danger colour (text keeps the page's colour, so it reads in light and dark), the error summary boxed, controls big enough to tap, and the honeypot
 * out of sight. Text only for screen readers uses `wc-visually-hidden`. Staff restyle them in the
 * Site's custom CSS.
 */
const FORM_PARTS = [
	".wc-visually-hidden{position:absolute;inline-size:1px;block-size:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}",
	".wc-form{display:grid;gap:1em;margin-block:1em}",
	".wc-form-field{display:grid;gap:0.25em;margin:0;padding:0;border:0;min-inline-size:0}",
	".wc-form-field>legend{padding:0;margin-block-end:0.25em;font-weight:bolder}",
	".wc-form-label{font-weight:bolder}",
	".wc-form-help,.wc-form-note{margin:0;font-size:0.9em;opacity:0.85}",
	".wc-form-error{margin:0;padding-inline-start:0.5em;border-inline-start:0.25em solid var(--wc-callout-danger);font-weight:bolder}",
	".wc-form-field input:not([type=checkbox]):not([type=radio]),.wc-form-field select,.wc-form-field textarea{box-sizing:border-box;inline-size:100%;min-block-size:2.75rem;padding:0.5em 0.75em;border:1px solid currentColor;border-radius:0.25em;background-color:Canvas;color:CanvasText;font:inherit}",
	".wc-form-field [aria-invalid=true]{border-color:var(--wc-callout-danger);outline:1px solid var(--wc-callout-danger)}",
	".wc-form-options{display:grid;gap:0.5em}",
	".wc-form-option{display:flex;align-items:flex-start;gap:0.5em}",
	".wc-form-option input{inline-size:1.5rem;block-size:1.5rem;margin:0;flex:none}",
	".wc-form-errors{padding:1em;border:0.25em solid var(--wc-callout-danger);border-radius:0.25em}",
	".wc-form-errors>h2{margin-block:0 0.5em;font-size:1.25em}",
	".wc-form-errors ul{margin:0;padding-inline-start:1.25em}",
	".wc-form-errors a{color:inherit;font-weight:bolder}",
	".wc-form-submit{justify-self:start;min-block-size:2.75rem;padding:0.5em 1.25em;border:1px solid currentColor;border-radius:0.25em;background-color:CanvasText;color:Canvas;font:inherit;cursor:pointer}",
	".wc-form-sent{padding:1em;border-inline-start:0.25em solid var(--wc-callout-success)}",
	".wc-form-sent>p{margin:0}",
	".wc-form-hp{position:absolute;inset-inline-start:-10000px;inline-size:1px;block-size:1px;overflow:hidden}",
];

/**
 * The Search element's hooks (`SEARCH_HOOKS`): its box and button on one row (wrapping on narrow
 * screens), both big enough to tap, in the page's own colours so they read in light and dark. Staff
 * restyle them in the Site's custom CSS.
 */
const SEARCH_PARTS = [
	".wc-search{display:flex;flex-wrap:wrap;gap:0.5em;margin-block:1em}",
	".wc-search-input{box-sizing:border-box;flex:1 1 12em;min-inline-size:0;min-block-size:2.75rem;padding:0.5em 0.75em;border:1px solid currentColor;border-radius:0.25em;background-color:Canvas;color:CanvasText;font:inherit}",
	".wc-search-button{min-block-size:2.75rem;padding:0.5em 1.25em;border:1px solid currentColor;border-radius:0.25em;background-color:CanvasText;color:Canvas;font:inherit;cursor:pointer}",
];

/**
 * A Filter's hooks (`FILTER_HOOKS`, GLOSSARY.md › Filter): its controls in a column, each labelled
 * above (a toggle's beside its switch), options in a list with their counts at the end, boxes, menus,
 * chips and buttons big enough to tap, in the page's own colours so they read in light and dark. The
 * Apply button hides in Live mode once the Filter script runs. Its layout presets: a top bar is one
 * row of dropdown buttons whose popovers open below them (where browsers anchor popovers); a drawer is
 * a modal dialog rising from the bottom on phones and from the side on wider screens; a Filter that
 * becomes a drawer on phones only (`phone`, below the Design system's smallest breakpoint) shows the
 * dialog's content in place on wider screens. Staff restyle any of it in the Site's custom CSS.
 */
function filterParts(phoneWidth: number): string[] {
	const wide = `@media (min-width:${phoneWidth}px)`;
	const narrow = `@media (max-width:${phoneWidth - 0.02}px)`;
	const inPlace = ".wc-filter[data-wc-phone=drawer]:not([data-wc-layout=drawer])";
	const button =
		"display:inline-flex;align-items:center;gap:0.5em;min-block-size:2.75rem;padding:0.5em 1em;border:1px solid currentColor;border-radius:999px;background-color:Canvas;color:CanvasText;font:inherit;cursor:pointer";
	return [
		".wc-filter{display:grid;gap:1em;margin-block:1em}",
		".wc-filter[aria-busy=true]{cursor:progress}",
		".wc-filter-control{display:grid;gap:0.5em;margin:0;padding:0;border:0;min-inline-size:0}",
		".wc-filter-control>legend{padding:0;margin-block-end:0.5em;font-weight:bolder}",
		".wc-filter-control>label{font-weight:bolder}",
		".wc-filter-control input[type=search],.wc-filter-control input[type=number],.wc-filter-control input[type=date],.wc-filter-control select{box-sizing:border-box;inline-size:100%;min-block-size:2.75rem;padding:0.5em 0.75em;border:1px solid currentColor;border-radius:0.25em;background-color:Canvas;color:CanvasText;font:inherit}",
		".wc-filter-control[data-wc-control=toggle]{display:flex;align-items:center;gap:0.5em}",
		".wc-filter-control[data-wc-control=toggle]>label{font-weight:inherit}",
		".wc-filter-options{display:grid;gap:0.5em;margin:0;padding:0;list-style:none}",
		".wc-filter-options>li{display:flex;align-items:center;gap:0.5em}",
		".wc-filter-options label{display:flex;flex:1;justify-content:space-between;gap:0.5em}",
		".wc-filter-options input,.wc-filter-control[data-wc-control=toggle]>input{inline-size:1.5rem;block-size:1.5rem;margin:0;flex:none}",
		".wc-filter-option-count{font-variant-numeric:tabular-nums}",
		".wc-filter-more>summary{min-block-size:1.5rem;cursor:pointer}",
		".wc-filter-more>ul{margin-block-start:0.5em}",
		".wc-filter-chips{display:flex;flex-wrap:wrap;align-items:center;gap:0.5em}",
		".wc-filter-chips>ul{display:flex;flex-wrap:wrap;gap:0.5em;margin:0;padding:0;list-style:none}",
		".wc-filter-chip{display:inline-flex;align-items:center;min-block-size:1.5rem;padding:0.25em 0.75em;border:1px solid currentColor;border-radius:999px;color:inherit;text-decoration:none}",
		".wc-filter-reset{display:inline-flex;align-items:center;min-block-size:1.5rem;color:inherit}",
		".wc-filter-count{margin:0;font-weight:bolder}",
		".wc-filter-apply{justify-self:start;min-block-size:2.75rem;padding:0.5em 1.25em;border:1px solid currentColor;border-radius:0.25em;background-color:CanvasText;color:Canvas;font:inherit;cursor:pointer}",

		".wc-filter-badge{display:inline-flex;align-items:center;justify-content:center;min-inline-size:1.5em;padding:0 0.4em;border-radius:999px;background-color:CanvasText;color:Canvas;font-size:0.875em;font-variant-numeric:tabular-nums}",
		`.wc-filter-open,.wc-filter-pop-button{${button}}`,
		".wc-filter[data-wc-layout=topbar]{display:flex;flex-wrap:wrap;align-items:flex-end;gap:0.75em}",
		".wc-filter[data-wc-layout=topbar] .wc-filter-control[data-wc-control=sort]{margin-inline-start:auto}",
		".wc-filter[data-wc-layout=topbar]>.wc-filter-chips,.wc-filter[data-wc-layout=topbar]>.wc-filter-count{flex-basis:100%}",
		".wc-filter-pop-panel{box-sizing:border-box;min-inline-size:16em;max-inline-size:min(24em,100vw - 2em);max-block-size:70vh;margin:0;padding:1em;overflow:auto;border:1px solid currentColor;border-radius:0.5em;background-color:Canvas;color:CanvasText}",
		".wc-filter-pop-panel:popover-open{display:grid;gap:1em}",
		"@supports (position-area:block-end){.wc-filter-pop-panel{position-area:block-end span-inline-end;margin-block-start:0.25em;position-try-fallbacks:flip-inline,flip-block}}",
		".wc-filter-drawer[open]{box-sizing:border-box;position:fixed;inset:auto 0 0;display:flex;flex-direction:column;inline-size:100%;max-inline-size:100%;max-block-size:85dvh;margin:0;padding:0;border:0;border-radius:1em 1em 0 0;background-color:Canvas;color:CanvasText}",
		".wc-filter-drawer::backdrop{background-color:#000000a6}",
		".wc-filter-drawer-head,.wc-filter-drawer-foot{display:flex;align-items:center;justify-content:space-between;gap:0.75em;padding:0.5em 1em}",
		".wc-filter-drawer-head{border-block-end:1px solid currentColor}",
		".wc-filter-drawer-foot{border-block-start:1px solid currentColor}",
		".wc-filter-drawer-title{margin:0;font-size:1.25em;font-weight:bolder}",
		".wc-filter-drawer-body{display:grid;gap:1.5em;padding:1em;overflow:auto;flex:1}",
		".wc-filter-close{display:inline-flex;align-items:center;justify-content:center;inline-size:2.75rem;block-size:2.75rem;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:1.5em;cursor:pointer}",
		".wc-filter-drawer-reset{display:inline-flex;align-items:center;min-block-size:2.75rem;color:inherit}",
		".wc-filter-show{min-block-size:2.75rem;padding:0.5em 1.25em;border:1px solid currentColor;border-radius:0.25em;background-color:CanvasText;color:Canvas;font:inherit;cursor:pointer}",
		`${wide}{.wc-filter-drawer[open]{inset:0 auto 0 0;inline-size:min(24rem,100%);max-block-size:100dvh;block-size:100dvh;border-radius:0}${inPlace} .wc-filter-open,${inPlace} .wc-filter-drawer-head,${inPlace} .wc-filter-drawer-foot{display:none}${inPlace} .wc-filter-drawer:not([open]),${inPlace} .wc-filter-drawer:not([open])>.wc-filter-drawer-body{display:contents}}`,
		`${narrow}{.wc-filter[data-wc-phone=drawer] .wc-filter-pop-button{display:none}.wc-filter[data-wc-phone=drawer] .wc-filter-pop-panel{display:grid;position:static;inset:auto;min-inline-size:0;max-inline-size:none;max-block-size:none;padding:0;overflow:visible;border:0}}`,
	];
}

/**
 * The Consent banner's hooks (`CONSENT_HOOKS`, ADR 0020): the banner in its three layouts (a bar along
 * the bottom, a box in a corner, a centred modal dialog), its categories and buttons, the "Cookie
 * settings" button and a held-back embed's placeholder. Colours are the page's own (`Canvas`,
 * `CanvasText`), so they follow dark values and keep their contrast; "Accept all" and "Reject all" look
 * the same. Spacing, corners, shadow and the checkboxes' colour are `--wc-consent-*` custom properties
 * set from the Design tokens (`consentTokens`); Staff restyle any of it in the Site's custom CSS. The
 * banner slides in only for visitors who haven't asked for reduced motion.
 */
const CONSENT_PARTS = [
	".wc-consent{box-sizing:border-box;z-index:2147483646;max-block-size:calc(100dvh - 2rem);overflow:auto;margin:0;padding:var(--wc-consent-space);border:1px solid color-mix(in oklab,CanvasText 30%,Canvas);background-color:Canvas;color:CanvasText;box-shadow:var(--wc-consent-shadow);font:inherit}",
	".wc-consent[data-layout=bar]{position:fixed;inset-inline:0;inset-block-end:0;display:flex;flex-wrap:wrap;align-items:center;gap:var(--wc-consent-space) calc(var(--wc-consent-space) * 2);max-block-size:80dvh;border-inline:0;border-block-end:0}",
	".wc-consent[data-layout=box]{position:fixed;inset-block-end:1rem;inset-inline-end:1rem;inline-size:min(28rem,calc(100% - 2rem));border-radius:var(--wc-consent-radius)}",
	".wc-consent[data-layout=dialog]{inline-size:min(36rem,calc(100% - 2rem));border-radius:var(--wc-consent-radius)}",
	".wc-consent::backdrop{background-color:rgb(0 0 0 / 0.5)}",
	".wc-consent-text{flex:1 1 24rem;min-inline-size:0}",
	".wc-consent-title{margin:0 0 0.25em;font-size:1.25em;line-height:1.3}",
	".wc-consent-message,.wc-consent-policy{margin:0 0 0.5em}",
	".wc-consent a{color:inherit;text-decoration:underline}",
	".wc-consent-categories{flex:1 1 100%;display:grid;gap:0.75em;margin:0 0 var(--wc-consent-space);padding:0;border:0;min-inline-size:0}",
	".wc-consent-category{display:grid;grid-template-columns:auto 1fr;gap:0.125em 0.5em;align-items:center}",
	".wc-consent-category input{inline-size:1.5rem;block-size:1.5rem;margin:0;accent-color:var(--wc-consent-accent)}",
	".wc-consent-category label{font-weight:bolder}",
	".wc-consent-description{grid-column:2;margin:0;font-size:0.9em}",
	".wc-consent-actions{display:flex;flex-wrap:wrap;gap:0.5em}",
	".wc-consent-button{min-block-size:2.75rem;padding:0.5em 1.25em;border:1px solid CanvasText;border-radius:var(--wc-consent-radius);background-color:CanvasText;color:Canvas;font:inherit;cursor:pointer}",
	".wc-consent-button[data-wc-consent-action=choose]{background-color:Canvas;color:CanvasText}",
	".wc-consent-settings{display:inline-flex;align-items:center;min-block-size:24px;min-inline-size:24px;padding:0;border:0;background:none;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}",
	".wc-embed:has(>.wc-consent-placeholder:not([hidden])){aspect-ratio:auto}",
	".wc-consent-placeholder{display:flex;flex-direction:column;justify-content:center;gap:0.75em;min-block-size:12rem;padding:var(--wc-consent-space);border:1px solid CanvasText;background-color:Canvas;color:CanvasText}",
	".wc-consent-placeholder p{margin:0}",
	".wc-consent-placeholder-actions{display:flex;flex-wrap:wrap;align-items:center;gap:0.5em 1em}",
	".wc-consent-remember{display:inline-flex;align-items:center;gap:0.5em;min-block-size:24px}",
	".wc-consent-remember input{inline-size:1.25rem;block-size:1.25rem;margin:0;accent-color:var(--wc-consent-accent)}",
	"@keyframes wc-consent-in{from{opacity:0;translate:0 0.5rem}}",
	"@media (prefers-reduced-motion:no-preference){.wc-consent[data-layout=bar]:not([hidden]),.wc-consent[data-layout=box]:not([hidden]),.wc-consent[open]{animation:wc-consent-in 0.2s ease-out}}",
];

/**
 * The Consent banner's custom properties, from the Design tokens by id (so a rename follows), each
 * with a value of its own while the Site has no such token.
 */
function consentTokens(names: { propertyOf(ref: { token: string; step?: string }): string | undefined }): string {
	const token = (id: string, fallback: string, step?: string) => {
		const property = names.propertyOf({ token: id, step });
		return property ? `var(${property})` : fallback;
	};
	return [
		`--wc-consent-space:${token("space-m", "1rem")};`,
		`--wc-consent-radius:${token("radius-m", "0.5rem")};`,
		`--wc-consent-shadow:${token("shadow-l", "0 10px 15px -3px #0000001a")};`,
		`--wc-consent-accent:${token("colour-primary", "#2563eb", "60")};`,
	].join("");
}

/** Where phones end: the Design system's smallest breakpoint (768 px by default, and without one). */
function phoneWidth(breakpoints: readonly { width: number }[]): number {
	return breakpoints.length > 0 ? Math.min(...breakpoints.map((breakpoint) => breakpoint.width)) : 768;
}

/** The tones of a body's callouts: info follows the primary colour (while the Site has it). */
function calloutTones(primary: string | undefined): string {
	return [
		`--wc-callout-info:${primary ? `var(${primary})` : "#2563eb"};`,
		"--wc-callout-success:#15803d;--wc-callout-warning:#b45309;--wc-callout-danger:#b91c1c;",
	].join("");
}

/** The stylesheet for a Design system and what its pages use. */
export function compileStylesheet(designSystem: DesignSystem, use: StylesheetUse): string {
	const names = designSystemNames(designSystem);
	const build = (css: CssText, kind: CssKind) => buildCss(css, kind, names.print);
	const { tokens } = designSystem;

	const rootTokens: string[] = [];
	const darkTokens: string[] = [];
	for (const property of names.tokens.properties) {
		rootTokens.push(`${property.property}:${property.light};`);
		if (property.dark !== undefined) darkTokens.push(`${property.property}:${property.dark};`);
	}
	const tokenRules = [`:root{color-scheme:light;${rootTokens.join("")}}`];
	if (designSystem.darkMode) {
		const dark = `color-scheme:dark;${darkTokens.join("")}`;
		tokenRules.push(`@media (prefers-color-scheme:dark){:root:not([data-wc-theme=light]){${dark}}}`);
		tokenRules.push(`:root[data-wc-theme=dark]{${dark}}`);
	}

	const focusColour = names.tokens.propertyOf({ token: tokens.focus.colour.colour, step: tokens.focus.colour.step });
	const primary = names.tokens.propertyOf({ token: "colour-primary", step: "60" });
	const baseRules = [
		`:root{--wc-focus-color:var(${focusColour});--wc-focus-width:${tokens.focus.width}px;--wc-focus-offset:${tokens.focus.offset}px;}`,
		`:root{${calloutTones(primary)}}`,
		`:root{${consentTokens(names.tokens)}}`,
	];
	for (const target of BASE_TARGETS) {
		const declarations = build(designSystem.baseStyles[target] ?? [], "declarations");
		if (declarations) baseRules.push(`${target}{${declarations}}`);
	}
	baseRules.push(
		...PAGE_PARTS,
		...BODY_PARTS,
		...FORM_PARTS,
		...SEARCH_PARTS,
		...filterParts(phoneWidth(tokens.breakpoints)),
		...CONSENT_PARTS,
		...focalPointRules(),
	);

	const used = designSystem.classes.filter((each) => use.classIds.has(each.id));
	const classRules: string[] = [];
	for (const each of used) {
		const declarations = build(each.styles, "declarations");
		if (declarations) classRules.push(`.${each.name}{${declarations}}`);
	}
	for (const breakpoint of [...tokens.breakpoints].sort((a, b) => a.width - b.width)) {
		const rules: string[] = [];
		for (const each of used) {
			const declarations = build(each.breakpoints[breakpoint.id] ?? [], "declarations");
			if (declarations) rules.push(`.${each.name}{${declarations}}`);
		}
		if (rules.length > 0) classRules.push(`@media (min-width:${breakpoint.width}px){${rules.join("")}}`);
	}

	const utilityRules = names.utilities
		.filter((utility) => use.classIds.has(utility.id))
		.map((utility) => `.${utility.name}{${utility.property}:var(${names.tokens.propertyOf(utility.ref)})}`);

	const customRules: string[] = [];
	for (const each of used) {
		const css = build(each.css, "nested");
		if (css) customRules.push(`.${each.name}{${css}}`);
	}
	for (const css of use.componentCss ?? []) {
		const built = build(css, "stylesheet");
		if (built) customRules.push(built);
	}
	const siteCss = build(designSystem.customCss, "stylesheet");
	if (siteCss) customRules.push(siteCss);

	const layers: [string, string[]][] = [
		["reset", RESET],
		["tokens", tokenRules],
		["base", baseRules],
		["classes", classRules],
		["utilities", utilityRules],
		["custom", customRules],
	];
	return `${[
		`@layer ${CASCADE_LAYERS.join(", ")};`,
		...layers
			.filter(([, rules]) => rules.length > 0)
			.map(([layer, rules]) => `@layer ${layer} {\n${rules.join("\n")}\n}`),
	].join("\n")}\n`;
}

/** A stylesheet's content hash, which names its file: 16 hexadecimal digits of its SHA-256. */
export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
