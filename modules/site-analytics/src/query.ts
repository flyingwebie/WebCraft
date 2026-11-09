/**
 * The analytics query interface (ADR 0019): the one way anything reads a Site's analytics, so that
 * Dashboards and Widgets (#103), Reports and Share links (#104) all count the same way, and a
 * column store could go behind it later without changing them.
 *
 * Ranges are whole hours, in UTC: a range from and to midnight counts by day, any other by hour.
 * Periods whose rollups are built come from the rollups (kept forever); the rest (the current hour
 * and day, and anything the hourly job hasn't reached yet) from the raw events, counted as they are.
 * A range's visitors are its periods' visitors added up: a visitor's id changes every day, so a
 * visitor seen on two days counts on each.
 */
import {
	and,
	count,
	countDistinct,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	type ModuleContext,
	min,
	type SQL,
	sum,
} from "@webcraft/module-sdk";

import { type Filters, filtersWhere, isFiltered } from "./filters.ts";
import { type Goal, goalWhere } from "./goals.ts";
import { type Dimension, isGoalDimension, type Measures, plus, rawBreakdown, rawTotals, ZERO } from "./measures.ts";
import { type Built, builtUntil, DAY_MS, HOUR_MS, lengthOf, type Period, startOf, within } from "./rollups.ts";
import { events, rollups } from "./tables.ts";

export type Range = { from: Date; to: Date };

/** A range as whole periods: by day when it starts and ends at midnight (UTC), else by hour. */
function granularity(range: Range): { period: Period; from: Date; to: Date } {
	const aligned = range.from.getTime() % DAY_MS === 0 && range.to.getTime() % DAY_MS === 0;
	const period: Period = aligned ? "day" : "hour";
	return { period, ...wholePeriods(period, range) };
}

/** The range widened to whole periods. */
function wholePeriods(period: Period, range: Range): Range {
	const from = startOf(period, range.from);
	const end = startOf(period, range.to);
	const to = end.getTime() < range.to.getTime() ? new Date(end.getTime() + lengthOf(period)) : end;
	return { from, to };
}

/**
 * The part of a range its rollups cover, and the rest, from the raw events. A filtered count reads
 * the raw events only (`built` null): rollups hold each dimension on its own.
 */
function split(period: Period, range: Range, built: Built | null) {
	const until = built ? (period === "hour" ? built.hours : built.days) : range.from;
	const middle = new Date(Math.min(Math.max(until.getTime(), range.from.getTime()), range.to.getTime()));
	return { rolled: { from: range.from, to: middle }, raw: { from: middle, to: range.to } };
}

const isEmpty = (range: Range) => range.from.getTime() >= range.to.getTime();

/** The rollup rows of a period kind and dimension whose start is in the range. */
function rolledWhere(period: Period, dimension: string, range: Range): SQL | undefined {
	return and(
		eq(rollups.period, period),
		eq(rollups.dimension, dimension),
		gte(rollups.start, range.from),
		lt(rollups.start, range.to),
	);
}

const SUMS = {
	pageviews: sum(rollups.pageviews),
	visitors: sum(rollups.visitors),
	visits: sum(rollups.visits),
	events: sum(rollups.events),
};

function measuresOf(row: { pageviews: unknown; visitors: unknown; visits: unknown; events: unknown }): Measures {
	return {
		pageviews: Number(row.pageviews ?? 0),
		visitors: Number(row.visitors ?? 0),
		visits: Number(row.visits ?? 0),
		events: Number(row.events ?? 0),
	};
}

/** How far the rollups answer: not at all for a filtered count, which reads the raw events only. */
async function rolledUntil(context: ModuleContext, filters: Filters | undefined): Promise<Built | null> {
	return isFiltered(filters) ? null : await builtUntil(context);
}

/** A range's totals, filtered when filters are given. */
export async function totals(context: ModuleContext, range: Range, filters?: Filters): Promise<Measures> {
	const { period, ...whole } = granularity(range);
	const { rolled, raw } = split(period, whole, await rolledUntil(context, filters));
	let found = ZERO;
	if (!isEmpty(rolled)) {
		const [row] = await context.data.aggregate(rollups, { where: rolledWhere(period, "total", rolled), values: SUMS });
		if (row) found = plus(found, measuresOf(row));
	}
	if (!isEmpty(raw)) {
		const where = and(within(raw.from, raw.to), await filtersWhere(context, whole, filters));
		found = plus(found, await rawTotals(context, where));
	}
	return found;
}

