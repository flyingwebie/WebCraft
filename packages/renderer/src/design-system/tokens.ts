/**
 * Design tokens: a Site's named design values (colours, fluid spacing and type scales, fonts,
 * radius, shadows, breakpoints, content widths and the focus style). Each token has an id that
 * never changes, so CSS and element trees refer to it by id and renaming it changes every use. Each
 * token (a colour's every shade) becomes a CSS custom property in the stylesheet's `tokens` layer,
 * such as `--primary-70`, `--space-m` or `--font-body`; breakpoints are used by Classes instead.
 *
 * Fluid scales grow with the viewport: each step has a size at the smallest viewport and one at the
 * largest, from the scale's base size and ratio (`base × ratio^exponent`), and is written as a CSS
 * `clamp()` in between. Any step can be given its own sizes instead.
 */
import { BASE_STEP, COLOUR_STEPS, type ColourMode, colourRamp, SHADE_STEPS } from "./colour.ts";

/** From the smallest to the largest viewport, or a size at each, in px. */
export type Range = { min: number; max: number };

/** A length as DTCG writes it. */
export type Dimension = { value: number; unit: "px" | "rem" };

export type ColourToken = {
	id: string;
	/** Names its custom properties: `--<name>-<step>`. */
	name: string;
	light: { base: string; steps: Record<string, string> };
	/** The dark values; the base is the light one when null. Used when the Site has dark mode on. */
	dark: { base: string | null; steps: Record<string, string> };
};

export type ScaleStep = {
	id: string;
	name: string;
	/** The step's size is `base × ratio^exponent`, at each end. */
	exponent: number;
	/** Sizes of the step's own, in place of the scale's; null to follow the scale. */
	size: Range | null;
};

export type Scale = { base: Range; ratio: Range; steps: ScaleStep[] };

export type FontToken = { id: string; name: string; family: string[] };
export type DimensionToken = { id: string; name: string; value: Dimension };

/** One shadow, as DTCG writes it: lengths in px and a colour as `#rrggbbaa`. */
export type ShadowLayer = {
	offsetX: number;
	offsetY: number;
	blur: number;
	spread: number;
	color: string;
	inset: boolean;
};

export type ShadowToken = { id: string; name: string; layers: ShadowLayer[] };

/** A width from which a Class's styles for it apply (mobile first), in px. */
export type Breakpoint = { id: string; name: string; width: number };

/** A colour step: a colour token and one of its steps. */
export type ColourRef = { colour: string; step: string };

export type Tokens = {
	/** The viewport widths fluid scales run between, in px. */
	viewport: Range;
	colours: ColourToken[];
	space: Scale;
	text: Scale;
	fonts: FontToken[];
	radius: DimensionToken[];
	shadows: ShadowToken[];
	breakpoints: Breakpoint[];
	widths: DimensionToken[];
	/** The focus style every page has: its colour (a colour step), and its width and offset in px. */
	focus: { colour: ColourRef; width: number; offset: number };
};

/** The kinds of token with a custom property each, and the prefix of their names. */
export const TOKEN_PREFIXES = {
	space: "space",
	text: "text",
	fonts: "font",
	radius: "radius",
	shadows: "shadow",
	widths: "width",
} as const;

const scaleSteps = (prefix: string, steps: readonly (readonly [string, number])[]): ScaleStep[] =>
	steps.map(([name, exponent]) => ({ id: `${prefix}-${name}`, name, exponent, size: null }));

const shadow = (...layers: [number, number, number, number, string][]): ShadowLayer[] =>
	layers.map(([offsetX, offsetY, blur, spread, color]) => ({ offsetX, offsetY, blur, spread, color, inset: false }));

const FONT_STACK = ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"];

/**
 * The tokens every Site starts with. Their ids are fixed words, so a Site that never saved its
 * Design system and one that did refer to them the same way; tokens Staff add get random ids.
 */
