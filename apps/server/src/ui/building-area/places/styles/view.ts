/**
 * The Styles place's pure parts (`places-assets/05` to `07`): its four tabs and their addresses, each
 * tab's view in the shell's address (`wc-view`: the Classes' search, kind filter and selected Class;
 * the Design token group shown and how), which Classes the list shows, the Design tokens each quick
 * action offers, and the ruler under the Breakpoints.
 */

/** A colour's, font's, radius's, shadow's or content width's name, as the Design system checks it (`TOKEN_NAME`). */
export const TOKEN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A scale step's or breakpoint's name, which may start with a digit (`2xl`; `STEP_NAME`). */
export const STEP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The Styles place's tabs, each an address of its own (`styles/<tab>`), in the frames' order. */
export const STYLES_TABS = ["classes", "tokens", "site-css", "breakpoints"] as const;
export type StylesTab = (typeof STYLES_TABS)[number];

/** The tab a Styles address opens (`styles/tokens` is Design tokens); Classes for anything else. */
export function tabOf(place: string): StylesTab {
	const tab = place.slice("styles/".length);
	return STYLES_TABS.find((each) => each === tab) ?? "classes";
}

/** The kinds the Classes list filters by: every Class, made by hand, generated, on an element, on none. */
export const CLASS_KINDS = ["all", "class", "generated", "used", "unused"] as const;
export type ClassKind = (typeof CLASS_KINDS)[number];

/** The Design token groups, in the frame's order (Breakpoints have a tab of their own). */
export const TOKEN_GROUPS = ["colours", "space", "text", "fonts", "radius", "shadows", "widths"] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number];

/** A tab's view: what the address keeps of it. Each part is left out when it is the default. */
export type StylesView = {
	/** The Classes' search. */
	query: string;
	kind: ClassKind;
	/** The selected Class, by id. */
	selected: string | null;
	group: TokenGroup;
	/** The token group shown as CSS rather than in its editor. */
	css: boolean;
};

export const DEFAULT_VIEW: StylesView = { query: "", kind: "all", selected: null, group: "colours", css: false };

/** A view as the address keeps it (`q=hero&kind=unused&class=<id>`), null when it is the default. */
export function printView(view: StylesView): string | null {
	const params = new URLSearchParams();
	if (view.query) params.set("q", view.query);
	if (view.kind !== "all") params.set("kind", view.kind);
	if (view.selected) params.set("class", view.selected);
	if (view.group !== "colours") params.set("group", view.group);
	if (view.css) params.set("as", "css");
	const printed = params.toString();
	return printed || null;
}

/** A view from the address: anything it doesn't know is the default. */
export function readView(printed: string | null): StylesView {
	const params = new URLSearchParams(printed ?? "");
	const kind = params.get("kind");
	const group = params.get("group");
	const selected = params.get("class");
	return {
		query: (params.get("q") ?? "").slice(0, 100),
		kind: CLASS_KINDS.find((each) => each === kind) ?? "all",
		selected: selected && /^[A-Za-z0-9_-]{1,100}$/.test(selected) ? selected : null,
		group: TOKEN_GROUPS.find((each) => each === group) ?? "colours",
		css: params.get("as") === "css",
	};
}

/** A Class as the list reads it. */
export type ListedClass = { id: string; name: string; generated: boolean };

/**
 * The Classes the list shows, by name: those whose name has the search in it (a leading `.` is the
 * Class's dot), of the kind chosen. `elements` counts the elements each Class is on: "In use" lists
 * those on one or more, "Unused" those on none. The selected Class stays listed whatever the filters.
 */
