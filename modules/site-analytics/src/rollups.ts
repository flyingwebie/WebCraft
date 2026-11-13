import { and, count, eq, gte, lt, type ModuleContext, min, type SQL } from "@webcraft/module-sdk";

import { DIMENSIONS, KEPT_VALUES, rawBreakdown, rawTotals } from "./measures.ts";
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
 *
 * One run at a time builds a Site's rollups, in one transaction: it starts by moving the Site's state
 * on from what it read, which holds that row until it ends. A run that overlaps it (hours were missed
 * and two workers took a job each) waits there, then finds the state moved on and has nothing to do.
 */
export async function rollUp(context: ModuleContext): Promise<void> {
	const built = await startedState(context);
	await context.transaction(async (tx) => {
		const now = tx.now();
		const hours = startOf("hour", now);
		const days = startOf("day", now);
		const claimed = await tx.data.update(
			rollupState,
			{ hoursUntil: hours, daysUntil: days },
			and(eq(rollupState.hoursUntil, built.hours), eq(rollupState.daysUntil, built.days)),
		);
		if (claimed.length === 0) return;
		await buildPeriods(tx, "hour", built.hours, hours);
		await buildPeriods(tx, "day", built.days, days);
	});
}

/**
 * How far the Site's rollups are built, starting its state at its oldest raw event (now, without
 * any) the first time. Two first runs at once both start it: the one that comes second reads what
 * the first wrote.
 */
async function startedState(context: ModuleContext): Promise<Built> {
	const built = await builtUntil(context);
	if (built) return built;
	const [first] = await context.data.aggregate(events, { values: { at: min(events.occurredAt) } });
	const from = first?.at ? new Date(first.at) : context.now();
	const started = { hours: startOf("hour", from), days: startOf("day", from) };
	try {
		await context.data.insert(rollupState, { hoursUntil: started.hours, daysUntil: started.days });
		return started;
	} catch (error) {
		const other = await builtUntil(context);
		if (!other) throw error;
		return other;
	}
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

/**
 * Makes one period's rollup rows again from its raw events: the totals, and for each dimension its
 * `KEPT_VALUES` biggest values with the rest together as `OTHER`, so a period's rows are bounded
 * whatever visitors sent. Inside the run's transaction.
 */
async function buildPeriod(context: ModuleContext, period: Period, start: Date): Promise<void> {
	const where = within(start, new Date(start.getTime() + lengthOf(period)));
	await context.data.delete(rollups, and(eq(rollups.period, period), eq(rollups.start, start)));
	await context.data.insert(rollups, {
		period,
		start,
		dimension: "total",
		value: "",
		...(await rawTotals(context, where)),
	});
	for (const dimension of DIMENSIONS) {
		for (const [value, measures] of await rawBreakdown(context, where, dimension, KEPT_VALUES[period])) {
			await context.data.insert(rollups, { period, start, dimension, value, ...measures });
		}
	}
}
