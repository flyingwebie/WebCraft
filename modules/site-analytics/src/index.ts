// The Site analytics Module (ADRs 0019, 0020, 0024): WebCraft's own cookieless analytics. Its
// collection script posts to a path on the Site's own domain; before consent it counts anonymous
// totals only (page views, sources, countries, devices), and after Analytics consent visitors,
// visits and what Goals need (link clicks, custom events), with a daily-salted id WebCraft makes
// without ever handing the Module the visitor's address. Raw events are kept in monthly partitions
// as long as the Install keeps them (13 months by default); hourly and daily rollups are kept
// forever, and everything reads them through one query interface (`query.ts`). It imports nothing
// from WebCraft but the Module SDK.
import {
	and,
	defineModule,
	desc,
	eq,
	formSenderCounted,
	gte,
	isAddressRange,
	job,
	lte,
	ModuleError,
	procedure,
	siteRoute,
	z,
} from "@webcraft/module-sdk";

import { collect, VISIT_GAP_MS } from "./collect.ts";
import { filtersSchema } from "./filters.ts";
import {
	checkSteps,
	type Funnel,
	funnelCounts,
	funnelOf,
	funnelStepsSchema,
	listFunnels,
	MAX_FUNNELS,
	requireFunnel,
} from "./funnels.ts";
import {
	assertNameFree,
	type Goal,
	goalDefinitionSchema,
	goalOf,
	listGoals,
	MAX_GOALS,
	nameSchema,
	requireGoal,
} from "./goals.ts";
import { dimensionSchema } from "./measures.ts";
import { migrations } from "./migrations.ts";
import {
	breakdown,
	countedRange,
	coverage,
	DAY_MS,
	goalCounts,
	HOUR_MS,
	MAX_DAYS,
	MAX_HOURS,
	type Range,
	series,
	totals,
} from "./query.ts";
import { rollUp, startOf } from "./rollups.ts";
import { COLLECTION_SCRIPT } from "./script.ts";
import { events, funnels, goals, rollupState, rollups, settings } from "./tables.ts";
import { siteAnalyticsWidgets } from "./widgets.ts";

export { COLLECTION_PATH, COLLECTION_SCRIPT } from "./script.ts";

/** How many address ranges a Site may leave out. */
export const MAX_EXCLUDED_RANGES = 50;

/** A range of time to count, `from` up to `to`, both whole hours in UTC (see `query.ts`). */
const range = z.object({ from: z.date(), to: z.date() });

/** What a count may be narrowed to (see `filters.ts`): none unless given. */
const filters = filtersSchema.optional();

/** A Funnel row as procedures answer it. */
async function funnelView(context: Parameters<typeof listGoals>[0], row: typeof funnels.$inferSelect): Promise<Funnel> {
	const byId = new Map<string, Goal>((await listGoals(context)).map((goal) => [goal.id, goal]));
	return funnelOf(row, byId);
}

/** The range, when it is one that may be counted by `period`. */
function checked(input: Range, period: "hour" | "day"): Range {
	if (input.from.getTime() >= input.to.getTime()) {
		throw new ModuleError("RANGE_INVALID", "A range's start comes before its end.");
	}
	const hours = (input.to.getTime() - input.from.getTime()) / HOUR_MS;
	if (period === "hour" ? hours > MAX_HOURS : hours > MAX_DAYS * 24) {
		throw new ModuleError("RANGE_TOO_LONG", "That range is too long to count by the hour or day asked for.");
	}
	return input;
}

const periodOf = (input: Range) =>
	input.from.getTime() % DAY_MS === 0 && input.to.getTime() % DAY_MS === 0 ? "day" : "hour";