/** A range's totals for each hour or day of it, oldest first, with periods nothing happened in as zeros. */
export async function series(
	context: ModuleContext,
	range: Range,
	period: Period,
	filters?: Filters,
): Promise<({ start: Date } & Measures)[]> {
	const whole = wholePeriods(period, range);
	const { rolled, raw } = split(period, whole, await rolledUntil(context, filters));
	const found = new Map<number, Measures>();
	const add = (start: Date, measures: Measures) =>
		found.set(start.getTime(), plus(found.get(start.getTime()) ?? ZERO, measures));
	if (!isEmpty(rolled)) {
		const rows = await context.data.aggregate(rollups, {
			where: rolledWhere(period, "total", rolled),
			groupBy: { start: rollups.start },
			values: SUMS,
		});
		for (const row of rows) add(new Date(row.start), measuresOf(row));
	}
	if (!isEmpty(raw)) {
		const column = period === "hour" ? events.hour : events.day;
		const where = and(within(raw.from, raw.to), await filtersWhere(context, whole, filters));
		const grouped = async (extra: SQL, measure: keyof Measures, value: SQL<number>) => {
			const rows = await context.data.aggregate(events, {
				where: and(where, extra),
				groupBy: { start: column },
				values: { n: value },
			});
			for (const row of rows) add(new Date(row.start), { ...ZERO, [measure]: Number(row.n) });
		};
		await grouped(eq(events.type, "pageview"), "pageviews", count());
		await grouped(isNotNull(events.visitor), "visitors", countDistinct(events.visitor));
		await grouped(eq(events.startsVisit, true), "visits", count());
		await grouped(inArray(events.type, ["link", "event", "form"]), "events", count());
	}
	const points: ({ start: Date } & Measures)[] = [];
	for (let at = whole.from.getTime(); at < whole.to.getTime(); at += lengthOf(period)) {
		points.push({ start: new Date(at), ...(found.get(at) ?? ZERO) });
	}
	return points;
}

/**
 * A range's measures by the values of one dimension (pages, sources, countries, devices, browsers,
 * operating systems; or links, custom events and Forms for Goals), the biggest first: by page views,
 * or by events for Goals' dimensions. An empty value is none: a direct visit, an unknown country.
 */
export async function breakdown(
	context: ModuleContext,
	range: Range,
	dimension: Dimension,
	limit: number,
	filters?: Filters,
): Promise<({ value: string } & Measures)[]> {
	const { period, ...whole } = granularity(range);
	const { rolled, raw } = split(period, whole, await rolledUntil(context, filters));
	const found = new Map<string, Measures>();
	const add = (value: string, measures: Measures) => found.set(value, plus(found.get(value) ?? ZERO, measures));
	if (!isEmpty(rolled)) {
		const rows = await context.data.aggregate(rollups, {
			where: rolledWhere(period, dimension, rolled),
			groupBy: { value: rollups.value },
			values: SUMS,
		});
		for (const row of rows) add(row.value, measuresOf(row));
	}
	if (!isEmpty(raw)) {
		const where = and(within(raw.from, raw.to), await filtersWhere(context, whole, filters));
		for (const [value, measures] of await rawBreakdown(context, where, dimension)) {
			add(value, measures);
		}
	}
	const by: keyof Measures = isGoalDimension(dimension) ? "events" : "pageviews";
	return [...found]
		.map(([value, measures]) => ({ value, ...measures }))
		.sort((a, b) => b[by] - a[by] || b.visitors - a.visitors || a.value.localeCompare(b.value))
		.slice(0, limit);
}

/**
 * What the Site's analytics covers: the oldest raw event still kept (visit-by-visit questions, such
 * as Funnels, reach back only that far; totals reach back forever), and how far rollups are built.
 */
export async function coverage(
	context: ModuleContext,
): Promise<{ rawEventsFrom: Date | null; rolledUp: { hours: Date; days: Date } | null }> {
	const [row] = await context.data.aggregate(events, { values: { at: min(events.occurredAt) } });
	return { rawEventsFrom: row?.at ? new Date(row.at) : null, rolledUp: await builtUntil(context) };
}

/** A Goal's counts in a range: each time it was reached, and the visitors who reached it. */
export type GoalCounts = { conversions: number; visitors: number };

/**
 * Goals' counts in a range (raw events only, so as far back as they are kept), with the range's
 * visitors who accepted Analytics, the whole a conversion rate is a share of. A range's visitors are
 * its days' visitors added up, as everywhere: ids change every day.
 */
export async function goalCounts(
	context: ModuleContext,
	range: Range,
	goals: readonly Goal[],
	filters?: Filters,
): Promise<{ goals: GoalCounts[]; visitors: number }> {
	const { from, to } = granularity(range);
	const where = and(within(from, to), await filtersWhere(context, { from, to }, filters));
	const counted: GoalCounts[] = [];
	for (const goal of goals) {
		const [row] = await context.data.aggregate(events, {
			where: and(where, goalWhere(goal.definition)),
			values: { conversions: count(), visitors: countDistinct(events.visitor) },
		});
		counted.push({ conversions: Number(row?.conversions ?? 0), visitors: Number(row?.visitors ?? 0) });
	}
	const [all] = await context.data.aggregate(events, {
		where: and(where, isNotNull(events.visitor)),
		values: { visitors: countDistinct(events.visitor) },
	});
	return { goals: counted, visitors: Number(all?.visitors ?? 0) };
}

/** The range a question counts, widened to whole hours or days as `totals` widens it. */
export function countedRange(range: Range): Range {
	const { from, to } = granularity(range);
	return { from, to };
}

/** Limits on what one question may ask. */
export const MAX_HOURS = 31 * 24;
export const MAX_DAYS = 3660;
export { DAY_MS, HOUR_MS };