export const DEFAULT_TOKENS: Tokens = {
	viewport: { min: 360, max: 1440 },
	colours: [
		["primary", "#2563eb"],
		["secondary", "#0d9488"],
		["accent", "#db2777"],
		["neutral", "#71717a"],
	].map(([name = "", base = ""]) => ({
		id: `colour-${name}`,
		name,
		light: { base, steps: {} },
		dark: { base: null, steps: {} },
	})),
	space: {
		base: { min: 16, max: 20 },
		ratio: { min: 1.5, max: 1.5 },
		steps: scaleSteps("space", [
			["3xs", -4],
			["2xs", -3],
			["xs", -2],
			["s", -1],
			["m", 0],
			["l", 1],
			["xl", 2],
			["2xl", 3],
			["3xl", 4],
		]),
	},
	text: {
		base: { min: 16, max: 18 },
		ratio: { min: 1.2, max: 1.25 },
		steps: scaleSteps("text", [
			["xs", -2],
			["s", -1],
			["m", 0],
			["l", 1],
			["xl", 2],
			["2xl", 3],
			["3xl", 4],
			["4xl", 5],
		]),
	},
	fonts: [
		{ id: "font-body", name: "body", family: FONT_STACK },
		{ id: "font-heading", name: "heading", family: FONT_STACK },
		{
			id: "font-mono",
			name: "mono",
			family: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
		},
	],
	radius: [
		["s", 4],
		["m", 8],
		["l", 16],
		["full", 9999],
	].map(([name, value]) => ({ id: `radius-${name}`, name: String(name), value: { value: Number(value), unit: "px" } })),
	shadows: [
		{ id: "shadow-s", name: "s", layers: shadow([0, 1, 2, 0, "#0000000f"], [0, 1, 3, 0, "#0000001a"]) },
		{ id: "shadow-m", name: "m", layers: shadow([0, 4, 6, -1, "#0000001a"], [0, 2, 4, -2, "#0000001a"]) },
		{ id: "shadow-l", name: "l", layers: shadow([0, 10, 15, -3, "#0000001a"], [0, 4, 6, -4, "#0000001a"]) },
	],
	// The smallest named breakpoint is where phones end: 768 px.
	breakpoints: [
		["md", 768],
		["lg", 1024],
		["xl", 1280],
		["2xl", 1536],
	].map(([name, width]) => ({ id: `breakpoint-${name}`, name: String(name), width: Number(width) })),
	widths: [
		["narrow", 40],
		["content", 72],
		["wide", 90],
	].map(([name, value]) => ({ id: `width-${name}`, name: String(name), value: { value: Number(value), unit: "rem" } })),
	focus: { colour: { colour: "colour-primary", step: "70" }, width: 2, offset: 2 },
};

// ---------------------------------------------------------------------------------------------
// Values

/** A step's sizes at the smallest and largest viewport, in px. */
export function stepRange(scale: Scale, step: ScaleStep): Range {
	if (step.size) return step.size;
	return {
		min: round(scale.base.min * scale.ratio.min ** step.exponent, 2),
		max: round(scale.base.max * scale.ratio.max ** step.exponent, 2),
	};
}

/**
 * A size that grows (or shrinks) evenly from `range.min` at the smallest viewport to `range.max` at
 * the largest, and stays at those sizes beyond them: `clamp(1rem, 0.9167rem + 0.3704vw, 1.25rem)`.
 */
export function fluidSize(range: Range, viewport: Range): string {
	const { min, max } = range;
	if (Math.abs(max - min) < 0.005) return `${number(min / 16)}rem`;
	const slope = (max - min) / (viewport.max - viewport.min);
	const intercept = min - slope * viewport.min;
	const preferred = `${number(intercept / 16)}rem + ${number(slope * 100)}vw`;
	return `clamp(${number(Math.min(min, max) / 16)}rem, ${preferred}, ${number(Math.max(min, max) / 16)}rem)`;
}

/** A number for CSS: at most 4 decimals, no trailing zeros. */
export function number(value: number): string {
	const rounded = round(value, 4);
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function dimensionCss(dimension: Dimension): string {
	return `${number(dimension.value)}${dimension.value === 0 ? "" : dimension.unit}`;
}

export function shadowCss(layers: readonly ShadowLayer[]): string {
	return layers
		.map((layer) => {
			const lengths = [layer.offsetX, layer.offsetY, layer.blur, layer.spread].map((value) =>
				value === 0 ? "0" : `${number(value)}px`,
			);
			return `${layer.inset ? "inset " : ""}${lengths.join(" ")} ${layer.color}`;
		})
		.join(", ");
}

/** Font family names CSS knows without quotes. */
const GENERIC_FAMILIES = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-serif",
	"ui-sans-serif",
	"ui-monospace",
	"ui-rounded",
	"math",
	"emoji",
	"fangsong",
]);

const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);

const UNQUOTED_FAMILY = /^-?[A-Za-z_][A-Za-z0-9_-]*(?: [A-Za-z_][A-Za-z0-9_-]*)*$/;

/** A font family list for CSS: names that are identifiers as they are, the rest quoted. */
export function fontFamilyCss(family: readonly string[]): string {
	return family
		.map((name) =>
			GENERIC_FAMILIES.has(name) ||
			(UNQUOTED_FAMILY.test(name) && !name.split(" ").some((word) => CSS_WIDE_KEYWORDS.has(word.toLowerCase())))
				? name
				: `"${name}"`,
		)
		.join(",");
}

/** A colour's every step in one mode: the light ramp, or the dark one from the dark base. */
export function colourSteps(colour: ColourToken, mode: ColourMode): Record<string, string> {
	return mode === "light"
		? colourRamp(colour.light.base, "light", colour.light.steps)
		: colourRamp(colour.dark.base ?? colour.light.base, "dark", colour.dark.steps);
}

// ---------------------------------------------------------------------------------------------
// Names

/** A reference to a token from CSS: a token's id, and a colour's step. */
export type TokenRef = { token: string; step?: string };

/** The custom property name of every token (`--primary-70`), and back, by reference. */
export type TokenNames = {
	/** The reference a custom property name (with `--`) stands for. */
	refOf(property: string): TokenRef | undefined;
	/** The custom property name (with `--`) of a reference, if the token exists. */
	propertyOf(ref: TokenRef): string | undefined;
	/** Every custom property, in the order the stylesheet sets them, with its value in each mode. */
	properties: readonly { property: string; ref: TokenRef; light: string; dark?: string }[];
};

