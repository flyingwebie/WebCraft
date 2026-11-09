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
