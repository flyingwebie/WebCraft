/**
 * A Filter (GLOSSARY.md › Filter, Filter control) as it is stored: the controls visitors use to
 * narrow, search and sort the items of one query Loop, in order, with their words in every language.
 * Core checks a version against its Loop and the Site's Post Types (`@webcraft/core` › filters);
 * the renderer writes it as a plain GET form (`render.ts`). This file imports nothing, so the admin's
 * Filter builder (#98) reads the same shapes and limits.
 *
 * What visitors choose lives in the page's address, under each control's URL key (the same in every
 * language): `?category=bread,pastries&vegan=1&price=2-10&sort=price-asc&q=rye&page=2`.
 */

/** Text with its value in other languages by BCP 47 tag, as a Form's labels keep it (ADR 0003). */
export type FilterText = { text: string; translations?: Record<string, string> };

/** Fixed text in a language: its own text there, else the text as written. */
export function filterTextIn(text: FilterText, language: string | undefined): string {
	return (language !== undefined && text.translations?.[language]) || text.text;
}

/** One version of a Filter: its Draft or what visitors use. */
export type FilterVersion = {
	/**
	 * When results change with JavaScript: as each control changes (`live`; text and ranges after a
	 * short pause), or when the Apply button is pressed (`submit`). Without JavaScript the form is sent
	 * and the page loads again either way.
	 */
	mode: FilterMode;
	/**
	 * How its controls are laid out (its layout preset): stacked beside the results (`sidebar`), one row
	 * of dropdown buttons above them (`topbar`), or behind a "Filters" button opening a drawer (`drawer`).
	 */
	layout: FilterLayout;
	/**
	 * What it becomes on phones (below the Design system's smallest breakpoint): a drawer (`drawer`), or
	 * the same layout as on wider screens (`same`). A drawer applies choices with its "Show" button only.
	 */
	phone: FilterPhoneLayout;
	/** What the Filter is called for screen readers (its form's name); WebCraft's word ("Filters") when null. */
	label: FilterText | null;
	/** The Apply button's words; WebCraft's ("Apply") when null. */
	applyLabel: FilterText | null;
	/** Its controls, in the order they show. */
	controls: FilterControl[];
};

export const FILTER_MODES = ["live", "submit"] as const;
export type FilterMode = (typeof FILTER_MODES)[number];

/** A Filter's layout presets, as the builder's Layout tab offers them. */
export const FILTER_LAYOUTS = ["sidebar", "topbar", "drawer"] as const;
export type FilterLayout = (typeof FILTER_LAYOUTS)[number];

/** What a Filter becomes on phones: a drawer, or its layout as on wider screens. */
export const FILTER_PHONE_LAYOUTS = ["drawer", "same"] as const;
export type FilterPhoneLayout = (typeof FILTER_PHONE_LAYOUTS)[number];

/** The eight kinds of Filter control, as the builder's "Add control" menu lists them. */
export const FILTER_CONTROL_TYPES = [
	"search",
	"checkboxes",
	"choice",
	"toggle",
	"range",
	"sort",
	"chips",
	"count",
] as const;
export type FilterControlType = (typeof FILTER_CONTROL_TYPES)[number];

/**
 * Where a control's options come from: a select Field's options or the Entries a Relationship
 * Field may point at (`field`, by its path in the Loop's Post Types), or the Loop's Post Types.
 */
export type FilterOptionSource = { kind: "field"; field: string } | { kind: "postType" };

/** What a control with options does with an option nothing matches: leaves it out, shows it disabled, or shows it. */
export const FILTER_EMPTY_OPTIONS = ["hide", "disable", "show"] as const;
export type FilterEmptyOptions = (typeof FILTER_EMPTY_OPTIONS)[number];

/** The order a control's options show in: as their source has them, by label, or most items first. */
export const FILTER_OPTION_ORDERS = ["source", "label", "count"] as const;
export type FilterOptionOrder = (typeof FILTER_OPTION_ORDERS)[number];

type ControlCommon = {
	/** Stable within the Filter (the builder selects controls by it); made when a control is added. */
	id: string;
};

/**
 * Settings of a control whose options visitors choose: their source, whether each shows how many items
 * it would list (`counts`, which ignore the control's own choice), and what an option nothing matches does.
 */
type OptionSettings = {
	key: string;
	label: FilterText;
	source: FilterOptionSource;
	counts: boolean;
	empty: FilterEmptyOptions;
	order: FilterOptionOrder;
};

/** A search box (`q`): Site search's index, limited to the Loop's items (ADR 0021). */
export type SearchControl = ControlCommon & {
	type: "search";
	/** WebCraft's word ("Search") when null. */
	label: FilterText | null;
	placeholder: FilterText | null;
};