export function refKey(ref: TokenRef): string {
	return ref.step === undefined ? ref.token : `${ref.token}:${ref.step}`;
}

export function tokenNames(tokens: Tokens): TokenNames {
	const properties: { property: string; ref: TokenRef; light: string; dark?: string }[] = [];
	for (const colour of tokens.colours) {
		const light = colourSteps(colour, "light");
		const dark = colourSteps(colour, "dark");
		for (const step of COLOUR_STEPS) {
			properties.push({
				property: `--${colour.name}-${step}`,
				ref: { token: colour.id, step },
				light: light[step] ?? "",
				dark: dark[step] ?? "",
			});
		}
	}
	for (const [kind, scale] of [
		["space", tokens.space],
		["text", tokens.text],
	] as const) {
		for (const step of scale.steps) {
			properties.push({
				property: `--${TOKEN_PREFIXES[kind]}-${step.name}`,
				ref: { token: step.id },
				light: fluidSize(stepRange(scale, step), tokens.viewport),
			});
		}
	}
	for (const font of tokens.fonts) {
		properties.push({ property: `--font-${font.name}`, ref: { token: font.id }, light: fontFamilyCss(font.family) });
	}
	for (const radius of tokens.radius) {
		properties.push({ property: `--radius-${radius.name}`, ref: { token: radius.id }, light: dimensionCss(radius.value) });
	}
	for (const each of tokens.shadows) {
		properties.push({ property: `--shadow-${each.name}`, ref: { token: each.id }, light: shadowCss(each.layers) });
	}
	for (const width of tokens.widths) {
		properties.push({ property: `--width-${width.name}`, ref: { token: width.id }, light: dimensionCss(width.value) });
	}
	const byProperty = new Map(properties.map((each) => [each.property, each.ref]));
	const byRef = new Map(properties.map((each) => [refKey(each.ref), each.property]));
	return {
		refOf: (property) => byProperty.get(property),
		propertyOf: (ref) => byRef.get(refKey(ref)),
		properties,
	};
}

/** Whether a colour step names a shade (overridable, a focus colour) rather than a transparency. */
export function isShadeStep(step: string): boolean {
	return (SHADE_STEPS as readonly string[]).includes(step);
}

export { BASE_STEP };

// ---------------------------------------------------------------------------------------------
// Utilities

/**
 * Token utilities: one-declaration classes generated from tokens (`bg-primary-10`, `p-m`,
 * `text-xl`), a supplement to Classes (ADR 0009). Elements name them like Classes; the stylesheet
 * holds only those some published element uses.
 */
export const UTILITIES = [
	{ prefix: "color", kind: "colours", property: "color" },
	{ prefix: "bg", kind: "colours", property: "background-color" },
	{ prefix: "border", kind: "colours", property: "border-color" },
	{ prefix: "p", kind: "space", property: "padding" },
	{ prefix: "px", kind: "space", property: "padding-inline" },
	{ prefix: "py", kind: "space", property: "padding-block" },
	{ prefix: "m", kind: "space", property: "margin" },
	{ prefix: "mx", kind: "space", property: "margin-inline" },
	{ prefix: "my", kind: "space", property: "margin-block" },
	{ prefix: "gap", kind: "space", property: "gap" },
	{ prefix: "text", kind: "text", property: "font-size" },
	{ prefix: "font", kind: "fonts", property: "font-family" },
	{ prefix: "radius", kind: "radius", property: "border-radius" },
	{ prefix: "shadow", kind: "shadows", property: "box-shadow" },
	{ prefix: "max-width", kind: "widths", property: "max-inline-size" },
] as const;

/** A utility: its id (how elements store it), the name pages carry, and its one declaration. */
export type Utility = { id: string; name: string; property: string; ref: TokenRef };

/** Utility ids start with this, so they never look like a Class id. */
export const UTILITY_ID_PREFIX = "u:";

/** Every utility the tokens make, in a stable order. */
export function utilitiesOf(tokens: Tokens): Utility[] {
	const utilities: Utility[] = [];
	for (const utility of UTILITIES) {
		const add = (suffix: string, ref: TokenRef) =>
			utilities.push({
				id: `${UTILITY_ID_PREFIX}${utility.prefix}:${ref.token}${ref.step === undefined ? "" : `:${ref.step}`}`,
				name: `${utility.prefix}-${suffix}`,
				property: utility.property,
				ref,
			});
		switch (utility.kind) {
			case "colours":
				for (const colour of tokens.colours) {
					for (const step of COLOUR_STEPS) add(`${colour.name}-${step}`, { token: colour.id, step });
				}
				break;
			case "space":
			case "text":
				for (const step of tokens[utility.kind].steps) add(step.name, { token: step.id });
				break;
			default:
				for (const token of tokens[utility.kind]) add(token.name, { token: token.id });
		}
	}
	return utilities;
}