export function shownClasses<Each extends ListedClass>(
	classes: readonly Each[],
	view: Pick<StylesView, "query" | "kind" | "selected">,
	elements: (classId: string) => number,
): Each[] {
	const query = view.query.trim().toLowerCase().replace(/^\./, "");
	const kept = classes.filter((each) => {
		if (each.id === view.selected) return true;
		if (query && !each.name.toLowerCase().includes(query)) return false;
		switch (view.kind) {
			case "class":
				return !each.generated;
			case "generated":
				return each.generated;
			case "used":
				return elements(each.id) > 0;
			case "unused":
				return elements(each.id) === 0;
			default:
				return true;
		}
	});
	return kept.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** One Design token a quick action offers: what the menu shows, and the value it writes. */
export type TokenChoice = { label: string; value: string; detail: string };

/** The Design tokens as the quick actions read them (a part of the Draft's tokens). */
export type QuickTokens = {
	colours: readonly { name: string; light: { base: string } }[];
	space: { steps: readonly { id?: string; name: string; exponent: number }[] };
	text: { steps: readonly { id?: string; name: string; exponent: number }[] };
	fonts: readonly { name: string; family: readonly string[] }[];
	radius: readonly { name: string; value: { value: number; unit: string } }[];
	shadows: readonly { name: string }[];
	widths: readonly { name: string; value: { value: number; unit: string } }[];
};

/** The kinds of Design token a quick action can write. */
export type TokenKind = "space" | "text" | "colours" | "fonts" | "radius" | "shadows" | "widths";

/** A scale step's sizes as the preview gives them, by the step's id. */
export type StepSizes = Record<string, { min: number; max: number }>;

const SHADES = ["10", "20", "30", "40", "50", "60", "70", "80", "90", "95"];

function sizeWords(size: { min: number; max: number } | undefined): string {
	if (!size) return "";
	const round = (value: number) => `${Math.round(value * 100) / 100}`;
	return size.min === size.max ? `${round(size.min)}px` : `${round(size.min)}–${round(size.max)}px`;
}

/** The tokens of a kind as `var(--…)` values, in the Design system's order (each colour's shades). */
export function tokenChoices(kind: TokenKind, tokens: QuickTokens, sizes: StepSizes = {}): TokenChoice[] {
	const dimension = (value: { value: number; unit: string }) => `${value.value}${value.unit}`;
	switch (kind) {
		case "space":
		case "text": {
			const prefix = kind === "space" ? "space" : "text";
			return [...tokens[kind].steps]
				.sort((a, b) => b.exponent - a.exponent)
				.map((step) => ({
					label: `${prefix}-${step.name}`,
					value: `var(--${prefix}-${step.name})`,
					detail: sizeWords(step.id ? sizes[step.id] : undefined),
				}));
		}
		case "colours":
			return tokens.colours.flatMap((colour) =>
				SHADES.map((shade) => ({
					label: `${colour.name}-${shade}`,
					value: `var(--${colour.name}-${shade})`,
					detail: shade === "60" ? colour.light.base : "",
				})),
			);
		case "fonts":
			return tokens.fonts.map((font) => ({
				label: `font-${font.name}`,
				value: `var(--font-${font.name})`,
				detail: font.family[0] ?? "",
			}));
		case "radius":
			return tokens.radius.map((each) => ({
				label: `radius-${each.name}`,
				value: `var(--radius-${each.name})`,
				detail: dimension(each.value),
			}));
		case "shadows":
			return tokens.shadows.map((each) => ({
				label: `shadow-${each.name}`,
				value: `var(--shadow-${each.name})`,
				detail: "",
			}));
		case "widths":
			return tokens.widths.map((each) => ({
				label: `width-${each.name}`,
				value: `var(--width-${each.name})`,
				detail: dimension(each.value),
			}));
	}
}

/**
 * The token a quick action writes on its first click: the first favourite of its kind, else the
 * scale's middle step (exponent 0), else a colour's base shade, else the first.
 */
export function defaultChoice(kind: TokenKind, tokens: QuickTokens, favourites: readonly string[]): TokenChoice | null {
	const choices = tokenChoices(kind, tokens);
	const favourite = choices.find((choice) => favourites.includes(choice.value));
	if (favourite) return favourite;
	if (kind === "space" || kind === "text") {
		const middle = tokens[kind].steps.find((step) => step.exponent === 0);
		const prefix = kind === "space" ? "space" : "text";
		if (middle) return choices.find((choice) => choice.value === `var(--${prefix}-${middle.name})`) ?? null;
	}
	if (kind === "colours") return choices.find((choice) => choice.label.endsWith("-60")) ?? null;
	return choices[0] ?? null;
}

/** The ruler under the Breakpoints (`places-assets/07`): 320 to 1920 px. */
export const RULER_MIN = 320;
export const RULER_MAX = 1920;
/** The widths the ruler marks, as the frame draws them. */
export const RULER_TICKS = [320, 576, 768, 992, 1200, 1440, 1920] as const;

/** Where a width sits along the ruler, from 0 (320 px) to 1 (1920 px); wider and narrower stay at the ends. */
export function rulerAt(width: number): number {
	return Math.min(1, Math.max(0, (width - RULER_MIN) / (RULER_MAX - RULER_MIN)));
}

/** How many of the Classes have styles from a breakpoint up ("on N rules"). */
export function rulesFrom(classes: readonly { breakpoints: Record<string, string> }[], breakpointId: string): number {
	return classes.filter((each) => (each.breakpoints[breakpointId] ?? "").trim() !== "").length;
}

/**
 * The contrast a colour reaches where the Site uses it: the Check's pairs from its base styles and its
 * focus style that have the colour on one side (the ramps' own sample pairs aside), the worst of them
 * in light and dark: AAA (7:1), AA (every pair passes), or low; null when nothing on the Site pairs it.
 */
export function contrastOf(
	colourId: string,
	results: readonly {
		foreground: { colour: string };
		background: { colour: string };
		ratio: number;
		passes: boolean;
		sources: readonly { kind: string }[];
	}[],
): "AAA" | "AA" | "low" | null {
	const pairs = results.filter(
		(each) =>
			(each.foreground.colour === colourId || each.background.colour === colourId) &&
			each.sources.some((source) => source.kind !== "ramp"),
	);
	if (pairs.length === 0) return null;
	if (pairs.some((each) => !each.passes)) return "low";
	return pairs.every((each) => each.ratio >= 7) ? "AAA" : "AA";
}

/** The custom properties a token group gives the stylesheet, read from the Draft's compiled stylesheet. */
export function groupCss(stylesheet: string, prefixes: readonly string[]): string {
	const seen = new Map<string, string>();
	// Light values only (the first `:root` block); dark values are shown beside them in the editor.
	const root = /:root\{([^}]*)\}/.exec(stylesheet)?.[1] ?? "";
	for (const declaration of root.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon === -1) continue;
		const name = declaration.slice(0, colon).trim();
		if (!prefixes.some((prefix) => name.startsWith(`--${prefix}-`))) continue;
		if (!seen.has(name)) seen.set(name, declaration.slice(colon + 1).trim());
	}
	if (seen.size === 0) return ":root {\n}";
	return `:root {\n${[...seen].map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
}
