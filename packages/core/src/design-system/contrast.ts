/**
 * The contrast Check of the Design system (spec story 123, WCAG 1.4.3 and 1.4.11): the colour pairs
 * the Design system puts together, each worked out in light and, with Dark mode on, in dark, and
 * flagged when its contrast is below what it needs: 4.5:1 for text, 3:1 for large text and for UI
 * parts (the focus indicator, solid colours against their background). Checks warn and never stop
 * a save or a publish.
 *
 * The pairs:
 * - **Base styles**: each element whose base style sets a text colour or a background colour token,
 *   as that text on that background (an element setting one takes the other from `body`). Headings
 *   `h1` to `h5` are large text (bold, from 19 px); every other element normal text.
 * - **The focus style**: the focus colour on the body's background, a UI part.
 * - **Each colour's ramp**, by the ramp's own roles (10 is the background end, 95 the text end, 60
 *   the base): step 95 on step 10 (text in a tinted area), step 10 on step 60 (a label on a solid
 *   fill) and step 60 on step 10 (a solid colour as a UI part on its tint).
 *
 * Pure: it reads a Design system and nothing else, so the screen, Code mode and the Checks list
 * (#95, through `designSystemChecks`) all get the same answer.
 */
import {
	type ColourMode,
	type CssText,
	colourSteps,
	type DesignSystem,
	normaliseHexWithAlpha,
	type TokenRef,
} from "@webcraft/renderer";

/** What a colour pair is used for, which decides the contrast it needs. */
export type ContrastUse = "text" | "largeText" | "ui";

/** Why a pair is checked. */
export type ContrastSource =
	| { kind: "baseStyle"; target: string }
	| { kind: "focus" }
	| { kind: "ramp"; role: "textOnTint" | "labelOnSolid" | "solidOnTint" };

/** One colour of a pair: a colour token's step, and its value in the mode checked. */
export type ContrastColour = { colour: string; name: string; step: string; value: string };

/** One colour pair, checked in one mode. */
export type ContrastResult = {
	/** Stable for the same pair, use and mode: `light:text:colour-primary/70:colour-neutral/10`. */
	id: string;
	mode: ColourMode;
	use: ContrastUse;
	sources: ContrastSource[];
	foreground: ContrastColour;
	background: ContrastColour;
	/** The contrast ratio, rounded down to two decimals (4.49 never reads as 4.5). */
	ratio: number;
	/** What the pair needs: 4.5 for text, 3 for large text and UI parts. */
	required: number;
	passes: boolean;
};

/** The contrast each use needs (WCAG 2.2 AA). */
export const REQUIRED_CONTRAST: Readonly<Record<ContrastUse, number>> = { text: 4.5, largeText: 3, ui: 3 };

/** Headings that are large text: bold, and from 19 px at their default sizes. */
const LARGE_TEXT_TARGETS = new Set(["h1", "h2", "h3", "h4", "h5"]);

const FOREGROUND_PROPERTIES = new Set(["color"]);
const BACKGROUND_PROPERTIES = new Set(["background-color", "background"]);

/** Every colour pair the Design system puts together, checked in each mode it shows. */
export function contrastChecks(designSystem: DesignSystem): ContrastResult[] {
	const modes: ColourMode[] = designSystem.darkMode ? ["light", "dark"] : ["light"];
	const results = new Map<string, ContrastResult>();
	for (const mode of modes) {
		const colourOf = colourReader(designSystem, mode);
		const add = (fg: TokenRef, bg: TokenRef, use: ContrastUse, source: ContrastSource) => {
			const background = colourOf(bg);
			const foreground = colourOf(fg);
			if (!background || !foreground) return;
			const id = `${mode}:${use}:${fg.token}/${fg.step}:${bg.token}/${bg.step}`;
			const required = REQUIRED_CONTRAST[use];
			const known = results.get(id);
			if (known) {
				known.sources.push(source);
				return;
			}
			const ratio = contrastRatio(composite(foreground.value, background.value, mode), opaque(background.value, mode));
			const shown = Math.floor(ratio * 100) / 100;
			results.set(id, {
				id,
				mode,
				use,
				sources: [source],
				foreground,
				background,
				ratio: shown,
				required,
				passes: ratio >= required,
			});
		};

		const body = colourDeclarations(designSystem.baseStyles.body ?? []);
		for (const [target, css] of Object.entries(designSystem.baseStyles)) {
			const own = colourDeclarations(css);
			if (!own.foreground && !own.background) continue;
			const fg = own.foreground ?? body.foreground;
			const bg = own.background ?? body.background;
			if (fg && bg) add(fg, bg, LARGE_TEXT_TARGETS.has(target) ? "largeText" : "text", { kind: "baseStyle", target });
		}
		const focus = designSystem.tokens.focus.colour;
		if (body.background) add({ token: focus.colour, step: focus.step }, body.background, "ui", { kind: "focus" });

		for (const colour of designSystem.tokens.colours) {
			const step = (name: string): TokenRef => ({ token: colour.id, step: name });
			add(step("95"), step("10"), "text", { kind: "ramp", role: "textOnTint" });
			add(step("10"), step("60"), "text", { kind: "ramp", role: "labelOnSolid" });
			add(step("60"), step("10"), "ui", { kind: "ramp", role: "solidOnTint" });
		}
	}
	return [...results.values()];
}

