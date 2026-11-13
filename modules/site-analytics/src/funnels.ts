/**
 * Funnels (Structure, built by Staff): two to five steps, each one of the Site's Goals or a page
 * visit, counted per visitor within one day (their daily id, ADR 0020): a visitor reaches a step when,
 * after reaching the step before, one of their events that day reaches it. Only visitors who accepted
 * Analytics have an id, so only they are counted. Form Submissions count once they are linked to the
 * visitor's visit (see `form.submitted` in `index.ts`); one sent without a visit counted on the Site
 * that day (the collection script blocked, or Analytics accepted only on the Form's own post) reaches
 * its Goal's counts but no Funnel step.
 */
import {
	and,
	asc,
	count,
	eq,
	inArray,
	isNotNull,
	type ModuleContext,
	ModuleError,
	or,
	type SQL,
	z,
} from "@webcraft/module-sdk";

import { type Filters, filtersWhere } from "./filters.ts";
import {
	type EventFacts,
	type Goal,
	goalMatches,
	goalWhere,
	listGoals,
	type PathMatch,
	pathMatches,
	pathMatchSchema,
	pathWhere,
} from "./goals.ts";
import { within } from "./rollups.ts";
import { events, funnels } from "./tables.ts";

/** How many Funnels a Site may have. */
export const MAX_FUNNELS = 50;

export const funnelStepSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("goal"), goalId: z.uuid() }),
	z.object({ kind: z.literal("page"), ...pathMatchSchema.shape }),
]);

export const funnelStepsSchema = z.array(funnelStepSchema).min(2).max(5);

export type FunnelStep = z.infer<typeof funnelStepSchema>;

/** A step as procedures answer it: what it is, and its name (the Goal's, or the page's path). */
export type FunnelStepView = FunnelStep & { label: string };

export type Funnel = { id: string; name: string; steps: FunnelStepView[]; createdAt: Date; updatedAt: Date };

/** A step's label: its Goal's name, or the path (`/shop/*` for a page and those under it). */
function labelOf(step: FunnelStep, goals: ReadonlyMap<string, Goal>): string {
	if (step.kind === "goal") return goals.get(step.goalId)?.name ?? "";
	return step.match === "exact" ? step.path : `${step.path.replace(/\/+$/, "")}/*`;
}

export function funnelOf(row: typeof funnels.$inferSelect, goals: ReadonlyMap<string, Goal>): Funnel {
	const steps = funnelStepsSchema.parse(row.steps);
	return {
		id: row.id,
		name: row.name,
		steps: steps.map((step) => ({ ...step, label: labelOf(step, goals) })),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The Site's Funnels, by name. */
export async function listFunnels(context: ModuleContext): Promise<Funnel[]> {
	const goals = new Map((await listGoals(context)).map((goal) => [goal.id, goal]));
	const rows = await context.data.select(funnels, undefined, { orderBy: [asc(funnels.name), asc(funnels.id)] });
	return rows
		.map((row) => funnelOf(row, goals))
		.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** The Site's Funnel with this name (upper and lower case alike), or a refusal. */
export async function requireFunnel(context: ModuleContext, name: string): Promise<Funnel> {
	const wanted = name.trim().toLowerCase();
	const funnel = (await listFunnels(context)).find((each) => each.name.toLowerCase() === wanted);
	if (!funnel) throw new ModuleError("FUNNEL_NOT_FOUND", `This Site has no Funnel named "${name}".`, 404);
	return funnel;
}

/** Refuses steps naming a Goal the Site doesn't have. */
export async function checkSteps(context: ModuleContext, steps: readonly FunnelStep[]): Promise<void> {
	const goals = new Set((await listGoals(context)).map((goal) => goal.id));
	const missing = steps.findIndex((step) => step.kind === "goal" && !goals.has(step.goalId));
	if (missing >= 0) {
		throw new ModuleError("FUNNEL_STEP_INVALID", `Step ${missing + 1} names a Goal this Site doesn't have.`, 400);
	}
}

/** One step, as counted: its events in SQL, and the same test on one event in memory. */
type CountedStep = { where: SQL | undefined; matches(event: EventFacts): boolean };

function counted(step: FunnelStep, goals: ReadonlyMap<string, Goal>): CountedStep {
	if (step.kind === "page") {
		const page: PathMatch = { path: step.path, match: step.match };
		return {
			where: and(eq(events.type, "pageview"), isNotNull(events.visitor), pathWhere(page)),
			matches: (event) => event.type === "pageview" && pathMatches(page, event.path),
		};
	}
	const goal = goals.get(step.goalId);
	if (!goal) throw new ModuleError("FUNNEL_STEP_INVALID", "A step names a Goal this Site no longer has.", 409);
	return { where: goalWhere(goal.definition), matches: (event) => goalMatches(goal.definition, event) };
}

/**
 * How many visitors reached each step of a Funnel in a range, in order, each within one day: the
 * events of the visitors who reached the first step, oldest first, walked step by step for each
 * visitor and UTC day. A daily id belongs to one UTC day already (ADR 0020); the walk says so itself,
 * so a step on another day never follows one, whatever ids an event carries.
 */
export async function funnelCounts(
	context: ModuleContext,
	range: { from: Date; to: Date },
	funnel: Funnel,
	filters?: Filters,
): Promise<number[]> {
	const goals = new Map((await listGoals(context)).map((goal) => [goal.id, goal]));
	const steps = funnel.steps.map((step) => counted(step, goals));
	const [first] = steps;
	const reached = steps.map(() => 0);
	if (!first) return reached;
	const where = and(
		within(range.from, range.to),
		isNotNull(events.visitor),
		await filtersWhere(context, range, filters),
	);
	const starters = context.data.values(events, events.visitor, and(where, first.where));
	const rows = await context.data.aggregate(events, {
		where: and(where, inArray(events.visitor, starters), or(...steps.map((step) => step.where))),
		groupBy: {
			visitor: events.visitor,
			occurredAt: events.occurredAt,
			type: events.type,
			name: events.name,
			target: events.target,
			path: events.path,
		},
		values: { n: count() },
		orderBy: [asc(events.visitor), asc(events.occurredAt)],
	});
	let walking: string | null = null;
	let at = 0;
	for (const row of rows) {
		const day = new Date(row.occurredAt).toISOString().slice(0, 10);
		const key = `${row.visitor}\u0000${day}`;
		if (key !== walking) {
			walking = key;
			at = 0;
		}
		for (let copy = 0; copy < Number(row.n) && at < steps.length; copy++) {
			if (!steps[at]?.matches(row)) break;
			reached[at] = (reached[at] ?? 0) + 1;
			at += 1;
		}
	}
	return reached;
}