/** Checkboxes: any number of options; items matching any of them (`any`, OR) or all of them (`all`, AND). */
export type CheckboxesControl = ControlCommon &
	OptionSettings & {
		type: "checkboxes";
		match: "any" | "all";
		/** How many options show before "Show more". */
		showFirst: number;
	};

/** Radio buttons or a select: one option, or all of them. */
export type ChoiceControl = ControlCommon &
	OptionSettings & {
		type: "choice";
		display: "radio" | "select";
		/** The option that chooses none; WebCraft's word ("All") when null. */
		allLabel: FilterText | null;
	};

/** A toggle for a true/false Field: on keeps the items whose value is true. */
export type ToggleControl = ControlCommon & {
	type: "toggle";
	key: string;
	label: FilterText;
	field: string;
};

/** A range for a number or date Field: from, to, or both (`price=2-10`, `when=2026-01-01..2026-03-31`). */
export type RangeControl = ControlCommon & {
	type: "range";
	key: string;
	label: FilterText;
	field: string;
	/** Read from the Field's type. */
	kind: "number" | "date";
	/** The two boxes' labels; WebCraft's words ("From", "To") when null. */
	minLabel: FilterText | null;
	maxLabel: FilterText | null;
};

/** One sort visitors may choose: its URL value, its words, and the order (`relevance`: best search match first). */
export type SortOption = { value: string; label: FilterText; by: string; direction: "asc" | "desc" };

/** A sort menu: the Loop's own order, or one of the sorts Staff allow. */
export type SortControl = ControlCommon & {
	type: "sort";
	key: string;
	/** WebCraft's word ("Sort") when null. */
	label: FilterText | null;
	/** The Loop's own order; WebCraft's word ("Default") when null. */
	defaultLabel: FilterText | null;
	options: SortOption[];
};

/** The active choices as chips, each removing itself, and Reset. */
export type ChipsControl = ControlCommon & {
	type: "chips";
	/** WebCraft's words when null: "Active filters", "Reset". */
	label: FilterText | null;
	resetLabel: FilterText | null;
};

/**
 * How many items the Loop lists with the choices made: `{count}` in the text is the number. `none`
 * is the no-results text. WebCraft's words when null.
 */
export type CountControl = ControlCommon & {
	type: "count";
	one: FilterText | null;
	other: FilterText | null;
	none: FilterText | null;
};

export type FilterControl =
	| SearchControl
	| CheckboxesControl
	| ChoiceControl
	| ToggleControl
	| RangeControl
	| SortControl
	| ChipsControl
	| CountControl;

/** A control whose choice lives in the page's address. */
export type StateControl =
	| SearchControl
	| CheckboxesControl
	| ChoiceControl
	| ToggleControl
	| RangeControl
	| SortControl;

export function isStateControl(control: FilterControl): control is StateControl {
	return control.type !== "chips" && control.type !== "count";
}

/** The key of the search box: Site search's (ADR 0021), the one free text a Filter takes. */
export const FILTER_SEARCH_KEY = "q";

/** The URL key a control's choice is kept under on a page, before any prefix. */
export function controlKey(control: StateControl): string {
	return control.type === "search" ? FILTER_SEARCH_KEY : control.key;
}

/** Keys no control can take: the search box's and pagination's. */
export const RESERVED_FILTER_KEYS: ReadonlySet<string> = new Set([FILTER_SEARCH_KEY, "page"]);

/** A control's URL key, and a Filter's name: lower-case words joined by dashes. */
export const FILTER_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A control's id. */
export const FILTER_CONTROL_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * What keeps Filters bounded, so a page never runs unbounded work for a visitor: how many controls a
 * Filter has, the options a control offers, the values one key takes, the sorts a sort menu offers and
 * the Filters one page shows.
 */
export const FILTER_LIMITS = {
	controls: 12,
	/** Options a control offers (more are left out, by its order). */
	options: 100,
	/** Values one key takes in an address (more are dropped). */
	values: 50,
	sorts: 10,
	/** Filters one page shows; past it, a Filter shows nothing and narrows nothing. */
	perPage: 4,
	/** Options shown before "Show more", at most. */
	showFirst: 50,
	keyLength: 32,
	labelLength: 200,
} as const;

/** A new Filter's version: Live, a sidebar that turns into a drawer on phones, no controls yet. */
export function newFilterVersion(): FilterVersion {
	return { mode: "live", layout: "sidebar", phone: "drawer", label: null, applyLabel: null, controls: [] };
}
