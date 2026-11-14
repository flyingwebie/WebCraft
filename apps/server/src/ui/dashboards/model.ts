import type { ApiClient } from "@webcraft/api";

import { getApi } from "../api.ts";

type Answer<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;

/** A Dashboard and its Widgets, as `dashboards.get` answers it. */
export type DashboardView = Answer<ApiClient["dashboards"]["get"]>["dashboard"];
export type WidgetView = DashboardView["widgets"][number];
export type DashboardSummary = Answer<ApiClient["dashboards"]["list"]>["dashboards"][number];
export type CatalogKind = Answer<ApiClient["dashboards"]["catalog"]>["kinds"][number];
export type WidgetAnswer = Answer<ApiClient["dashboards"]["widgets"]["data"]>["widget"];
export type WidgetData = NonNullable<WidgetAnswer["data"]>;
export type TemplateView = Answer<ApiClient["dashboardTemplates"]["list"]>["templates"][number];
export type DashboardRange = DashboardView["range"];
export type WidgetFilters = WidgetView["filters"];

/** Where Dashboards are: a Site, or a Workspace (adding up its Sites). */
export type DashboardPlace = { siteId: string } | { workspaceId: string };

/** The moving ranges, in the order the range picker offers them. */
export const RANGE_PRESETS = [
	"today",
	"yesterday",
	"last7Days",
	"last30Days",
	"last90Days",
	"thisMonth",
	"lastMonth",
	"last12Months",
] as const;

/** The grid's columns, as the server keeps them. */
export const GRID_COLUMNS = 12;
/** A grid row's height and the gap between cells, in pixels (`auto-rows-[5rem]`, `gap-4`). */
export const ROW_HEIGHT = 80;
export const GRID_GAP = 16;

/** A Widget's place and size on the grid, in cells. */
export type Rect = { x: number; y: number; w: number; h: number };

/** The smallest and largest a Widget may be, in cells, as the server keeps them. */
export const WIDGET_MIN = 2;
export const WIDGET_MAX = 12;

/** A rect kept on the grid: 2 to 12 cells each way, inside the 12 columns. */
export function clampRect(rect: Rect): Rect {
	const w = Math.min(Math.max(Math.round(rect.w), WIDGET_MIN), WIDGET_MAX);
	const h = Math.min(Math.max(Math.round(rect.h), WIDGET_MIN), WIDGET_MAX);
	return { x: Math.min(Math.max(Math.round(rect.x), 0), GRID_COLUMNS - w), y: Math.max(Math.round(rect.y), 0), w, h };
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The layout once one Widget takes a place: the Widgets it would cover move down below it, nothing
 * else moves. The server places Widgets by the same rule; this shows it while a Widget is dragged.
 */
export function placed<Widget extends Rect & { id: string }>(
	widgets: readonly Widget[],
	id: string,
	rect: Rect,
): Widget[] {
	const moving = widgets.find((widget) => widget.id === id);
	const settled: Rect[] = [clampRect(rect)];
	const rest = widgets
		.filter((widget) => widget.id !== id)
		.map((widget) => ({ ...widget }))
		.sort((a, b) => a.y - b.y || a.x - b.x);
	for (const widget of rest) {
		let blocker = settled.find((other) => overlaps(other, widget));
		while (blocker) {
			widget.y = blocker.y + blocker.h;
			blocker = settled.find((other) => overlaps(other, widget));
		}
		settled.push(widget);
	}
	return widgets.map((widget) =>
		widget.id === id
			? { ...(moving ?? widget), ...clampRect(rect) }
			: (rest.find((each) => each.id === widget.id) ?? widget),
	);
}

/** The first free place for a Widget of this size: the topmost row, then the leftmost column. */
export function freePlace(widgets: readonly Rect[], size: { w: number; h: number }): Rect {
	const { w, h } = clampRect({ x: 0, y: 0, ...size });
	const bottom = widgets.reduce((most, widget) => Math.max(most, widget.y + widget.h), 0);
	for (let y = 0; y <= bottom; y++) {
		for (let x = 0; x + w <= GRID_COLUMNS; x++) {
			const rect = { x, y, w, h };
			if (!widgets.some((widget) => overlaps(widget, rect))) return rect;
		}
	}
	return { x: 0, y: bottom, w, h };
}

/** The days a counted range covers, both counted (an hourly range of one day is 1). */
export function daysIn(range: { from: Date | string; to: Date | string }): number {
	return Math.max(1, Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000));
}

/**
 * How a count changed on the period before, as a signed share (0.124 for +12.4 %), or null when
 * there was nothing before to compare with.
 */
export function changeOf(now: number, before: number): number | null {
	return before > 0 ? (now - before) / before : null;
}

/** A range from the address (`?range=last7Days` or `?range=2026-03-01_2026-03-31`), or null. */
export function rangeFromSearch(value: string | undefined): DashboardRange | null {
	if (!value) return null;
	if ((RANGE_PRESETS as readonly string[]).includes(value)) {
		return { preset: value as (typeof RANGE_PRESETS)[number] };
	}
	const match = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(value);
	return match ? { preset: "custom", from: match[1] as string, to: match[2] as string } : null;
}

/** A range as the address keeps it. */
export function rangeToSearch(range: DashboardRange): string {
	return range.preset === "custom" ? `${range.from}_${range.to}` : range.preset;
}

export function sameRange(a: DashboardRange, b: DashboardRange): boolean {
	return rangeToSearch(a) === rangeToSearch(b);
}

/** The days a range covers, both counted, in the admin's fixed form: `2026-03-01 – 2026-03-30`. */
export function daysText(range: { from: Date | string; to: Date | string }): string {
	const day = (value: Date) => value.toISOString().slice(0, 10);
	const last = new Date(new Date(range.to).getTime() - 1);
	const first = day(new Date(range.from));
	return first === day(last) ? first : `${first} – ${day(last)}`;
}

/** A share as a percentage with one decimal, or null when there is nothing to share. */
export function percent(count: number, of: number): string | null {
	return of > 0 ? `${((count / of) * 100).toFixed(1)}%` : null;
}

/** Downloads a CSV file the API answered, as the browser saves any file. */
export function downloadCsv({ filename, csv }: { filename: string; csv: string }): void {
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** The Management API's Dashboard procedures. */
export async function dashboardsApi(): Promise<ApiClient["dashboards"]> {
	return (await getApi()).dashboards;
}
