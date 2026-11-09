import { and, count, eq, gte, lt, type ModuleContext, min, type SQL } from "@webcraft/module-sdk";

import { DIMENSIONS, type Measures, rawBreakdown, rawTotals } from "./measures.ts";
import { events, rollupState, rollups } from "./tables.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export type Period = "hour" | "day";

/** The start of the hour (or the UTC day) `time` is in. */
export function startOf(period: Period, time: Date): Date {
	const size = period === "hour" ? HOUR_MS : DAY_MS;
	return new Date(Math.floor(time.getTime() / size) * size);
}

export function lengthOf(period: Period): number {
	return period === "hour" ? HOUR_MS : DAY_MS;
}

/** The raw events of one hour or day. */
export function within(start: Date, end: Date): SQL | undefined {
	return and(gte(events.occurredAt, start), lt(events.occurredAt, end));
}

/** How far a Site's rollups are built: every hour before `hours`, every day before `days`. */
export type Built = { hours: Date; days: Date };

/** How far the Site's rollups are built, or null while nothing has been. */
export async function builtUntil(context: ModuleContext): Promise<Built | null> {
	const state = await context.data.first(rollupState);
	return state ? { hours: state.hoursUntil, days: state.daysUntil } : null;
}

/**
 * Builds the Site's hourly and daily rollups for every hour and day that ended since the last run
 * (the `rollUp` job, every hour): each period's rows are made again from its raw events, so running
 * it twice changes nothing. Rollups are kept forever, raw events only as long as the Install keeps
 * them, so each period is built while its raw events are still there.
 */
export async function rollUp(context: ModuleContext): Promise<void> {
	const now = context.now();
	let built = await builtUntil(context);
	if (!built) {
		const [first] = await context.data.aggregate(events, { values: { at: min(events.occurredAt) } });
		const from = first?.at ? new Date(first.at) : now;
		built = { hours: startOf("hour", from), days: startOf("day", from) };
		await context.data.insert(rollupState, { hoursUntil: built.hours, daysUntil: built.days });
	}
	const hours = startOf("hour", now);
	const days = startOf("day", now);
	await buildPeriods(context, "hour", built.hours, hours);
	await buildPeriods(context, "day", built.days, days);
	await context.data.update(rollupState, { hoursUntil: hours, daysUntil: days });
}

/** Builds every period in [from, until) that has raw events. */
async function buildPeriods(context: ModuleContext, period: Period, from: Date, until: Date): Promise<void> {
	if (from >= until) return;
	const column = period === "hour" ? events.hour : events.day;
	const periods = await context.data.aggregate(events, {
		where: within(from, until),
		groupBy: { start: column },
		values: { n: count() },
	});
	const starts = periods.map((row) => new Date(row.start)).sort((a, b) => a.getTime() - b.getTime());
	for (const start of starts) await buildPeriod(context, period, start);
}

/** Makes one period's rollup rows again from its raw events. */
async function buildPeriod(context: ModuleContext, period: Period, start: Date): Promise<void> {
	const where = within(start, new Date(start.getTime() + lengthOf(period)));
	const rows: { dimension: string; value: string; measures: Measures }[] = [
		{ dimension: "total", value: "", measures: await rawTotals(context, where) },
	];
	for (const dimension of DIMENSIONS) {
		for (const [value, measures] of await rawBreakdown(context, where, dimension)) {
			rows.push({ dimension, value, measures });
		}
	}
	await context.transaction(async (tx) => {
		await tx.data.delete(rollups, and(eq(rollups.period, period), eq(rollups.start, start)));
		for (const row of rows) {
			await tx.data.insert(rollups, { period, start, dimension: row.dimension, value: row.value, ...row.measures });
		}
	});
}