export const siteAnalytics = defineModule({
	manifest: {
		id: "site-analytics",
		name: { en: "Site analytics", it: "Statistiche del sito" },
		description: {
			en: "Counts each Site's visits with WebCraft's own cookieless tracking, kept in this Install's database: anonymous totals before visitors accept Analytics, visitors and visits once they do.",
			it: "Conta le visite di ogni Sito con il tracciamento di WebCraft, senza cookie, nel database di questa installazione: totali anonimi finché i visitatori non accettano le Statistiche, visitatori e visite quando lo fanno.",
		},
		version: "1.1.0",
		sdk: "^1.9.0",
		level: "site",
		// Sites ship no JavaScript by default: Staff switch it on where it is wanted.
		onByDefault: false,
		adminLanguages: ["en", "it"],
		permissions: [
			{
				key: "analytics.view",
				label: { en: "See Site analytics", it: "Vedere le statistiche del sito" },
				roles: ["staff", "owner"],
			},
		],
		routePrefix: "analytics",
		siteScript: "analytics",
	},
	// Goals and Funnels are Structure: Staff build them (their screens are in the admin's `ui/analytics/`).
	adminPages: [
		{ path: "goals", label: { en: "Goals", it: "Obiettivi" }, permission: "structure.edit" },
		{ path: "funnels", label: { en: "Funnels", it: "Funnel" }, permission: "structure.edit" },
	],
	tables: [events, rollups, rollupState, settings, goals, funnels],
	migrations,
	partitions: [
		{
			table: events,
			column: events.occurredAt,
			label: { en: "Raw events", it: "Eventi grezzi" },
			keepMonths: 13,
		},
	],
	siteScript: { code: COLLECTION_SCRIPT, beforeConsent: true },

	siteRoutes: [
		siteRoute({
			method: "POST",
			path: "/event",
			limit: { requests: 120, perSeconds: 60 },
			maxBodyBytes: 4096,
			handle: collect,
		}),
	],

	procedures: {
		stats: {
			/** A range's totals: page views, visitors, visits and events. */
			totals: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: range.extend({ filters }),
				async run(input, context) {
					return { totals: await totals(context, checked(input, periodOf(input)), input.filters) };
				},
			}),
			/** A range's totals by hour or by day. */
			series: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: range.extend({ interval: z.enum(["hour", "day"]), filters }),
				async run(input, context) {
					return {
						points: await series(context, checked(input, input.interval), input.interval, input.filters),
					};
				},
			}),
			/** A range's measures by the values of one dimension, the biggest first. */
			breakdown: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: range.extend({
					dimension: dimensionSchema,
					limit: z.number().int().min(1).max(1000).default(10),
					filters,
				}),
				async run(input, context) {
					return {
						rows: await breakdown(
							context,
							checked(input, periodOf(input)),
							input.dimension,
							input.limit,
							input.filters,
						),
					};
				},
			}),
			/**
			 * The Site's Goals' counts in a range (or the Goals named): how many times each was reached
			 * and by how many visitors, with the range's visitors who accepted Analytics, the whole a
			 * conversion rate is a share of. From the raw events, so as far back as they are kept.
			 */
			goals: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: range.extend({ goals: z.array(nameSchema).max(MAX_GOALS).optional(), filters }),
				async run(input, context) {
					const counted = checked(input, periodOf(input));
					const chosen = input.goals
						? await Promise.all(input.goals.map((name) => requireGoal(context, name)))
						: await listGoals(context);
					const found = await goalCounts(context, counted, chosen, input.filters);
					return {
						goals: chosen.map((goal, index) => ({
							name: goal.name,
							kind: goal.definition.kind,
							conversions: found.goals[index]?.conversions ?? 0,
							visitors: found.goals[index]?.visitors ?? 0,
						})),
						visitors: found.visitors,
					};
				},
			}),
			/**
			 * How many visitors reached each step of a Funnel in a range, in order, each within one day:
			 * from the raw events, so as far back as they are kept.
			 */
			funnel: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: range.extend({ funnel: nameSchema, filters }),
				async run(input, context) {
					const funnel = await requireFunnel(context, input.funnel);
					const reached = await funnelCounts(
						context,
						countedRange(checked(input, periodOf(input))),
						funnel,
						input.filters,
					);
					return {
						name: funnel.name,
						steps: funnel.steps.map((step, index) => ({ label: step.label, visitors: reached[index] ?? 0 })),
					};
				},
			}),
			/** How far back the raw events reach, and how far rollups are built. */
			coverage: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: z.object({}),
				async run(_input, context) {
					return coverage(context);
				},
			}),
		},
		goals: {
			/** The Site's Goals, by name. */
			list: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: z.object({}),
				async run(_input, context) {
					return { goals: await listGoals(context) };
				},
			}),
			/** Adds a Goal: its name (unique on the Site, whatever its case) and what it counts. Structure, Staff only. */
			create: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({ name: nameSchema, definition: goalDefinitionSchema }),
				async run(input, context) {
					const existing = await listGoals(context);
					if (existing.length >= MAX_GOALS) {
						throw new ModuleError("GOALS_TOO_MANY", `A Site has at most ${MAX_GOALS} Goals.`, 400);
					}
					assertNameFree(existing, input.name, null, "GOAL_NAME_TAKEN", "Goal");
					const { kind, ...definition } = input.definition;
					const now = context.now();
					const goal = await context.transaction(async (tx) => {
						const row = await tx.data.insert(goals, {
							name: input.name,
							kind,
							definition,
							createdAt: now,
							updatedAt: now,
						});
						await tx.audit("goal.create", { goalId: row.id, name: row.name, kind });
						return goalOf(row);
					});
					return { goal };
				},
			}),
			/** Renames a Goal or changes what it counts. Widgets name Goals by name: they follow a new one only once chosen again. */
			update: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({ goalId: z.uuid(), name: nameSchema.optional(), definition: goalDefinitionSchema.optional() }),
				async run(input, context) {
					const existing = await listGoals(context);
					const current = existing.find((goal) => goal.id === input.goalId);
					if (!current) throw new ModuleError("GOAL_NOT_FOUND", "This Site has no such Goal.", 404);
					if (input.name !== undefined) assertNameFree(existing, input.name, current.id, "GOAL_NAME_TAKEN", "Goal");
					const next = { name: input.name ?? current.name, definition: input.definition ?? current.definition };
					const { kind, ...definition } = next.definition;
					const goal = await context.transaction(async (tx) => {
						const [row] = await tx.data.update(
							goals,
							{ name: next.name, kind, definition, updatedAt: context.now() },
							eq(goals.id, current.id),
						);
						await tx.audit("goal.update", {
							goalId: current.id,
							name: next.name,
							...(next.name !== current.name ? { from: current.name } : {}),
						});
						return goalOf(row as typeof goals.$inferSelect);
					});
					return { goal };
				},
			}),
			/**
			 * Deletes a Goal, in two steps: without `confirmation` it deletes nothing and answers what would
			 * go, with a confirmation id; with it, the Goal goes. A Goal a Funnel uses is kept until the
			 * Funnel no longer does (`GOAL_IN_FUNNEL`). What it counted stays in the raw events.
			 */
			delete: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({ goalId: z.uuid(), confirmation: z.string().max(100).optional() }),
				async run(input, context) {
					const goal = (await listGoals(context)).find((each) => each.id === input.goalId);
					if (!goal) throw new ModuleError("GOAL_NOT_FOUND", "This Site has no such Goal.", 404);
					const usedBy = (await listFunnels(context)).filter((funnel) =>
						funnel.steps.some((step) => step.kind === "goal" && step.goalId === goal.id),
					);
					if (usedBy.length > 0) {
						throw new ModuleError(
							"GOAL_IN_FUNNEL",
							`The Funnels ${usedBy.map((funnel) => `"${funnel.name}"`).join(", ")} use this Goal: change them first.`,
							409,
						);
					}
					const preview = { name: goal.name };
					const target = `goal:${goal.id}`;
					if (input.confirmation === undefined) {
						const confirmation = await context.confirmations.ask("goal.delete", target, preview);
						return { deleted: false as const, confirmation, preview };
					}
					await context.confirmations.use(input.confirmation, "goal.delete", target, preview);
					await context.transaction(async (tx) => {
						await tx.data.delete(goals, eq(goals.id, goal.id));
						await tx.audit("goal.delete", { goalId: goal.id, name: goal.name });
					});
					return { deleted: true as const };
				},
			}),
		},
		funnels: {
			/** The Site's Funnels, by name, each step with its label (its Goal's name, or the page's path). */
			list: procedure({
				permission: "analytics.view",
				toolset: "analytics",
				kind: "read",
				input: z.object({}),
				async run(_input, context) {
					return { funnels: await listFunnels(context) };
				},
			}),
			/** Adds a Funnel: its name (unique on the Site) and two to five steps. Structure, Staff only. */
			create: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({ name: nameSchema, steps: funnelStepsSchema }),
				async run(input, context) {
					const existing = await listFunnels(context);
					if (existing.length >= MAX_FUNNELS) {
						throw new ModuleError("FUNNELS_TOO_MANY", `A Site has at most ${MAX_FUNNELS} Funnels.`, 400);
					}
					assertNameFree(existing, input.name, null, "FUNNEL_NAME_TAKEN", "Funnel");
					await checkSteps(context, input.steps);
					const now = context.now();
					const funnel = await context.transaction(async (tx) => {
						const row = await tx.data.insert(funnels, {
							name: input.name,
							steps: input.steps,
							createdAt: now,
							updatedAt: now,
						});
						await tx.audit("funnel.create", { funnelId: row.id, name: row.name, steps: input.steps.length });
						return row;
					});
					return { funnel: await funnelView(context, funnel) };
				},
			}),
			/** Renames a Funnel or changes its steps. */
			update: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({ funnelId: z.uuid(), name: nameSchema.optional(), steps: funnelStepsSchema.optional() }),
				async run(input, context) {
					const existing = await listFunnels(context);
					const current = existing.find((funnel) => funnel.id === input.funnelId);
					if (!current) throw new ModuleError("FUNNEL_NOT_FOUND", "This Site has no such Funnel.", 404);
					if (input.name !== undefined) {
						assertNameFree(existing, input.name, current.id, "FUNNEL_NAME_TAKEN", "Funnel");
					}
					if (input.steps) await checkSteps(context, input.steps);
					const name = input.name ?? current.name;
					const steps = input.steps ?? current.steps.map(({ label: _label, ...step }) => step);
					const funnel = await context.transaction(async (tx) => {
						const [row] = await tx.data.update(
							funnels,
							{ name, steps, updatedAt: context.now() },
							eq(funnels.id, current.id),
						);
						await tx.audit("funnel.update", { funnelId: current.id, name, steps: steps.length });
						return row as typeof funnels.$inferSelect;
					});
					return { funnel: await funnelView(context, funnel) };
				},
			}),
			/** Deletes a Funnel, in two steps, as Goals are deleted. */
			delete: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({ funnelId: z.uuid(), confirmation: z.string().max(100).optional() }),
				async run(input, context) {
					const funnel = (await listFunnels(context)).find((each) => each.id === input.funnelId);
					if (!funnel) throw new ModuleError("FUNNEL_NOT_FOUND", "This Site has no such Funnel.", 404);
					const preview = { name: funnel.name };
					const target = `funnel:${funnel.id}`;
					if (input.confirmation === undefined) {
						const confirmation = await context.confirmations.ask("funnel.delete", target, preview);
						return { deleted: false as const, confirmation, preview };
					}
					await context.confirmations.use(input.confirmation, "funnel.delete", target, preview);
					await context.transaction(async (tx) => {
						await tx.data.delete(funnels, eq(funnels.id, funnel.id));
						await tx.audit("funnel.delete", { funnelId: funnel.id, name: funnel.name });
					});
					return { deleted: true as const };
				},
			}),
		},
		settings: {
			/** The Site's analytics settings. */
			get: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				kind: "read",
				input: z.object({}),
				async run(_input, context) {
					const row = await context.data.first(settings);
					return { excludedRanges: (row?.excludedRanges as string[] | undefined) ?? [] };
				},
			}),
			/** Changes the address ranges whose visits are left out (Staff, a Site setting). */
			update: procedure({
				permission: "structure.edit",
				toolset: "analytics",
				input: z.object({
					excludedRanges: z
						.array(z.string().trim().min(1).max(64))
						.max(MAX_EXCLUDED_RANGES)
						.refine((ranges) => ranges.every(isAddressRange), "Each range is an address or a CIDR block."),
				}),
				async run(input, context) {
					const excludedRanges = [...new Set(input.excludedRanges)];
					const values = { excludedRanges, updatedAt: context.now() };
					await context.transaction(async (tx) => {
						const changed = await tx.data.update(settings, values);
						if (changed.length === 0) await tx.data.insert(settings, values);
						await tx.audit("settings.update", { excludedRanges });
					});
					return { excludedRanges };
				},
			}),
		},
	},

	jobs: {
		/** Builds the hourly and daily rollups of every hour and day that ended since it last ran. */
		rollUp: job({
			payload: z.object({}),
			run: async (_payload, context) => rollUp(context),
		}),
	},
	schedules: [{ job: "rollUp", every: "hour" }],

	events: {
		/**
		 * A Form Submission is something a Goal counts (#103): kept as an event, with nothing the visitor
		 * typed, on the terms of the collection path, by the one rule the SDK gives for whether a sender
		 * is counted by analytics (`formSenderCounted`, SDK 1.8: Analytics accepted, never Staging,
		 * someone of the Install, Do Not Track or Global Privacy Control). The Site's excluded address
		 * ranges can't apply: the event never holds the address.
		 *
		 * With the sender's id for the day (SDK 1.8, given on the same rule), it joins the visit that
		 * sender had going on the Site (an event in the last 30 minutes), with the visit's source,
		 * country and device, so Funnels and filters count it; without one, it stands alone, counted by
		 * Form only.
		 */
		async "form.submitted"(event, context) {
			const { sender } = event.data;
			if (!formSenderCounted(sender)) return;
			const visitor = event.data.visitor ?? null;
			const last = visitor
				? await context.data.first(
						events,
						and(
							eq(events.visitor, visitor),
							gte(events.occurredAt, new Date(event.occurredAt.getTime() - VISIT_GAP_MS)),
							lte(events.occurredAt, event.occurredAt),
						),
						{ orderBy: [desc(events.occurredAt)] },
					)
				: undefined;
			await context.data.insert(events, {
				occurredAt: event.occurredAt,
				hour: startOf("hour", event.occurredAt),
				day: startOf("day", event.occurredAt),
				type: "form",
				name: event.data.formKey,
				target: event.data.formId,
				path: event.data.page ?? "",
				source: null,
				medium: null,
				campaign: null,
				country: last?.country ?? null,
				device: last?.device ?? "",
				browser: last?.browser ?? "",
				os: last?.os ?? "",
				visitor: last ? visitor : null,
				visit: last?.visit ?? null,
				startsVisit: false,
				visitSource: last?.visitSource ?? null,
			});
		},
	},

	widgets: siteAnalyticsWidgets,
	widgetGoals: async (context) => (await listGoals(context)).map((goal) => goal.name),
});

export default siteAnalytics;
