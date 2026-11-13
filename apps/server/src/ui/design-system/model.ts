/**
 * The Design system screen's model: the Draft as the screen holds it while Staff edit, the changes
 * it saves (sections of the Draft, and Classes one by one), and which token values each CSS property
 * is offered first.
 */
import type { ApiClient } from "@webcraft/api";

export type DesignSystemView = Awaited<ReturnType<ApiClient["designSystem"]["get"]>>["designSystem"];
export type Draft = DesignSystemView["draft"];
export type Tokens = Draft["tokens"];
export type ColourToken = Tokens["colours"][number];
export type EditableClass = Draft["classes"][number];
export type Preview = Awaited<ReturnType<ApiClient["designSystem"]["preview"]>>["preview"];
export type ContrastResult = Preview["contrast"][number];
export type ImportAnswer = Awaited<ReturnType<ApiClient["designSystem"]["importFile"]>>;
export type ImportPreview = Extract<ImportAnswer, { preview: unknown }>["preview"];

export type ColourMode = "light" | "dark";

/** The shade steps, lightest first in the light ramp; 60 is the base colour. */
export const SHADE_STEPS = ["10", "20", "30", "40", "50", "60", "70", "80", "90", "95"] as const;
export const BASE_STEP = "60";

/** A Class's change, by what changes: CSS left out stays as it is. */
export type ClassPatch = Partial<Pick<EditableClass, "name" | "styles" | "breakpoints" | "css">>;

/** What the screen saves next: whole sections of the Draft, and changes to Classes by id. */
export type Change = {
	sections?: Partial<Pick<Draft, "tokens" | "baseStyles" | "customCss" | "darkMode">>;
	classes?: Record<string, ClassPatch>;
};

/** One change made of an older and a newer one: the newer wins where both change something. */
export function mergeChanges(older: Change, newer: Change): Change {
	const classes: Record<string, ClassPatch> = { ...older.classes };
	for (const [id, patch] of Object.entries(newer.classes ?? {})) classes[id] = { ...classes[id], ...patch };
	return { sections: { ...older.sections, ...newer.sections }, classes };
}

/** A new token's id, made in the browser so the next save keeps it (ids are letters, digits, `-` and `_`). */
export function newTokenId(): string {
	return crypto.randomUUID();
}

/** A name for a new token of a list: `<prefix>-<n>`, the first free one. */
export function freeName(prefix: string, taken: readonly { name: string }[]): string {
	for (let n = taken.length + 1; ; n++) {
		const name = `${prefix}-${n}`;
		if (!taken.some((each) => each.name === name)) return name;
	}
}

/**
 * The token values a property is offered first, as `var(--…)`: colours for colour properties,
 * spacing steps for spacing, type steps for font sizes, and so on; any value can still be typed.
 */
export function tokenValuesFor(property: string, tokens: Tokens): string[] {
	const name = property.trim().toLowerCase();
	const colours = () => tokens.colours.flatMap((colour) => SHADE_STEPS.map((step) => `var(--${colour.name}-${step})`));
	const space = () => tokens.space.steps.map((step) => `var(--space-${step.name})`);
	if (/(^|-)colou?r$|^background$|^fill$|^stroke$|^outline-color$|^border(-[a-z]+)*-color$/.test(name))
		return colours();
	if (/^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left)(-|$)/.test(name)) return space();
	if (name === "font-size") return tokens.text.steps.map((step) => `var(--text-${step.name})`);
	if (name === "font-family") return tokens.fonts.map((font) => `var(--font-${font.name})`);
	if (/radius$/.test(name)) return tokens.radius.map((each) => `var(--radius-${each.name})`);
	if (name === "box-shadow") return tokens.shadows.map((each) => `var(--shadow-${each.name})`);
	if (/(^|-)(inline|block)-size$|^(max-|min-)?(width|height)$/.test(name))
		return [...tokens.widths.map((each) => `var(--width-${each.name})`), ...space()];
	return [];
}

/** A problem as the server words one: where, and what. */
export type Problem = { at: string; message: string; line?: number; column?: number };

/** The problems a refusal carries (`data.problems`), if any. */
export function problemsOf(error: unknown): Problem[] {
	const problems = (error as { data?: { problems?: unknown } }).data?.problems;
	return Array.isArray(problems) ? (problems as Problem[]) : [];
}

/** Escapes text for HTML the screen writes into a preview frame. */
export function html(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
