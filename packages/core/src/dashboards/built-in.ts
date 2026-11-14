/**
 * The built-in "Site analytics" Dashboard (SPEC 14.1, D10): every Site has it from the moment it is
 * made, so a new Site shows its numbers without anyone building a Dashboard first. Staff arrange and
 * rename it like any other; nobody deletes it (`builtIn`); it is listed first, and shown to Staff and
 * Owners until someone shows it to everyone. A custom migration
 * (`20261113230639_site-analytics-dashboard-for-every-site`) gave Sites made before theirs: keep its
 * Widgets in step with `SITE_ANALYTICS_WIDGETS`.
 */
import { dashboards } from "@webcraft/db/schema";

import type { WorkspaceScope } from "../tenancy/data-layer.ts";
import { DEFAULT_RANGE, type StoredWidget } from "./model.ts";

/** Its name when it is made (Staff may rename it). */
export const SITE_ANALYTICS_DASHBOARD = "Site analytics";

/**
 * Its Widgets on the 12-column grid: Totals across the width; Over time beside Sources; Top pages
 * beside Goals, which sits over Devices. Settings as a new Widget of each kind gets them.
 */
export const SITE_ANALYTICS_WIDGETS: readonly Omit<StoredWidget, "id">[] = [
	widget("totals", { x: 0, y: 0, w: 12, h: 2 }, { measures: ["pageviews", "visitors", "visits", "events"] }, 10),
	widget("trend", { x: 0, y: 2, w: 8, h: 4 }, { measures: ["pageviews", "visitors"] }, 10),
	widget("sources", { x: 8, y: 2, w: 4, h: 4 }, {}, 5),
	widget("top-pages", { x: 0, y: 6, w: 6, h: 4 }, {}, 5),
	widget("goals", { x: 6, y: 6, w: 6, h: 2 }, {}, 5),
	widget("devices", { x: 6, y: 8, w: 6, h: 2 }, {}, 5),
];

/** One of Site analytics' Widgets at a place, with the kind's own title and the Dashboard's range. */
function widget(
	kind: string,
	rect: { x: number; y: number; w: number; h: number },
	settings: StoredWidget["settings"],
	rows: number,
): Omit<StoredWidget, "id"> {
	return { kind: `site-analytics:${kind}`, title: null, ...rect, range: null, filters: {}, settings, rows };
}

/** The built-in Dashboard's Widgets, each with an id of its own. */
export function siteAnalyticsWidgets(): StoredWidget[] {
	return SITE_ANALYTICS_WIDGETS.map((widget) => ({
		id: crypto.randomUUID(),
		...widget,
		filters: { ...widget.filters },
		settings: structuredClone(widget.settings),
	}));
}

/** Adds the built-in Dashboard to a new Site of the scope's Workspace, inside its transaction. */
export async function addSiteAnalyticsDashboard(scope: WorkspaceScope, siteId: string): Promise<void> {
	const now = scope.now();
	await scope.insert(dashboards, {
		siteId,
		name: SITE_ANALYTICS_DASHBOARD,
		range: DEFAULT_RANGE,
		sharedWithEveryone: false,
		widgets: siteAnalyticsWidgets(),
		builtIn: true,
		createdAt: now,
		updatedAt: now,
	});
}
