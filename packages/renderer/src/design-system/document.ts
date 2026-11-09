/**
 * The Design system: a Site's Design tokens, Classes, base styles, custom CSS and dark mode setting,
 * stored as one document with a Draft and a published version and published as one item (ADR 0009).
 *
 * - **Classes** are named sets of declarations (for every width, and from each breakpoint up), plus
 *   custom CSS of their own written relative to the Class (`&:hover { … }`). Elements refer to them
 *   by id. Generated Classes come from inline styles in Template markup (`style-<hash>`).
 * - **Base styles** style plain elements (`body`, `h1`, `a`, `nav a`, …) from tokens.
 * - **Custom CSS** is the Site-wide escape hatch, in the last cascade layer.
 *
 * Every save checks the whole document (`designSystemProblems`): names are unique and well formed,
 * the `wc-` prefix is WebCraft's, every reference points at something that exists.
 */
import { normaliseHex, normaliseHexWithAlpha, SHADE_STEPS } from "./colour.ts";
import { type CssKind, type CssNames, type CssPrintNames, type CssText, readCss, referencesIn } from "./css.ts";
import {
	BASE_STEP,
	type Breakpoint,
	DEFAULT_TOKENS,
	type Dimension,
	isShadeStep,
	refKey,
	type Scale,
	type TokenNames,
	type Tokens,
	tokenNames,
	type Utility,
	utilitiesOf,
} from "./tokens.ts";

/** A Class of the Site. */
export type DesignClass = {
	id: string;
	/** The name pages carry, such as `card`. Unique on the Site, never starting with `wc-`. */
	name: string;
	/** Made by WebCraft from an inline style rather than by Staff. */
	generated: boolean;
	/** Declarations for every width. */
	styles: CssText;
	/** Declarations from a breakpoint's width up, by breakpoint id. */
	breakpoints: Record<string, CssText>;
	/** The Class's own custom CSS: declarations and rules nested with `&`. */
	css: CssText;
};

export type DesignSystem = {
	version: 1;
	tokens: Tokens;
	classes: DesignClass[];
	/** Declarations per base style target (`BASE_TARGETS`). */
	baseStyles: Record<string, CssText>;
	/** The Site-wide custom CSS. */
	customCss: CssText;
	/** Whether the Site has dark values, which follow the visitor's device (and the theme toggle). */
	darkMode: boolean;
};

/** The elements base styles can style, in the order the stylesheet sets them. */
export const BASE_TARGETS = [
	"body",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"a",
	"small",
	"mark",
	"code",
	"pre",
	"blockquote",
	"hr",
	"ul",
	"ol",
	"figure",
	"figcaption",
	"table",
	"th",
	"td",
	"nav a",
] as const;

const heading = (size: string) =>
	`margin-block: 0 var(--space-s); font-family: var(--font-heading); font-size: var(--text-${size}); line-height: 1.2;`;

/** The base styles every Site starts with. */
const DEFAULT_BASE_STYLES: Readonly<Record<(typeof BASE_TARGETS)[number], string>> = {
	body: "margin: 0; font-family: var(--font-body); font-size: var(--text-m); line-height: 1.6; color: var(--neutral-95); background-color: var(--neutral-10);",
	h1: heading("4xl"),
	h2: heading("3xl"),
	h3: heading("2xl"),
	h4: heading("xl"),
	h5: heading("l"),
	h6: heading("m"),
	p: "margin-block: 0 var(--space-s);",
	a: "color: var(--primary-70); text-underline-offset: 0.15em;",
	small: "font-size: var(--text-s);",
	mark: "background-color: var(--accent-30); color: inherit;",
	code: "font-family: var(--font-mono); font-size: 0.9em;",
	pre: "overflow-x: auto; margin-block: 0 var(--space-s); padding: var(--space-s); border-radius: var(--radius-m); background-color: var(--neutral-20); font-family: var(--font-mono);",
	blockquote:
		"margin: 0 0 var(--space-s); padding-inline-start: var(--space-m); border-inline-start: 4px solid var(--neutral-40);",
	hr: "margin-block: var(--space-m); border: 0; border-block-start: 1px solid var(--neutral-40);",
	ul: "margin-block: 0 var(--space-s); padding-inline-start: var(--space-l);",
	ol: "margin-block: 0 var(--space-s); padding-inline-start: var(--space-l);",
	figure: "margin: 0 0 var(--space-s);",
	figcaption: "font-size: var(--text-s); color: var(--neutral-80);",
	table: "border-collapse: collapse; margin-block: 0 var(--space-s);",
	th: "padding: var(--space-2xs) var(--space-xs); border-block-end: 1px solid var(--neutral-40); text-align: start;",
	td: "padding: var(--space-2xs) var(--space-xs); border-block-end: 1px solid var(--neutral-30); text-align: start;",
	// Links in navigation stand alone, so each is a target big enough to tap (WCAG 2.5.8).
	"nav a": "display: inline-block; min-block-size: 24px; min-inline-size: 24px; padding-block: var(--space-3xs);",
};

