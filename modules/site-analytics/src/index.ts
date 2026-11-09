// The Site analytics Module (ADRs 0019, 0020, 0024): WebCraft's own cookieless analytics. Its
// collection script posts to a path on the Site's own domain; before consent it counts anonymous
// totals only (page views, sources, countries, devices), and after Analytics consent visitors,
// visits and what Goals need (link clicks, custom events), with a daily-salted id WebCraft makes
// without ever handing the Module the visitor's address. Raw events are kept in monthly partitions
// as long as the Install keeps them (13 months by default); hourly and daily rollups are kept
// forever, and everything reads them through one query interface (`query.ts`). It imports nothing
// from WebCraft but the Module SDK.
import { defineModule, isAddressRange, job, ModuleError, procedure, siteRoute, z } from "@webcraft/module-sdk";

import { collect } from "./collect.ts";
import { dimensionSchema } from "./measures.ts";
import { migrations } from "./migrations.ts";
import { breakdown, coverage, DAY_MS, HOUR_MS, MAX_DAYS, MAX_HOURS, type Range, series, totals } from "./query.ts";
import { rollUp, startOf } from "./rollups.ts";
import { COLLECTION_SCRIPT } from "./script.ts";
import { events, rollupState, rollups, settings } from "./tables.ts";

export { COLLECTION_PATH, COLLECTION_SCRIPT } from "./script.ts";

/** How many address ranges a Site may leave out. */
export const MAX_EXCLUDED_RANGES = 50;

/** A range of time to count, `from` up to `to`, both whole hours in UTC (see `query.ts`). */
const range = z.object({ from: z.date(), to: z.date() });

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
		version: "1.0.0",
		sdk: "^1.4.0",
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
	tables: [events, rollups, rollupState, settings],
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
				kind: "read",
				input: range,
				async run(input, context) {
					return { totals: await totals(context, checked(input, periodOf(input))) };
				},
			}),
			/** A range's totals by hour or by day. */
			series: procedure({
				permission: "analytics.view",
				kind: "read",
				input: range.extend({ interval: z.enum(["hour", "day"]) }),
				async run(input, context) {
					return { points: await series(context, checked(input, input.interval), input.interval) };
				},
			}),
			/** A range's measures by the values of one dimension, the biggest first. */
			breakdown: procedure({
				permission: "analytics.view",
				kind: "read",
				input: range.extend({ dimension: dimensionSchema, limit: z.number().int().min(1).max(1000).default(10) }),
				async run(input, context) {
					return {
						rows: await breakdown(context, checked(input, periodOf(input)), input.dimension, input.limit),
					};
				},
			}),
			/** How far back the raw events reach, and how far rollups are built. */
			coverage: procedure({
				permission: "analytics.view",
				kind: "read",
				input: z.object({}),
				async run(_input, context) {
					return coverage(context);
				},
			}),
		},
		settings: {
			/** The Site's analytics settings. */
			get: procedure({
				permission: "structure.edit",
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
		 * typed, on the terms of the collection path. Only once the sender accepted Analytics (where an
		 * outside consent service asks, WebCraft can't read the answer, so never), and never from the
		 * Staging address, from someone of the Install, or with Do Not Track or Global Privacy Control.
		 * The Site's excluded address ranges can't apply: the event never holds the address.
		 */
		async "form.submitted"(event, context) {
			const { sender } = event.data;
			if (sender.via === "staging" || sender.signedIn || sender.doNotTrack) return;
			if (!sender.consent.accepted.includes("analytics")) return;
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
				country: null,
				device: "",
				browser: "",
				os: "",
				visitor: null,
				visit: null,
				startsVisit: false,
			});
		},
	},
});

export default siteAnalytics;
