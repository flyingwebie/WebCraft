/**
 * Colour ramps: each Design system colour is one base colour, and WebCraft generates its shades
 * (steps 10, the lightest, to 95, the darkest; the base is step 60) and its transparencies (the base
 * at 10% to 90% opacity). Shades are worked out in OKLCH, so each step changes lightness evenly and
 * keeps the hue: lighter steps lose some colour on the way to white, darker ones less on the way to
 * black. Any shade can be overridden.
 *
 * With dark mode on, each colour also has dark values over the same steps: the ramp runs the other
 * way (step 10 is the darkest, the page's background end; 95 the lightest), from a dark base colour
 * that is the light one unless set. So `--neutral-10` behind `--neutral-95` reads well in both.
 */

/** The shade steps, lightest first in the light ramp. */
export const SHADE_STEPS = ["10", "20", "30", "40", "50", "60", "70", "80", "90", "95"] as const;

/** The step that is the base colour itself. */
export const BASE_STEP = "60";

/** The transparency steps: the base colour at 10% to 90% opacity. */
export const TRANSPARENCY_STEPS = ["a10", "a20", "a30", "a40", "a50", "a60", "a70", "a80", "a90"] as const;

/** Every step of a colour, shades then transparencies. */
export const COLOUR_STEPS: readonly string[] = [...SHADE_STEPS, ...TRANSPARENCY_STEPS];

export type ColourMode = "light" | "dark";

/** How far each step sits from the base towards the end of the ramp it is on (0 is the base, 1 the end). */
const TOWARDS_BACKGROUND: Readonly<Record<string, number>> = {
	"10": 1,
	"20": 0.86,
	"30": 0.68,
	"40": 0.48,
	"50": 0.25,
};
const TOWARDS_TEXT: Readonly<Record<string, number>> = { "70": 0.22, "80": 0.46, "90": 0.7, "95": 0.88 };

/** The lightness at each end of the ramp, by mode: the background end and the text end. */
const ENDS: Readonly<Record<ColourMode, { background: number; text: number }>> = {
	light: { background: 0.985, text: 0.2 },
	dark: { background: 0.18, text: 0.97 },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const HEX_WITH_ALPHA = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour as `#rrggbb` in lower case, from `#rgb` or `#rrggbb`; undefined when it isn't one. */
export function normaliseHex(value: string): string | undefined {
	if (!HEX.test(value)) return undefined;
	const digits = value.slice(1).toLowerCase();
	return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}

/** A colour with opacity as `#rrggbbaa` in lower case (opaque colours get `ff`); undefined when it isn't one. */
export function normaliseHexWithAlpha(value: string): string | undefined {
	if (!HEX_WITH_ALPHA.test(value)) return undefined;
	let digits = value.slice(1).toLowerCase();
	if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
	return `#${digits.length === 6 ? `${digits}ff` : digits}`;
}

/** The red, green and blue channels (0 to 1) of `#rrggbb`. */
export function rgbOf(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.slice(1, 7), 16);
	return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** `#rrggbb` from channels (0 to 1), rounded and kept in range. */
export function hexOf(rgb: readonly [number, number, number]): string {
	return `#${rgb.map((channel) => byteHex(channel)).join("")}`;
}

function byteHex(channel: number): string {
	return Math.round(Math.min(1, Math.max(0, channel)) * 255)
		.toString(16)
		.padStart(2, "0");
}

/** Every step of a colour's ramp in one mode: shades and transparencies, overrides applied. */
export function colourRamp(
	base: string,
	mode: ColourMode,
	overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const ramp: Record<string, string> = {};
	const [lightness, chroma, hue] = oklchOf(rgbOf(base));
	const ends = ENDS[mode];
	for (const step of SHADE_STEPS) {
		const override = overrides[step];
		if (step === BASE_STEP) {
			ramp[step] = base;
		} else if (override) {
			ramp[step] = override;
		} else {
			const towardsBackground = TOWARDS_BACKGROUND[step];
			const share = towardsBackground ?? TOWARDS_TEXT[step] ?? 0;
			const end = towardsBackground === undefined ? ends.text : ends.background;
			// Steps towards white lose most of their colour; towards black, less of it.
			const losesColour = end > lightness ? 0.85 : 0.35;
			ramp[step] = shade(lightness + (end - lightness) * share, chroma * (1 - losesColour * share), hue);
		}
	}
	for (const step of TRANSPARENCY_STEPS) ramp[step] = `${base}${byteHex(Number(step.slice(1)) / 100)}`;
	return ramp;
}

/** The colour at OKLCH lightness, chroma and hue, with its chroma lowered until sRGB can show it. */
function shade(lightness: number, chroma: number, hue: number): string {
	let low = 0;
	let high = chroma;
	if (inGamut(rgbOfOklch(lightness, high, hue))) return hexOf(rgbOfOklch(lightness, high, hue));
	for (let round = 0; round < 24; round++) {
		const middle = (low + high) / 2;
		if (inGamut(rgbOfOklch(lightness, middle, hue))) low = middle;
		else high = middle;
	}
	return hexOf(rgbOfOklch(lightness, low, hue));
}

function inGamut(rgb: readonly number[]): boolean {
	return rgb.every((channel) => channel >= -0.0005 && channel <= 1.0005);
}

// OKLab and OKLCH, from sRGB and back (Björn Ottosson's matrices).

function linear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function gamma(channel: number): number {
	return channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.sign(channel) * Math.abs(channel) ** (1 / 2.4) - 0.055;
}

function oklchOf(rgb: readonly [number, number, number]): [number, number, number] {
	const [r, g, b] = rgb.map(linear) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return [lightness, Math.hypot(a, bb), Math.atan2(bb, a)];
}

function rgbOfOklch(lightness: number, chroma: number, hue: number): [number, number, number] {
	const a = chroma * Math.cos(hue);
	const b = chroma * Math.sin(hue);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}