let cachedDefault: DesignSystem | undefined;

/** The Design system every Site starts with, and visitors see until one is published. */
export function defaultDesignSystem(): DesignSystem {
	if (!cachedDefault) {
		const empty: DesignSystem = {
			version: 1,
			tokens: DEFAULT_TOKENS,
			classes: [],
			baseStyles: {},
			customCss: [],
			darkMode: false,
		};
		const names = designSystemNames(empty);
		const baseStyles: Record<string, CssText> = {};
		for (const target of BASE_TARGETS) {
			const read = readCss(DEFAULT_BASE_STYLES[target], "declarations", names.css);
			if ("problems" in read) throw new Error(`The default base style for ${target} is broken.`);
			baseStyles[target] = read.css;
		}
		cachedDefault = { ...empty, baseStyles };
	}
	return structuredClone(cachedDefault);
}

/**
 * A stored Design system, ready to use: sections a stored document lacks (one written before they
 * existed) are the default ones.
 */
export function readDesignSystem(stored: unknown): DesignSystem {
	const fallback = defaultDesignSystem();
	if (!stored || typeof stored !== "object") return fallback;
	const document = stored as Partial<DesignSystem>;
	return {
		version: 1,
		tokens: document.tokens ?? fallback.tokens,
		classes: (document.classes ?? []).map((each) => ({
			id: each.id,
			name: each.name,
			generated: each.generated ?? false,
			styles: each.styles ?? [],
			breakpoints: each.breakpoints ?? {},
			css: each.css ?? [],
		})),
		baseStyles: document.baseStyles ?? fallback.baseStyles,
		customCss: document.customCss ?? [],
		darkMode: document.darkMode ?? false,
	};
}

// ---------------------------------------------------------------------------------------------
// Names

/** What the names in a Design system stand for, and back. */
export type DesignSystemNames = {
	tokens: TokenNames;
	utilities: readonly Utility[];
	/** The id of the Class or utility a class name stands for. */
	classNamed(name: string): string | undefined;
	/** The class name of a Class or utility id. */
	nameOf(id: string): string | undefined;
	/** The ids of every Class and utility. */
	classIds: ReadonlySet<string>;
	/** For reading CSS Staff write. */
	css: CssNames;
	/** For printing and building stored CSS. */
	print: CssPrintNames;
};

export function designSystemNames(designSystem: DesignSystem): DesignSystemNames {
	const tokens = tokenNames(designSystem.tokens);
	const utilities = utilitiesOf(designSystem.tokens);
	const byName = new Map<string, string>();
	const byId = new Map<string, string>();
	for (const each of [...designSystem.classes, ...utilities]) {
		if (!byName.has(each.name)) byName.set(each.name, each.id);
		byId.set(each.id, each.name);
	}
	return {
		tokens,
		utilities,
		classNamed: (name) => byName.get(name),
		nameOf: (id) => byId.get(id),
		classIds: new Set(byId.keys()),
		css: { token: (property) => tokens.refOf(property), className: (name) => byName.get(name) },
		print: { property: (ref) => tokens.propertyOf(ref), className: (id) => byId.get(id) },
	};
}

// ---------------------------------------------------------------------------------------------
// Checks

/** One reason a Design system can't be saved, and where (`classes[2].name`, `tokens.colours[0].light.base`). */
export type DesignSystemProblem = { at: string; message: string; line?: number; column?: number };