/** The pairs below what they need: what the Site's Checks list (#95) collects for the Design system. */
export type DesignSystemCheck = { check: "contrast" } & ContrastResult;

/** The Design system's open Checks: every colour pair with too little contrast. */
export function designSystemChecks(designSystem: DesignSystem): DesignSystemCheck[] {
	return contrastChecks(designSystem)
		.filter((result) => !result.passes)
		.map((result) => ({ check: "contrast", ...result }));
}

// ---------------------------------------------------------------------------------------------

function colourReader(designSystem: DesignSystem, mode: ColourMode) {
	const ramps = new Map(
		designSystem.tokens.colours.map((colour) => [colour.id, { colour, steps: colourSteps(colour, mode) }]),
	);
	return (ref: TokenRef): ContrastColour | undefined => {
		const found = ramps.get(ref.token);
		const value = ref.step === undefined ? undefined : found?.steps[ref.step];
		if (!found || ref.step === undefined || !value) return undefined;
		return { colour: found.colour.id, name: found.colour.name, step: ref.step, value };
	};
}

/**
 * The text and background colour tokens a piece of declarations sets: `color: var(--neutral-95)`
 * and `background-color: var(--neutral-10)` (or `background`), the last one winning as in CSS.
 * Values that aren't one colour token alone are left out.
 */
function colourDeclarations(css: CssText): { foreground?: TokenRef; background?: TokenRef } {
	const found: { foreground?: TokenRef; background?: TokenRef } = {};
	let text = "";
	for (let index = 0; index < css.length; index++) {
		const part = css[index] as CssText[number];
		if (typeof part === "string") {
			text += part;
			continue;
		}
		if ("token" in part && part.step !== undefined) {
			const declaration = text.slice(Math.max(text.lastIndexOf(";"), text.lastIndexOf("{")) + 1);
			const property = /^\s*([a-z-]+)\s*:\s*var\(\s*$/i.exec(declaration)?.[1]?.toLowerCase();
			const after = css[index + 1];
			const alone = typeof after !== "string" || /^\s*\)\s*(?:;|$)/.test(after);
			if (property && alone) {
				const ref = { token: part.token, step: part.step };
				if (FOREGROUND_PROPERTIES.has(property)) found.foreground = ref;
				if (BACKGROUND_PROPERTIES.has(property)) found.background = ref;
			}
		}
		text += "\u0000";
	}
	return found;
}

type Rgba = [number, number, number, number];

function rgbaOf(hex: string): Rgba {
	const value = normaliseHexWithAlpha(hex) ?? "#000000ff";
	return [1, 3, 5, 7].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255) as Rgba;
}

/** A colour with opacity over what is behind it: the page itself, white in light and black in dark. */
function opaque(hex: string, mode: ColourMode): Rgba {
	return over(rgbaOf(hex), mode === "light" ? [1, 1, 1, 1] : [0, 0, 0, 1]);
}

function composite(foreground: string, background: string, mode: ColourMode): Rgba {
	return over(rgbaOf(foreground), opaque(background, mode));
}

function over(top: Rgba, below: Rgba): Rgba {
	const alpha = top[3];
	return [0, 1, 2]
		.map((channel) => (top[channel] as number) * alpha + (below[channel] as number) * (1 - alpha))
		.concat(1) as Rgba;
}

/** The WCAG relative luminance of an opaque colour. */
function luminance([r, g, b]: Rgba): number {
	const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio of two opaque colours, from 1 to 21. */
function contrastRatio(a: Rgba, b: Rgba): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (light + 0.05) / (dark + 0.05);
}
