import type { ModuleContext } from "./context.ts";
import type { Label } from "./manifest.ts";

/**
 * Dashboard Widgets a Module adds (SDK 1.7). A Dashboard is WebCraft's: a grid of Widgets showing a
 * Site's analytics (or a Workspace's Sites added together), built by Staff. A Module declares Widget
 * kinds; Staff add them from the catalog, each with its own date range, filters and settings, and
 * WebCraft asks the kind's `query` for its data on each Site, in one of a few shapes the admin draws
 * with its own pieces (ADR 0024: no Module code runs in the admin page).
 *
 * Data are counts, never ratios: a rate is two counts (`{ count, of }`), so WebCraft can add up a
 * Workspace's Sites (visitors added per day, as Site analytics counts them) and the admin works out
 * the percentage.
 */

/** The shapes a Widget's data come in: a few numbers, lines over time, a table, or a Funnel's steps. */
export const WIDGET_SHAPES = ["number", "series", "table", "funnel"] as const;
export type WidgetShape = (typeof WIDGET_SHAPES)[number];

/** What Staff may narrow a Widget to. A kind lists those it takes. */
export const WIDGET_FILTERS = ["page", "source", "country", "device", "goal"] as const;
export type WidgetFilterName = (typeof WIDGET_FILTERS)[number];

/**
 * A Widget's filters: a page (exactly, or it and every page under it), a source (empty for direct),
 * a country (ISO 3166-1 alpha-2, empty for unknown), a device, or the visitors who reached a Goal (by
 * its name: Dashboard templates and Workspace Dashboards carry Goals across Sites by name).
 */
export type WidgetFilters = {
	page?: { path: string; match: "exact" | "prefix" };
	source?: string;
	country?: string;
	device?: "desktop" | "mobile" | "tablet";
	goal?: string;
};

/** One choice a setting offers: its value, and what Staff read (a Label, or a name people gave, such as a Goal's). */
export type WidgetOption = { value: string; label: Label | string };

/**
 * One of a Widget kind's settings: a choice from a list (several with `multiple`). The list is fixed,
 * or worked out for a Site (`options(context)`, such as its Goals), and the value is the option's
 * `value`: name things Staff made by their names, so templates and Workspace Dashboards carry them.
 */
export type WidgetSetting = {
	/** A name: letters and digits, such as `measures`. */
	key: string;
	label: Label;
	options: readonly WidgetOption[] | ((context: ModuleContext) => Promise<readonly WidgetOption[]>);
	multiple?: boolean;
	/** The value a new Widget starts with (fixed options only); none for a choice Staff must make. */
	default?: string | readonly string[];
};

/** A Widget's settings, by key: one value, or several for a `multiple` setting. */
export type WidgetSettings = Readonly<Record<string, string | readonly string[]>>;

/** What WebCraft asks a Widget kind's `query` for, on one Site. */
export type WidgetRequest = {
	/** Whole hours or days, in UTC: the Widget's own range, or its Dashboard's. */
	range: { from: Date; to: Date };
	/** How a series counts: by hour (ranges of two days or less) or by day. */
	interval: "hour" | "day";
	filters: WidgetFilters;
	settings: WidgetSettings;
	/** The most rows a table answers (biggest first). */
	limit: number;
};

/** A table's cell: text, a count, or a rate as two counts. */
export type WidgetCell = string | number | { count: number; of: number };

/**
 * How the admin shows a table's column: text as it is, a page's path, a source (empty: direct), a
 * country's code (by its name in the person's language; empty: unknown), a device, a count or a rate.
 */
export type WidgetColumnKind = "text" | "path" | "source" | "country" | "device" | "count" | "rate";

/** A Widget's data, in its kind's shape. `countedFrom`: the counts start there, older raw events being gone. */
export type WidgetData = (
	| { shape: "number"; values: readonly { key: string; label: Label; count: number; of?: number }[] }
	| {
			shape: "series";
			lines: readonly { key: string; label: Label }[];
			points: readonly { start: Date; values: Readonly<Record<string, number>> }[];
	  }
	| {
			shape: "table";
			columns: readonly { key: string; label: Label; kind: WidgetColumnKind }[];
			/** Each row's `key` names it across Sites (a page's path, a country's code). */
			rows: readonly { key: string; cells: Readonly<Record<string, WidgetCell>> }[];
	  }
	| { shape: "funnel"; steps: readonly { label: string; count: number }[] }
) & { countedFrom?: Date | null };

/**
 * A kind of Widget a Module adds to the catalog Staff build Dashboards from (Site-level Modules only).
 * Its `query` runs as the Module acting by itself on one Site where it runs, after WebCraft checked
 * that the person may see the Dashboard; a `ModuleError` it throws (no such Goal) is shown in the
 * Widget, anything else is a failure, written to the Module log.
 */
export type ModuleWidget = {
	/** Lower-case words joined by dashes, unique in the Module: `totals`, `top-pages`. */
	kind: string;
	label: Label;
	description: Label;
	shape: WidgetShape;
	/** The filters it takes (none unless listed). `goal` needs the definition's `widgetGoals`. */
	filters?: readonly WidgetFilterName[];
	settings?: readonly WidgetSetting[];
	query(request: WidgetRequest, context: ModuleContext): Promise<WidgetData>;
};

/** Declares a Widget kind. It only gives the definition back, typed: WebCraft checks it when it loads the Module. */
export function widget(definition: ModuleWidget): ModuleWidget {
	return definition;
}
