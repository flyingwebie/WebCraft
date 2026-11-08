import { permissionsOn, SITE_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";
import { languageOf } from "./modules.ts";

/** Sites: the websites of a Workspace. */
export const sites = {
	/** The Sites of a Workspace the person can see. */
	list: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "workspace.view");
		return { sites: await context.services.sites.list(workspace) };
	}),

	/**
	 * One Site, its Workspace, the Permissions the person holds on it (the admin shows what they may
	 * do), its Staging address (null when the Install has no sites domain), and the admin pages of the
	 * Modules running on it that the person may open.
	 */
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.site(context.access, input.siteId, "site.view");
		const { site, workspace } = scope;
		const permissions = permissionsOn(context.access.actor, {
			level: "site",
			workspaceId: workspace.id,
			siteId: site.id,
		});
		return {
			site,
			workspace: { id: workspace.id, name: workspace.name },
			permissions,
			stagingUrl: context.services.sites.stagingUrl(site),
			modulePages: await context.services.modules.pages(scope, await languageOf(context.services, context.person)),
		};
	}),

	/** Creates a Site in a Workspace. Its slug is unique on the Install: the Staging address is `<slug>.<sites domain>`. */
	create: signedIn
		.input(
			z.object({
				workspaceId: id,
				name: z.string().trim().min(1).max(SITE_NAME_MAX_LENGTH),
				slug: z.string().max(100),
			}),
		)
		.handler(async ({ context, input }) => {
			const workspace = await context.services.data.workspace(context.access, input.workspaceId, "site.create");
			return { site: await context.services.sites.create(workspace, input) };
		}),
};
