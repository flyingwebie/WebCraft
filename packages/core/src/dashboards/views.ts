import type { WidgetColumnKind, WidgetFilterName } from "@webcraft/module-sdk";

import type { DashboardRange, StoredWidget } from "./model.ts";

/** Where a Dashboard is: on a Site, or a Workspace Dashboard adding up its Sites. */
export type DashboardPlace = { siteId: string } | { workspaceId: string };

/** The shapes Widgets are drawn in: the Modules' four, and WebCraft's own note. */
export type WidgetViewShape = "note" | "number" | "series" | "table" | "funnel";

/** A setting a Widget kind offers, in the person's language. `options` null: worked out per place (ask `options`). */
export type CatalogSetting = {
	key: string;
	label: string;
	multiple: boolean;
	options: { value: string; label: string }[] | null;
	default: string | string[] | null;
};

/** A Widget kind Staff can add, in the person's language. */
export type CatalogKind = {
	kind: string;
	/** The Module adding it (its name), or null for WebCraft's own note. */
	module: string | null;
	label: string;
	description: string;
	shape: WidgetViewShape;
	filters: WidgetFilterName[];
	settings: CatalogSetting[];
	/** Whether its Module runs here (on the Site; on one of the Workspace's Sites at least). */
	available: boolean;
	/** The size a new one takes, in grid cells. */
	size: { w: number; h: number };
};

/** A Dashboard in a list. */
export type DashboardSummary = {
	id: string;
	name: string;
	widgets: number;
	sharedWithEveryone: boolean;
	updatedAt: Date;
};

/** A Widget on a Dashboard, with what its kind is. */
export type WidgetView = StoredWidget & { label: string; shape: WidgetViewShape };

/** A Dashboard with its Widgets (their data come one by one, from `widgetData`). */
export type DashboardView = {
	id: string;
	name: string;
	range: DashboardRange;
	sharedWithEveryone: boolean;
	widgets: WidgetView[];
	updatedAt: Date;
	/** Whether the person may change it (`dashboard.manage`). */
	canManage: boolean;
};

/** A Widget's data, its labels in the person's language: counts only, rates as two counts. */
export type WidgetDataView =
	| { shape: "note"; text: string }
	| { shape: "number"; values: { key: string; label: string; count: number; of: number | null }[] }
	| {
			shape: "series";
			lines: { key: string; label: string }[];
			points: { start: Date; values: Record<string, number> }[];
	  }
	| {
			shape: "table";
			columns: { key: string; label: string; kind: WidgetColumnKind }[];
			rows: { key: string; cells: Record<string, string | number | { count: number; of: number }> }[];
	  }
	| { shape: "funnel"; steps: { label: string; count: number }[] };

/** What a Widget shows now, for the range it counts. */
export type WidgetAnswerView = {
	widgetId: string;
	title: string;
	range: { from: Date; to: Date; interval: "hour" | "day" };
	data: WidgetDataView | null;
	/** Why it shows nothing: its Module's refusal (`GOAL_NOT_FOUND`), `MODULE_NOT_RUNNING`, `WIDGET_FAILED`… */
	problem: { code: string; message: string } | null;
	/** The counts start here: older raw events are gone. */
	countedFrom: Date | null;
	/** A Workspace Dashboard's: how many of the Sites the person sees it counted on. */
	sites: { counted: number; of: number } | null;
};
