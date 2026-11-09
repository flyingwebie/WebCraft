/**
 * The Design system compiler (ADR 0009): a Site's published Design system, and what its published
 * pages use, become one stylesheet in cascade layers, declared first so their order never depends on
 * which rules exist:
 *
 * 1. `reset`: a small reset, reduced motion, `[hidden]` always hidden;
 * 2. `tokens`: every token as a custom property on `:root`, and the dark values when dark mode is on
 *    (following the device, or the theme toggle's choice in `data-wc-theme`);
 * 3. `base`: base styles of plain elements, the focus style (its custom properties set from tokens)
 *    and WebCraft's own page parts (the skip link, the theme toggle, a body's callouts and videos);
 * 4. `classes`: the Classes some published element has, then their styles from each breakpoint up;
 * 5. `utilities`: the token utilities some published element has;
 * 6. `custom`: those Classes' own custom CSS, Components' (#63), then the Site-wide custom CSS.
 *
 * Later layers win whatever their selectors, so nobody needs `!important`.
 */
import { createHash } from "node:crypto";

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
 * sight until it has focus) and the theme toggle. They use no token names, which Staff may change,
 * and can be restyled in the Site's custom CSS, never removed.
 */
const PAGE_PARTS = [
	":focus-visible{outline:var(--wc-focus-width) solid var(--wc-focus-color);outline-offset:var(--wc-focus-offset)}",
	".wc-skip-link{position:absolute;inset-block-start:0.5rem;inset-inline-start:0.5rem;z-index:2147483647;padding:0.5rem 1rem;background-color:Canvas;color:CanvasText;text-decoration:underline}",
	".wc-skip-link:not(:focus){clip-path:inset(50%);block-size:1px;inline-size:1px;overflow:hidden;white-space:nowrap;padding:0}",
	".wc-theme-toggle{display:inline-flex;align-items:center;min-block-size:24px;min-inline-size:24px;padding:0.25em 0.75em;border:1px solid currentColor;border-radius:999px;background-color:transparent;color:inherit;font:inherit;cursor:pointer}",
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
	];
	for (const target of BASE_TARGETS) {
		const declarations = build(designSystem.baseStyles[target] ?? [], "declarations");
		if (declarations) baseRules.push(`${target}{${declarations}}`);
	}
	baseRules.push(...PAGE_PARTS, ...BODY_PARTS);

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
