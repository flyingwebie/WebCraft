// The Redirects and 404 log Module (ADR 0024): links to a Site never break. It keeps the Site's
// Redirect rules, which the Site pipeline asks right after Redirect domains, before the Site's own
// pages; it adds a rule whenever a published path changes (a new slug, a Page that moved, a URL
// pattern or the Default language that changed), always after the change, as a background job; and it
// keeps the 404 log, the paths visitors asked for that have no page, from which Editors add a rule
// with one click. Rules are Content: Editors, Owners and Staff change them, and a change applies at
// once (there is no Draft, as with Site settings). It imports nothing from WebCraft but the Module SDK.
import { defineModule, desc, job, notFoundLog, procedure, redirectRules, z } from "@webcraft/module-sdk";

import { ignoreMiss, LOG_KEPT_DAYS, listMisses, purgeMisses, recordMisses } from "./log.ts";
import { migrations } from "./migrations.ts";
import { addRule, findTarget, followPathChanges, removeRule, ruleView, updateRule } from "./rules.ts";
import { misses, rules } from "./tables.ts";

/** The most rules or paths one list answers. */
const LIST_LIMIT = 2000;

const status = z.union([z.literal(301), z.literal(302)]);
const text = z.string().max(2100);

export const redirects = defineModule({
	manifest: {
		id: "redirects",
		name: { en: "Redirects and 404 log", it: "Reindirizzamenti e registro 404" },
		description: {
			en: "Sends visitors from old paths to new ones with Redirect rules, added by Editors or automatically when a published path changes, and lists the paths visitors asked for that have no page.",
			it: "Porta i visitatori dai vecchi percorsi ai nuovi con regole di reindirizzamento, aggiunte dagli Editor o in automatico quando cambia un percorso pubblicato, ed elenca i percorsi richiesti che non hanno una pagina.",
		},
		version: "1.0.0",
		sdk: "^1.4.0",
		level: "site",
		onByDefault: true,
		adminLanguages: ["en", "it"],
		permissions: [
			{
				key: "manage",
				label: {
					en: "Manage Redirect rules and the 404 log",
					it: "Gestire le regole di reindirizzamento e il registro 404",
				},
				roles: ["staff", "owner", "editor"],
			},
		],
	},
	tables: [rules, misses],
	migrations,

	redirectRules: redirectRules({
		tables: [rules],
		find: (request, context) => findTarget(context, request.path),
	}),

	notFoundLog: notFoundLog({
		record: (batch, context) => recordMisses(context, batch),
	}),

	events: {
		async "entry.published"(event, context) {
			await followPathChanges(context, event.data.pathChanges, [event.data.path], "publish", event.occurredAt);
		},
		async "paths.changed"(event, context) {
			await followPathChanges(context, event.data.pathChanges, [], event.data.reason, event.occurredAt);
		},
	},

	procedures: {
		rules: {
			/** The Site's Redirect rules, the most recently changed first. */
			list: procedure({
				permission: "manage",
				input: z.object({ limit: z.number().int().min(1).max(LIST_LIMIT).default(500) }),
				async run(input, context) {
					const rows = await context.data.select(rules, undefined, {
						orderBy: [desc(rules.updatedAt), desc(rules.createdAt)],
						limit: input.limit,
					});
					return { rules: rows.map(ruleView), total: await context.data.count(rules) };
				},
			}),
			/** Adds a rule: from a path (or every path under one, `/old/*`) to a path or an https:// address. */
			add: procedure({
				permission: "manage",
				input: z.object({ from: text, to: text, status: status.default(301) }),
				async run(input, context) {
					return { rule: await addRule(context, input) };
				},
			}),
			update: procedure({
				permission: "manage",
				input: z.object({ ruleId: z.uuid(), from: text.optional(), to: text.optional(), status: status.optional() }),
				async run({ ruleId, ...change }, context) {
					return { rule: await updateRule(context, ruleId, change) };
				},
			}),
			remove: procedure({
				permission: "manage",
				input: z.object({ ruleId: z.uuid() }),
				async run(input, context) {
					await removeRule(context, input.ruleId);
					return { removed: true };
				},
			}),
		},
		notFound: {
			/** The 404 log: the paths asked for most often first; `ignored` lists the ignored ones instead. */
			list: procedure({
				permission: "manage",
				input: z.object({
					ignored: z.boolean().default(false),
					limit: z.number().int().min(1).max(LIST_LIMIT).default(200),
				}),
				async run(input, context) {
					return listMisses(context, input.ignored, input.limit);
				},
			}),
			/** Ignores a path of the 404 log (it leaves the list), or shows it again. */
			ignore: procedure({
				permission: "manage",
				input: z.object({ missId: z.uuid(), ignored: z.boolean().default(true) }),
				async run(input, context) {
					return { miss: await ignoreMiss(context, input.missId, input.ignored) };
				},
			}),
		},
	},

	adminPages: [{ path: "redirects", label: { en: "Redirects", it: "Reindirizzamenti" }, permission: "manage" }],

	jobs: {
		/** Forgets the paths of the 404 log nobody asked for in 90 days. */
		purgeLog: job({
			payload: z.object({}),
			async run(_payload, context) {
				const deleted = await purgeMisses(context);
				if (deleted > 0) {
					await context.log.info(`Forgot 404 log paths nobody asked for in ${LOG_KEPT_DAYS} days.`, { deleted });
				}
			},
		}),
	},
	schedules: [{ job: "purgeLog", every: "day" }],
});

export type { MissView } from "./log.ts";
export type { RuleView } from "./rules.ts";
export default redirects;
