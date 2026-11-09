import type { InstallServices, Person } from "@webcraft/core";
import { z } from "zod";

import { onInstall, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

const moduleId = z.string().min(1).max(64);
const version = z.string().min(1).max(64);
const confirmation = z.string().max(100).optional();

/** The language a person reads the admin in: theirs, or the Install's default. */
export async function languageOf(services: InstallServices, person: Person): Promise<string> {
	return person.adminLanguage ?? (await services.settings.read()).defaultAdminLanguage;
}

/**
 * The Module host: the Superadmin approves Modules on the Install (what each asks for, shown on
 * the consent screen); Staff switch them on Sites and Workspaces, and remove their data.
 */
export const modules = {
	/** Every Module of this build: its version, status, what it asks for and what it adds. */
	list: onInstall("module.approve").handler(async ({ context }) => ({
		modules: await context.services.modules.list(context.install, await languageOf(context.services, context.person)),
	})),

	/**
	 * Approves everything a Module asks for, for the version the consent screen showed: it runs
	 * wherever it is on. A Sensitive action. Refused with `MODULE_CHANGED` when the Install now runs
	 * another version, and `MODULE_CANNOT_RUN` for a Module that breaks a rule of the SDK.
	 */
	approve: onInstall("module.approve")
		.use(sensitive("module.approve"))
		.input(z.object({ moduleId, version }))
		.handler(async ({ context, input }) => {
			await context.services.modules.approve(context.install, input.moduleId, input.version);
			return { approved: true as const };
		}),

	/** Withdraws a Module's approval: it stops everywhere, keeping its data, until approved again. */
	withdraw: onInstall("module.approve")
		.input(z.object({ moduleId }))
		.handler(async ({ context, input }) => {
			await context.services.modules.withdraw(context.install, input.moduleId);
			return { withdrawn: true as const };
		}),

	/** A Module's newest Module log lines, newest first. */
	log: onInstall("module.approve")
		.input(z.object({ moduleId, limit: z.number().int().min(1).max(200).default(50) }))
		.handler(async ({ context, input }) => ({
			lines: await context.services.modules.log(context.install, input.moduleId, { limit: input.limit }),
		})),

	/** The Site-level Modules of a Site: Staff's switch for each, and whether it is approved. */
	siteList: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "module.manage");
		return {
			modules: await context.services.modules.placeList(site, await languageOf(context.services, context.person)),
		};
	}),

	/** The Workspace-level Modules of a Workspace. */
	workspaceList: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "module.manage");
		return {
			modules: await context.services.modules.placeList(workspace, await languageOf(context.services, context.person)),
		};
	}),

	/** Switches a Site-level Module on or off on a Site. Off keeps its data. */
	setOnSite: signedIn.input(z.object({ siteId: id, moduleId, on: z.boolean() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "module.manage");
		const language = await languageOf(context.services, context.person);
		return { module: await context.services.modules.setOn(site, input.moduleId, input.on, language) };
	}),

	/** Switches a Workspace-level Module on or off on a Workspace. Off keeps its data. */
	setOnWorkspace: signedIn
		.input(z.object({ workspaceId: id, moduleId, on: z.boolean() }))
		.handler(async ({ context, input }) => {
			const workspace = await context.services.data.workspace(context.access, input.workspaceId, "module.manage");
			const language = await languageOf(context.services, context.person);
			return { module: await context.services.modules.setOn(workspace, input.moduleId, input.on, language) };
		}),

	/**
	 * Removes a Site-level Module's data from a Site, in two steps. The first call deletes nothing: it
	 * answers how many rows of each of its tables, and how many of its secrets, would go, and a
	 * `confirmation` id valid for 5 minutes. Calling again with the id deletes them and switches the
	 * Module off there.
	 */
	removeSiteData: signedIn
		.input(z.object({ siteId: id, moduleId, confirmation }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "module.manage");
			return context.services.modules.removeData(site, input.moduleId, input.confirmation);
		}),

	/** Removes a Workspace-level Module's data from a Workspace, in the same two steps. */
	removeWorkspaceData: signedIn
		.input(z.object({ workspaceId: id, moduleId, confirmation }))
		.handler(async ({ context, input }) => {
			const workspace = await context.services.data.workspace(context.access, input.workspaceId, "module.manage");
			return context.services.modules.removeData(workspace, input.moduleId, input.confirmation);
		}),
};
