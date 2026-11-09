import {
	and,
	count,
	countDistinct,
	eq,
	inArray,
	isNotNull,
	type ModuleContext,
	type SQL,
	z,
} from "@webcraft/module-sdk";

import { events } from "./tables.ts";

/**
 * What Site analytics counts, for a period or a range:
 * - `pageviews`: page views, with or without consent;
 * - `visitors`: distinct visitors, by their daily id (only those who accepted Analytics);
 * - `visits`: visits started (only those who accepted Analytics): a visit ends after 30 minutes
 *   without an event, and at midnight UTC, when visitors' ids change;
 * - `events`: link clicks, custom events and Form Submissions.
 */
export type Measures = { pageviews: number; visitors: number; visits: number; events: number };

export const ZERO: Measures = { pageviews: 0, visitors: 0, visits: 0, events: 0 };

/**
 * Dimensions of page views and visits, each a column of the raw events. Sources count arrivals
 * only (page views reached from outside the Site, and the visits they start), not moves within it.
 */
export const VISIT_DIMENSIONS = {
	page: events.path,
	source: events.source,
	country: events.country,
	device: events.device,
	browser: events.browser,
	os: events.os,
} as const;

/** What Goals will count (#103): link clicks by where they go, custom events by name, Form Submissions by Form. */
export const GOAL_DIMENSIONS = {
	outbound: { type: "link", name: "outbound", value: events.target },
	download: { type: "link", name: "download", value: events.target },
	tel: { type: "link", name: "tel", value: events.target },
	mailto: { type: "link", name: "mailto", value: events.target },
	event: { type: "event", name: null, value: events.name },
	form: { type: "form", name: null, value: events.target },
} as const;

export type VisitDimension = keyof typeof VISIT_DIMENSIONS;
export type GoalDimension = keyof typeof GOAL_DIMENSIONS;
export type Dimension = VisitDimension | GoalDimension;

export const DIMENSIONS = [
	...(Object.keys(VISIT_DIMENSIONS) as VisitDimension[]),
	...(Object.keys(GOAL_DIMENSIONS) as GoalDimension[]),
] as const;

export const dimensionSchema = z.enum(DIMENSIONS as unknown as [Dimension, ...Dimension[]]);

export function isGoalDimension(dimension: Dimension): dimension is GoalDimension {
	return dimension in GOAL_DIMENSIONS;
}

const GOAL_TYPES = ["link", "event", "form"];

/** Measures added up: `a` plus `b`. */
export function plus(a: Measures, b: Measures): Measures {
	return {
		pageviews: a.pageviews + b.pageviews,
		visitors: a.visitors + b.visitors,
		visits: a.visits + b.visits,
		events: a.events + b.events,
	};
}

/** The totals of the raw events matching `where`. */
export async function rawTotals(context: ModuleContext, where: SQL | undefined): Promise<Measures> {
	const one = async (extra: SQL | undefined, value: SQL<number>) => {
		const [row] = await context.data.aggregate(events, { where: and(where, extra), values: { n: value } });
		return Number(row?.n ?? 0);
	};
	return {
		pageviews: await one(eq(events.type, "pageview"), count()),
		visitors: await one(isNotNull(events.visitor), countDistinct(events.visitor)),
		visits: await one(eq(events.startsVisit, true), count()),
		events: await one(inArray(events.type, GOAL_TYPES), count()),
	};
}

/**
 * The raw events matching `where`, measured by a value of `dimension`: a map from the value (empty
 * for none, such as an unknown country) to its measures.
 */
export async function rawBreakdown(
	context: ModuleContext,
	where: SQL | undefined,
	dimension: Dimension,
): Promise<Map<string, Measures>> {
	const found = new Map<string, Measures>();
	const add = (value: string | null, measure: keyof Measures, n: number) => {
		const key = value ?? "";
		found.set(key, { ...(found.get(key) ?? ZERO), [measure]: (found.get(key)?.[measure] ?? 0) + n });
	};
	if (isGoalDimension(dimension)) {
		const goal = GOAL_DIMENSIONS[dimension];
		const of = and(where, eq(events.type, goal.type), goal.name === null ? undefined : eq(events.name, goal.name));
		const rows = await context.data.aggregate(events, {
			where: of,
			groupBy: { value: goal.value },
			values: { events: count(), visitors: countDistinct(events.visitor) },
		});
		for (const row of rows) {
			add(row.value, "events", Number(row.events));
			add(row.value, "visitors", Number(row.visitors));
		}
		return found;
	}
	const column = VISIT_DIMENSIONS[dimension];
	// Sources count arrivals only: a move within the Site has none.
	const counted = dimension === "source" ? and(where, isNotNull(events.source)) : where;
	const grouped = async (extra: SQL, measure: keyof Measures, value: SQL<number>) => {
		const rows = await context.data.aggregate(events, {
			where: and(counted, extra),
			groupBy: { value: column },
			values: { n: value },
		});
		for (const row of rows) add(row.value, measure, Number(row.n));
	};
	await grouped(eq(events.type, "pageview"), "pageviews", count());
	await grouped(isNotNull(events.visitor), "visitors", countDistinct(events.visitor));
	await grouped(eq(events.startsVisit, true), "visits", count());
	await grouped(inArray(events.type, GOAL_TYPES), "events", count());
	return found;
}