/** The Design system can't be saved as it is: `problems` says what and where. */
export class DesignSystemInvalidError extends Error {
	override name = "DesignSystemInvalidError";
	readonly problems: readonly DesignSystemProblem[];
	constructor(problems: readonly DesignSystemProblem[]) {
		super(
			`The Design system can't be saved: ${problems
				.slice(0, 10)
				.map((problem) => `${problem.at || "Design system"}: ${problem.message}`)
				.join("; ")}`,
		);
		this.problems = problems;
	}
}

/** Names of tokens: lower-case letters, digits and dashes, starting with a letter. */
export const TOKEN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Names of scale steps and breakpoints may start with a digit (`2xl`). */
export const STEP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Class names: a letter, then letters, digits, dashes and underscores. */
export const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
/** Ids of tokens and Classes. */
export const DESIGN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** How much a Design system holds at most. */
export const DESIGN_SYSTEM_LIMITS = { classes: 5000, tokensPerKind: 40, scaleSteps: 20, shadowLayers: 6 } as const;

/** Whether a name is one WebCraft keeps for itself (`wc-…`). */
export function isReservedName(name: string): boolean {
	return /^wc(?:-|$)/i.test(name);
}

/** Every reason the Design system can't be saved, or none. */
export function designSystemProblems(designSystem: DesignSystem): DesignSystemProblem[] {
	const problems: DesignSystemProblem[] = [];
	const problem = (at: string, message: string) => problems.push({ at, message });
	tokenProblems(designSystem.tokens, problems);
	if (problems.length > 0) return problems;

	const names = designSystemNames(designSystem);
	const tokenRefs = new Set(names.tokens.properties.map((each) => refKey(each.ref)));
	const breakpointIds = new Set(designSystem.tokens.breakpoints.map((each) => each.id));
	const utilityNames = new Set(names.utilities.map((each) => each.name));
	const classIds = new Set<string>();
	const classNames = new Map<string, number>();

	const checkCss = (css: CssText, at: string) => {
		const { tokens, classes } = referencesIn(css);
		for (const ref of tokens) {
			if (!tokenRefs.has(refKey(ref))) problem(at, "It refers to a token that isn't in the Design system.");
		}
		for (const id of classes) {
			if (!names.classIds.has(id)) problem(at, "It refers to a Class that isn't in the Design system.");
		}
	};

	if (designSystem.classes.length > DESIGN_SYSTEM_LIMITS.classes) {
		problem("classes", `A Design system holds at most ${DESIGN_SYSTEM_LIMITS.classes} Classes.`);
	}
	designSystem.classes.forEach((each, index) => {
		const at = `classes[${index}]`;
		if (!DESIGN_ID.test(each.id) || classIds.has(each.id)) problem(`${at}.id`, "Each Class needs an id of its own.");
		classIds.add(each.id);
		if (!CLASS_NAME.test(each.name)) {
			problem(`${at}.name`, "A Class name is a letter, then letters, digits, dashes and underscores (100 at most).");
		} else if (isReservedName(each.name)) {
			problem(`${at}.name`, "Class names starting with wc- are WebCraft's.");
		} else if (utilityNames.has(each.name)) {
			problem(`${at}.name`, `${each.name} is the name of a token utility.`);
		} else if (classNames.has(each.name)) {
			problem(`${at}.name`, `Another Class is named ${each.name}.`);
		}
		classNames.set(each.name, index);
		checkCss(each.styles, `${at}.styles`);
		checkCss(each.css, `${at}.css`);
		for (const [breakpointId, css] of Object.entries(each.breakpoints)) {
			if (!breakpointIds.has(breakpointId))
				problem(`${at}.breakpoints`, "It names a breakpoint that isn't in the Design system.");
			checkCss(css, `${at}.breakpoints`);
		}
	});
	for (const [target, css] of Object.entries(designSystem.baseStyles)) {
		if (!(BASE_TARGETS as readonly string[]).includes(target))
			problem(`baseStyles.${target}`, `Base styles can't style ${target}.`);
		checkCss(css, `baseStyles.${target}`);
	}
	checkCss(designSystem.customCss, "customCss");
	return problems;
}

