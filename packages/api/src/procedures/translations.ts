import { can, type ItemRef, PROTECTED_TERM_LIMITS, SiteNotFoundError, TRANSLATION_MODES } from "@webcraft/core";
import { z } from "zod";

import { onSite, onWorkspace, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** An item translations work on: an Entry, the Site's Globals, or a Form's emails. */
const item = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("entry"), id }),
	z.object({ kind: z.literal("globals") }),
	z.object({ kind: z.literal("formEmails"), id }),
]);

const language = z.string().trim().min(1).max(35);

/** A value's place, as Entries answer it: `title`, `fields.summary`, `fields.team[r1].role`, `seo.title`. */
const at = z.string().trim().min(1).max(500);

/** A Form's emails are changed with `formEmails.edit`; every other item's translations with `entry.edit`. */
function editPermission(target: ItemRef) {
	return target.kind === "formEmails" ? ("formEmails.edit" as const) : ("entry.edit" as const);
}

/**
 * AI translation of a Site (GLOSSARY.md › Translation mode): each language's mode, Translate now, the
 * Review queue (AI translations waiting in the Draft, and Outdated translations), approving,
 * confirming and translating values again. Modes and Translate now are Site settings for Staff and
 * Owners (`translation.manage`), saved at once and logged; only they see what AI costs.
 */
export const translations = {
	/** Each language's mode and progress (to review, Outdated, missing, waiting work), the AI key, and this month's usage. */
	overview: signedIn
		.input(z.object({ siteId: id }))
		.use(onSite("site.view"))
		.handler(({ context }) => {
			const { site } = context;
			const costs = can(context.access.actor, "aiUsage.view", {
				level: "site",
				workspaceId: site.workspace.id,
				siteId: site.site.id,
			});
			return context.services.translations.overview(site, { costs });
		}),

	/** Sets a language's Translation mode: `automatic`, `review` or `manual`. */
	setMode: signedIn
		.input(z.object({ siteId: id, language, mode: z.enum(TRANSLATION_MODES) }))
		.use(onSite("translation.manage"))
		.handler(async ({ context, input }) => {
			await context.services.translations.setMode(context.site, input.language, input.mode);
			return context.services.translations.overview(context.site, { costs: true });
		}),

	/**
	 * Translate now: queues AI translation of every Entry, the Globals and every Form's emails into the
	 * Automatic and Review languages (or the one given), for the worker. Automatic languages get their
	 * published values translated and published; Review languages their Drafts.
	 */
	translateNow: signedIn
		.input(z.object({ siteId: id, language: language.optional() }))
		.use(onSite("translation.manage"))
		.handler(({ context, input }) => context.services.translations.translateNow(context.site, input.language)),

	/** The Review queue: AI translations waiting for a person to publish, and Outdated translations. */
	queue: signedIn
		.input(z.object({ siteId: id, language: language.optional() }))
		.use(onSite("entry.edit"))
		.handler(async ({ context, input }) => ({
			lines: await context.services.translations.queue(context.site, { language: input.language }),
		})),

	/** Approves (publishes) the AI's translations waiting in the Draft, in one language: of some items, or all. */
	approve: signedIn
		.input(z.object({ siteId: id, language, items: z.array(item).max(500).optional() }))
		.use(onSite("entry.publish"))
		.handler(({ context, input }) =>
			context.services.translations.approve(context.site, { language: input.language, items: input.items }),
		),

	/** Confirms a person's translation is right for its source as it is now: it is no longer Outdated. */
	confirm: signedIn
		.input(z.object({ siteId: id, item, language, at, block: z.string().max(64).nullable().optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, editPermission(input.item));
			await context.services.translations.confirm(site, input);
			return { confirmed: true };
		}),

	/** Translates one value (or one Block of a body) again with AI, into the Draft, replacing whoever wrote it. */
	retranslate: signedIn
		.input(z.object({ siteId: id, item, language, at, block: z.string().max(64).nullable().optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, editPermission(input.item));
			await context.services.translations.retranslate(site, input);
			return { retranslated: true };
		}),
};

const newTerm = z.object({ term: z.string().max(PROTECTED_TERM_LIMITS.length), matchCase: z.boolean() });

/**
 * Protected terms (GLOSSARY.md): words AI translation leaves exactly as written. A Workspace's apply
 * to all its Sites; a Site's to that Site. Staff, Owners and Editors change them
 * (`protectedTerms.edit`), on the Workspace or on the Site.
 */
export const protectedTerms = {
	/** The Workspace's terms and those of the Sites the person sees (with `siteId`, only those that apply there). */
	list: signedIn
		.input(z.object({ workspaceId: id, siteId: id.optional() }))
		.use(onWorkspace("workspace.view"))
		.handler(async ({ context, input }) => {
			const { services, workspace } = context;
			let siteIds: string[];
			if (input.siteId) {
				const site = await services.data.site(context.access, input.siteId, "site.view");
				if (site.workspace.id !== workspace.workspace.id) throw new SiteNotFoundError();
				siteIds = [site.site.id];
			} else {
				siteIds = (await services.sites.list(workspace)).map((site) => site.id);
			}
			return { terms: await services.translations.terms.list(workspace, siteIds) };
		}),

	/** Adds terms to the Workspace's list (`siteId` null) or a Site's; a term already there is skipped. */
	add: signedIn
		.input(
			z.object({
				workspaceId: id,
				siteId: id.nullable(),
				terms: z.array(newTerm).min(1).max(PROTECTED_TERM_LIMITS.count),
			}),
		)
		.handler(async ({ context, input }) => {
			const { services } = context;
			if (input.siteId) {
				const site = await services.data.site(context.access, input.siteId, "protectedTerms.edit");
				if (site.workspace.id !== input.workspaceId) throw new SiteNotFoundError();
			}
			const workspace = await services.data.workspace(
				context.access,
				input.workspaceId,
				input.siteId ? "workspace.view" : "protectedTerms.edit",
			);
			return { added: await services.translations.terms.add(workspace, input.siteId, input.terms) };
		}),

	/** Removes a term, from the Workspace's list or a Site's. */
	remove: signedIn
		.input(z.object({ workspaceId: id, termId: id }))
		.use(onWorkspace("workspace.view"))
		.handler(async ({ context, input }) => {
			const { services, workspace } = context;
			const term = await services.translations.terms.find(workspace, input.termId);
			if (term.siteId) await services.data.site(context.access, term.siteId, "protectedTerms.edit");
			else await services.data.workspace(context.access, input.workspaceId, "protectedTerms.edit");
			await services.translations.terms.remove(workspace, term.id);
			return { removed: true };
		}),
};
