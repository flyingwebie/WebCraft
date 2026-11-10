import { os } from "@orpc/server";
import {
	type Access,
	AI_TEXT_LIMITS,
	installBranding,
	MAX_RECIPIENTS,
	MAX_SERVICES,
	type OpenedDashboardPlace,
	openPlace,
	type Permission,
	REPORT_LANGUAGES,
	REPORT_SCHEDULES,
	SHARE_LINK_PASSWORD,
	saveServicesList,
	servicesList,
	siteBranding,
	updateInstallBranding,
	updateSiteBranding,
	updateWorkspaceBranding,
	workspaceBranding,
} from "@webcraft/core";
import { z } from "zod";

import { type ApiContext, onInstall, onSite, onWorkspace, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";
import { place, placeOf } from "./dashboards.ts";
import { languageOf } from "./modules.ts";

/**
 * Reports (spec stories 132 and 135, #104): a Dashboard (a Site's, or a Workspace's adding up its
 * Sites) sent as a PDF on a schedule, each period compared with the one before, to its recipients,
 * in its language, with AI text built from totals only. Staff set them up (`report.manage`); Staff and
 * Owners see them and their history (`report.view`) and change who they go to (`reportRecipients.edit`:
 * Content, as Form emails' recipients are). A Workspace Dashboard's add up every Site of the
 * Workspace, so only someone who sees each Site opens them.
 */

const name = z.string().trim().min(1).max(100);
const recipients = z.array(z.string().max(320)).max(MAX_RECIPIENTS * 2);
const reportFields = {
	name,
	/** `weekly`: each Monday, for the week before; `monthly`: on the 1st, for the month before (06:00 UTC). */
	schedule: z.enum(REPORT_SCHEDULES),
	/** The language of its words and AI text. */
	language: z.enum(REPORT_LANGUAGES),
	recipients,
	/** Whether each one waits for someone to review its AI text before it goes out. */
	review: z.boolean(),
	/** Whether it goes out on its schedule. */
	active: z.boolean(),
};

/** A Report's AI text as a person edits it before approving it. */
const aiText = z.object({
	widgets: z.record(z.uuid(), z.string().max(AI_TEXT_LIMITS.widget * 2)),
	whatHappened: z.string().max(AI_TEXT_LIMITS.whatHappened * 2),
	suggestions: z
		.array(z.object({ text: z.string().max(AI_TEXT_LIMITS.suggestion * 2), service: z.string().max(100).nullable() }))
		.max(AI_TEXT_LIMITS.suggestions),
});

export const reports = {
	/** The Reports of a Dashboard. */
	list: signedIn.input(z.object({ ...place, dashboardId: id })).handler(async ({ context, input }) => ({
		reports: await context.services.reports.list(context.access, placeOf(input), input.dashboardId),
	})),

	/** Sets up a Report of a Dashboard. */
	create: signedIn
		.input(z.object({ ...place, dashboardId: id, ...reportFields }))
		.handler(async ({ context, input }) => ({
			report: await context.services.reports.create(context.access, placeOf(input), input.dashboardId, input),
		})),

	/** Changes a Report: its name, schedule, language, recipients, review and whether it goes out. */
	update: signedIn
		.input(
			z.object({
				...place,
				reportId: id,
				name: name.optional(),
				schedule: reportFields.schedule.optional(),
				language: reportFields.language.optional(),
				recipients: recipients.optional(),
				review: z.boolean().optional(),
				active: z.boolean().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const { siteId: _site, workspaceId: _workspace, reportId, ...change } = input;
			return { report: await context.services.reports.update(context.access, placeOf(input), reportId, change) };
		}),

	/** Changes who a Report goes to (Content: Owners may). */
	setRecipients: signedIn
		.input(z.object({ ...place, reportId: id, recipients }))
		.handler(async ({ context, input }) => ({
			report: await context.services.reports.setRecipients(
				context.access,
				placeOf(input),
				input.reportId,
				input.recipients,
			),
		})),

	/** Deletes a Report and its history. */
	delete: signedIn.input(z.object({ ...place, reportId: id })).handler(async ({ context, input }) => {
		await context.services.reports.delete(context.access, placeOf(input), input.reportId);
		return { deleted: true as const };
	}),

	/** Makes the Report now, for its last whole period, and sends it to the caller alone. */
	sendTest: signedIn.input(z.object({ ...place, reportId: id })).handler(async ({ context, input }) => ({
		send: await context.services.reports.sendTest(context.access, placeOf(input), input.reportId),
	})),

	/** A Report's history, newest first: each one made, its state, its recipients' emails and its PDF's size. */
	history: signedIn
		.input(
			z.object({
				...place,
				reportId: id,
				limit: z.number().int().min(1).max(50).optional(),
				before: z.coerce.date().optional(),
			}),
		)
		.handler(async ({ context, input }) => ({
			sends: await context.services.reports.history(context.access, placeOf(input), input.reportId, {
				limit: input.limit,
				before: input.before,
			}),
		})),

	sends: {
		/** One entry of a history, with its Widgets and its AI text (for review). */
		get: signedIn.input(z.object({ ...place, sendId: id })).handler(async ({ context, input }) => ({
			send: await context.services.reports.send(context.access, placeOf(input), input.sendId),
		})),

		/** An entry's PDF, base64, while it is kept. */
		pdf: signedIn
			.input(z.object({ ...place, sendId: id }))
			.handler(
				async ({ context, input }) => await context.services.reports.pdf(context.access, placeOf(input), input.sendId),
			),

		/** Changes the AI text of a Report waiting for review: plain text, kept within its limits. */
		editText: signedIn.input(z.object({ ...place, sendId: id, text: aiText })).handler(async ({ context, input }) => ({
			send: await context.services.reports.editText(context.access, placeOf(input), input.sendId, input.text),
		})),

		/** Sends a Report waiting for review, with its AI text as it is now. */
		approve: signedIn.input(z.object({ ...place, sendId: id })).handler(async ({ context, input }) => ({
			send: await context.services.reports.approve(context.access, placeOf(input), input.sendId),
		})),

		/** Drops a Report waiting for review: it never goes out. */
		discard: signedIn.input(z.object({ ...place, sendId: id })).handler(async ({ context, input }) => ({
			send: await context.services.reports.discard(context.access, placeOf(input), input.sendId),
		})),

		/** Sends a Report again to its recipients now, or makes its PDF again when that failed. */
		resend: signedIn.input(z.object({ ...place, sendId: id })).handler(async ({ context, input }) => ({
			send: await context.services.reports.resend(context.access, placeOf(input), input.sendId),
		})),
	},
};

const password = z.string().max(SHARE_LINK_PASSWORD.max * 4);

/**
 * Checks a Permission on the Dashboard's place (its Site, or its Workspace: every Site of it) before
 * what follows, such as a Sensitive action's check, so nobody confirms something they may not do.
 * Keeps the opened place on `context.place` (as `onSite`/`onWorkspace` keep `context.site`/
 * `context.workspace`), so a handler that needs it again (such as `shareLinks.create` and `.update`,
 * a Sensitive action) passes it on instead of opening the same place with the same Permission twice.
 */
function onPlace(permission: Permission) {
	return os
		.$context<ApiContext & { access: Access }>()
		.middleware(async ({ context, next }, input: { siteId?: string; workspaceId?: string }) => {
			const place: OpenedDashboardPlace = await openPlace(
				context.services.data,
				context.access,
				placeOf(input),
				permission,
			);
			return next({ context: { place } });
		});
}

/**
 * Share links (#104): someone without an account explores a Dashboard through a link served under
 * the sites domain, with an optional password and expiry. Staff make, change and revoke them
 * (`shareLink.manage`); making one, or changing its password or expiry, is a Sensitive action
 * (`shareLink.change`), never an API client's. Staff and Owners see them and how often each was opened
 * (`shareLink.view`).
 */
export const shareLinks = {
	/** A Dashboard's Share links, with how often each was opened and when last (never by whom). */
	list: signedIn.input(z.object({ ...place, dashboardId: id })).handler(async ({ context, input }) => ({
		links: await context.services.shareLinks.list(context.access, placeOf(input), input.dashboardId),
	})),

	/** Makes a Share link: its address is answered once, never again. */
	create: signedIn
		.input(
			z.object({
				...place,
				dashboardId: id,
				name,
				language: z.enum(REPORT_LANGUAGES).optional(),
				password: password.nullable().optional(),
				expiresAt: z.coerce.date().nullable().optional(),
			}),
		)
		.use(onPlace("shareLink.manage"))
		.use(sensitive("shareLink.change"))
		.handler(async ({ context, input }) => {
			const language = input.language ?? (await languageOf(context.services, context.person));
			return await context.services.shareLinks.create(context.place, input.dashboardId, {
				name: input.name,
				language,
				password: input.password ?? null,
				expiresAt: input.expiresAt ?? null,
			});
		}),

	/** Changes a Share link's name, language, password (null removes it) or expiry (null: none). */
	update: signedIn
		.input(
			z.object({
				...place,
				shareLinkId: id,
				name: name.optional(),
				language: z.enum(REPORT_LANGUAGES).optional(),
				password: password.nullable().optional(),
				expiresAt: z.coerce.date().nullable().optional(),
			}),
		)
		.use(onPlace("shareLink.manage"))
		.use(sensitive("shareLink.change"))
		.handler(async ({ context, input }) => ({
			link: await context.services.shareLinks.update(context.place, input.shareLinkId, {
				name: input.name,
				language: input.language,
				password: input.password,
				expiresAt: input.expiresAt,
			}),
		})),

	/** Revokes a Share link: it stops working at once. */
	revoke: signedIn.input(z.object({ ...place, shareLinkId: id })).handler(async ({ context, input }) => ({
		link: await context.services.shareLinks.revoke(context.access, placeOf(input), input.shareLinkId),
	})),
};

/** A logo: PNG, JPEG or WebP, base64, at most 256 KB; null removes it. */
const logo = z
	.object({ contentType: z.string().max(40), data: z.string().max(360_000) })
	.nullable()
	.optional();
const brandName = z.string().max(200).nullable().optional();
const colour = z.string().max(20).nullable().optional();

/**
 * How Reports and Share links are branded (spec story 133): the agency brand (the Superadmin's for the
 * Install, `install.manage`; a Workspace's own in its place), the client brand (the Site's, else the
 * Workspace's) and "Made with WebCraft", each switched on or off. Staff change a Workspace's and a
 * Site's (`reportBranding.manage`). Apart from Install branding, which brands System emails.
 */
export const reportBranding = {
	install: {
		get: onInstall("install.manage").handler(async ({ context }) => ({
			branding: await installBranding(context.install),
		})),
		update: onInstall("install.manage")
			.input(
				z.object({
					name: brandName,
					accentColour: colour,
					logo,
					showAgency: z.boolean().optional(),
					showClient: z.boolean().optional(),
					madeWith: z.boolean().optional(),
				}),
			)
			.handler(async ({ context, input }) => ({ branding: await updateInstallBranding(context.install, input) })),
	},
	workspace: {
		get: signedIn
			.input(z.object({ workspaceId: id }))
			.use(onWorkspace("reportBranding.manage"))
			.handler(async ({ context }) => ({ branding: await workspaceBranding(context.workspace) })),
		update: signedIn
			.input(
				z.object({
					workspaceId: id,
					ownAgency: z.boolean().optional(),
					agency: z.object({ name: brandName, accentColour: colour, logo }).optional(),
					client: z.object({ name: brandName, logo }).optional(),
					showAgency: z.boolean().nullable().optional(),
					showClient: z.boolean().nullable().optional(),
					madeWith: z.boolean().nullable().optional(),
				}),
			)
			.use(onWorkspace("reportBranding.manage"))
			.handler(async ({ context, input }) => {
				const { workspaceId: _workspace, ...change } = input;
				return { branding: await updateWorkspaceBranding(context.workspace, change) };
			}),
	},
	site: {
		get: signedIn
			.input(z.object({ siteId: id }))
			.use(onSite("reportBranding.manage"))
			.handler(async ({ context }) => ({ branding: await siteBranding(context.site) })),
		update: signedIn
			.input(z.object({ siteId: id, client: z.object({ name: brandName, logo }) }))
			.use(onSite("reportBranding.manage"))
			.handler(async ({ context, input }) => ({
				branding: await updateSiteBranding(context.site, { client: input.client }),
			})),
	},
};

/**
 * The Services list (GLOSSARY.md): the agency's services, written by Staff once for the Install
 * (`servicesList.edit`), which Reports' suggestions may point to.
 */
export const servicesListProcedures = {
	get: onInstall("servicesList.edit").handler(async ({ context }) => ({
		services: await servicesList(context.install.db),
	})),
	update: onInstall("servicesList.edit")
		.input(
			z.object({
				services: z
					.array(
						z.object({
							id: z.string().max(100).optional(),
							name: z.string().max(200),
							description: z.string().max(1000).optional(),
						}),
					)
					.max(MAX_SERVICES * 2),
			}),
		)
		.handler(async ({ context, input }) => ({
			services: await saveServicesList(context.install, input.services),
		})),
};