function tokenProblems(tokens: Tokens, problems: DesignSystemProblem[]): void {
	const problem = (at: string, message: string) => problems.push({ at, message });
	const ids = new Set<string>();
	const id = (value: string, at: string) => {
		if (!DESIGN_ID.test(value) || ids.has(value)) problem(`${at}.id`, "Each token needs an id of its own.");
		ids.add(value);
	};
	const named = <T extends { name: string }>(list: readonly T[], at: string, pattern: RegExp, what: string) => {
		if (list.length > DESIGN_SYSTEM_LIMITS.tokensPerKind)
			problem(at, `There are at most ${DESIGN_SYSTEM_LIMITS.tokensPerKind} ${what}.`);
		const seen = new Set<string>();
		list.forEach((each, index) => {
			if (!pattern.test(each.name)) {
				problem(`${at}[${index}].name`, "A token name is lower-case letters, digits and dashes.");
			} else if (isReservedName(each.name)) {
				problem(`${at}[${index}].name`, "Names starting with wc- are WebCraft's.");
			} else if (seen.has(each.name)) {
				problem(`${at}[${index}].name`, `Two ${what} are named ${each.name}.`);
			}
			seen.add(each.name);
		});
	};
	const positive = (value: number, at: string, max: number) => {
		if (!Number.isFinite(value) || value <= 0 || value > max) problem(at, `Give a number above 0 and at most ${max}.`);
	};

	const { viewport } = tokens;
	if (!(viewport.min >= 200 && viewport.max <= 4000 && viewport.min < viewport.max)) {
		problem("tokens.viewport", "The viewport runs from at least 200 px to at most 4000 px, the smallest first.");
	}

	named(tokens.colours, "tokens.colours", TOKEN_NAME, "colours");
	tokens.colours.forEach((colour, index) => {
		const at = `tokens.colours[${index}]`;
		id(colour.id, at);
		if (normaliseHex(colour.light.base) !== colour.light.base) problem(`${at}.light.base`, "Give a colour as #rrggbb.");
		if (colour.dark.base !== null && normaliseHex(colour.dark.base) !== colour.dark.base) {
			problem(`${at}.dark.base`, "Give a colour as #rrggbb.");
		}
		for (const mode of ["light", "dark"] as const) {
			for (const [step, value] of Object.entries(colour[mode].steps)) {
				if (!isShadeStep(step) || step === BASE_STEP) {
					problem(
						`${at}.${mode}.steps.${step}`,
						`Only the shades ${SHADE_STEPS.filter((each) => each !== BASE_STEP).join(", ")} can be overridden; 60 is the base colour.`,
					);
				} else if (normaliseHex(value) !== value) {
					problem(`${at}.${mode}.steps.${step}`, "Give a colour as #rrggbb.");
				}
			}
		}
	});

	for (const kind of ["space", "text"] as const) {
		const scale: Scale = tokens[kind];
		const at = `tokens.${kind}`;
		positive(scale.base.min, `${at}.base.min`, 1000);
		positive(scale.base.max, `${at}.base.max`, 1000);
		if (!(scale.ratio.min >= 1 && scale.ratio.min <= 4)) problem(`${at}.ratio.min`, "A ratio is from 1 to 4.");
		if (!(scale.ratio.max >= 1 && scale.ratio.max <= 4)) problem(`${at}.ratio.max`, "A ratio is from 1 to 4.");
		if (scale.steps.length > DESIGN_SYSTEM_LIMITS.scaleSteps)
			problem(`${at}.steps`, `A scale has at most ${DESIGN_SYSTEM_LIMITS.scaleSteps} steps.`);
		named(scale.steps, `${at}.steps`, STEP_NAME, "steps");
		scale.steps.forEach((step, index) => {
			id(step.id, `${at}.steps[${index}]`);
			if (!Number.isInteger(step.exponent) || Math.abs(step.exponent) > 10) {
				problem(`${at}.steps[${index}].exponent`, "An exponent is a whole number from -10 to 10.");
			}
			if (step.size) {
				positive(step.size.min, `${at}.steps[${index}].size.min`, 2000);
				positive(step.size.max, `${at}.steps[${index}].size.max`, 2000);
			}
		});
	}

	named(tokens.fonts, "tokens.fonts", TOKEN_NAME, "fonts");
	tokens.fonts.forEach((font, index) => {
		id(font.id, `tokens.fonts[${index}]`);
		if (font.family.length === 0 || font.family.length > 10)
			problem(`tokens.fonts[${index}].family`, "Give 1 to 10 font names.");
		for (const name of font.family) {
			if (!/^[^"'\\;{}<>\p{Cc}]{1,100}$/u.test(name) || name.trim() !== name) {
				problem(`tokens.fonts[${index}].family`, `${name} isn't a font name: no quotes, backslashes, ; { } < >.`);
			}
		}
	});

	const dimensions = (list: readonly { id: string; value: Dimension }[], at: string) =>
		list.forEach((each, index) => {
			id(each.id, `${at}[${index}]`);
			if (!(each.value.value >= 0 && each.value.value <= 10_000) || !["px", "rem"].includes(each.value.unit)) {
				problem(`${at}[${index}].value`, "Give a length in px or rem, from 0 to 10000.");
			}
		});
	named(tokens.radius, "tokens.radius", STEP_NAME, "radii");
	dimensions(tokens.radius, "tokens.radius");
	named(tokens.widths, "tokens.widths", STEP_NAME, "content widths");
	dimensions(tokens.widths, "tokens.widths");

	named(tokens.shadows, "tokens.shadows", STEP_NAME, "shadows");
	tokens.shadows.forEach((each, index) => {
		const at = `tokens.shadows[${index}]`;
		id(each.id, at);
		if (each.layers.length === 0 || each.layers.length > DESIGN_SYSTEM_LIMITS.shadowLayers) {
			problem(`${at}.layers`, `A shadow has 1 to ${DESIGN_SYSTEM_LIMITS.shadowLayers} layers.`);
		}
		each.layers.forEach((layer, layerIndex) => {
			const lengths = [layer.offsetX, layer.offsetY, layer.blur, layer.spread];
			if (lengths.some((value) => !Number.isFinite(value) || Math.abs(value) > 1000) || layer.blur < 0) {
				problem(
					`${at}.layers[${layerIndex}]`,
					"Offsets, blur and spread are px from -1000 to 1000; blur isn't negative.",
				);
			}
			if (normaliseHexWithAlpha(layer.color) !== layer.color)
				problem(`${at}.layers[${layerIndex}].color`, "Give a colour as #rrggbbaa.");
		});
	});

	named(tokens.breakpoints, "tokens.breakpoints", STEP_NAME, "breakpoints");
	const widths = new Set<number>();
	tokens.breakpoints.forEach((breakpoint: Breakpoint, index) => {
		id(breakpoint.id, `tokens.breakpoints[${index}]`);
		if (!Number.isInteger(breakpoint.width) || breakpoint.width < 100 || breakpoint.width > 10_000) {
			problem(`tokens.breakpoints[${index}].width`, "A breakpoint is a whole number of px from 100 to 10000.");
		} else if (widths.has(breakpoint.width)) {
			problem(`tokens.breakpoints[${index}].width`, `Two breakpoints are ${breakpoint.width} px.`);
		}
		widths.add(breakpoint.width);
	});

	const focus = tokens.focus;
	const focusColour = tokens.colours.find((each) => each.id === focus.colour.colour);
	if (!focusColour || !isShadeStep(focus.colour.step))
		problem("tokens.focus.colour", "The focus colour is a shade of one of the colours.");
	if (!(focus.width >= 1 && focus.width <= 10)) problem("tokens.focus.width", "The focus width is 1 to 10 px.");
	if (!(focus.offset >= -10 && focus.offset <= 20)) problem("tokens.focus.offset", "The focus offset is -10 to 20 px.");

	if (problems.length > 0) return;
	// Every custom property name is the Site's once: a colour named `space` mustn't clash with `--space-…`.
	const seen = new Set<string>();
	for (const { property } of tokenNames(tokens).properties) {
		if (seen.has(property)) problem("tokens", `Two tokens would both be ${property}: rename one.`);
		seen.add(property);
	}
}

/** Reads CSS for one place in the Design system, turning its problems into Design system problems at `at`. */
export function readCssAt(
	text: string,
	kind: CssKind,
	names: CssNames,
	at: string,
	problems: DesignSystemProblem[],
): CssText {
	const read = readCss(text, kind, names);
	if ("css" in read) return read.css;
	for (const each of read.problems) problems.push({ at, ...each });
	return [];
}
