import {
	and,
	asc,
	count,
	countDistinct,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	type ModuleContext,
	notInArray,
	or,
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
 * How many values of one dimension a period keeps on their own: an hour's rollup, and a day's (which
 * anything read from the raw events is held to as well). Visitors choose some dimensions' values
 * (pages, sources, links, custom events), so without a bound anyone could grow the rollups, kept
 * forever, one made-up value at a time.
 */
export const KEPT_VALUES = { hour: 100, day: 500 } as const;

/** The value every value past a period's `KEPT_VALUES` is counted under, together. */
export const OTHER = "(other)";

/** The raw events `dimension` counts among those matching `where`, and the column holding its values. */
function countedBy(where: SQL | undefined, dimension: Dimension) {
	if (isGoalDimension(dimension)) {
		const goal = GOAL_DIMENSIONS[dimension];
		return {
			column: goal.value,
			where: and(where, eq(events.type, goal.type), goal.name === null ? undefined : eq(events.name, goal.name)),
		};
	}
	// Sources count arrivals only: a move within the Site has none.
	return {
		column: VISIT_DIMENSIONS[dimension],
		where: dimension === "source" ? and(where, isNotNull(events.source)) : where,
	};
}

/**
 * The raw events matching `where`, measured by a value of `dimension`: a map from the value (empty
 * for none, such as an unknown country) to its measures. At most `keep` values are measured on their
 * own, those with the most events; the rest are measured together, under `OTHER`. Postgres picks
 * them, so however many values there are, only `keep` of them are ever read.
 */
export async function rawBreakdown(
	context: ModuleContext,
	where: SQL | undefined,
	dimension: Dimension,
	keep: number,
): Promise<Map<string, Measures>> {
	const counted = countedBy(where, dimension);
	// One more than kept says whether any are left over.
	const biggest = await context.data.aggregate(events, {
		where: counted.where,
		groupBy: { value: counted.column },
		values: { n: count() },
		orderBy: [desc(count()), asc(counted.column)],
		limit: keep + 1,
	});
	if (biggest.length <= keep) return measuredByValue(context, counted.where, dimension);
	const kept = biggest.slice(0, keep).map((row) => row.value);
	const named = kept.filter((value) => value !== null);
	const unnamedKept = named.length < kept.length;
	const among = unnamedKept
		? or(inArray(counted.column, named), isNull(counted.column))
		: inArray(counted.column, named);
	const beyond = unnamedKept
		? and(notInArray(counted.column, named), isNotNull(counted.column))
		: or(notInArray(counted.column, named), isNull(counted.column));
	const found = await measuredByValue(context, and(counted.where, among), dimension);
	const rest = await measuredTogether(context, and(counted.where, beyond), dimension);
	found.set(OTHER, plus(found.get(OTHER) ?? ZERO, rest));
	return found;
}

/** The raw events matching `where` (already those `dimension` counts), measured by each of its values. */
async function measuredByValue(
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
		const rows = await context.data.aggregate(events, {
			where,
			groupBy: { value: GOAL_DIMENSIONS[dimension].value },
			values: { events: count(), visitors: countDistinct(events.visitor) },
		});
		for (const row of rows) {
			add(row.value, "events", Number(row.events));
			add(row.value, "visitors", Number(row.visitors));
		}
		return found;
	}
	const column = VISIT_DIMENSIONS[dimension];
	const grouped = async (extra: SQL, measure: keyof Measures, value: SQL<number>) => {
		const rows = await context.data.aggregate(events, {
			where: and(where, extra),
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

/** The raw events matching `where` (already those `dimension` counts), measured as one value. */
async function measuredTogether(
	context: ModuleContext,
	where: SQL | undefined,
	dimension: Dimension,
): Promise<Measures> {
	if (!isGoalDimension(dimension)) return rawTotals(context, where);
	const [row] = await context.data.aggregate(events, {
		where,
		values: { events: count(), visitors: countDistinct(events.visitor) },
	});
	return { ...ZERO, events: Number(row?.events ?? 0), visitors: Number(row?.visitors ?? 0) };
}
