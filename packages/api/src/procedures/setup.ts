import { SITE_NAME_MAX_LENGTH, WORKSPACE_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { authEndpoint, onInstall, procedure, setCookies } from "../context.ts";
import { adminLanguage, email, password, personName } from "../inputs.ts";

const token = z.string().max(512);

/** The setup wizard: claiming a fresh Install with the setup token printed in the web log. */
export const setup = {
	/** Where the Install is in its setup: `claim`, `continue` or `done`. */
	state: procedure.handler(async ({ context }) => ({ stage: await context.services.setup.stage() })),

	/** Checks a setup token before the wizard asks for the account, without using it up. */
	checkToken: authEndpoint.input(z.object({ token })).handler(async ({ context, input }) => {
		await context.services.setup.checkToken(input.token.trim());
		return { ok: true as const };
	}),

	/** Claims the Install with the setup token: creates the Superadmin and signs them in. */
	claim: authEndpoint
		.input(z.object({ token, name: personName, email, password, adminLanguage }))
		.handler(async ({ context, input }) => {
			const { services } = context;
			const { token: setupToken, ...account } = input;
			const { personId } = await services.setup.claim(setupToken.trim(), account, context.via);
			const { setCookie } = await services.auth.signIn({ email: account.email, password: account.password }, context);
			setCookies(context, setCookie);
			return { personId };
		}),

	/**
	 * The Superadmin has been through the wizard's remaining steps: setup is finished for good. The
	 * last step, the first client, may also create the Install's first Workspace and, in it, its
	 * first Site, as `workspaces.create` and `sites.create` do (same rules, Permissions and Audit log
	 * entries). All of it is saved together or not at all: when any part is refused, nothing is
	 * created and setup stays open. Without `workspace` (the step skipped) it only finishes setup.
	 */
	finish: onInstall("install.manage")
		.input(
			z
				.object({
					workspace: z
						.object({
							name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
							site: z
								.object({ name: z.string().trim().min(1).max(SITE_NAME_MAX_LENGTH), slug: z.string().max(100) })
								.optional(),
						})
						.optional(),
				})
				.optional(),
		)
		.handler(async ({ context, input }) => {
			const { services } = context;
			const asked = input?.workspace;
			const opened = asked ? await services.data.install(context.access, "workspace.create") : context.install;
			const created = await opened.transaction(async (install) => {
				await services.setup.finish(context.person.id, install.db);
				if (!asked) return { workspace: null, site: null };
				const workspace = await services.workspaces.create(install, { name: asked.name });
				const site = asked.site
					? await services.sites.create(await install.workspace(workspace.id, "site.create"), asked.site)
					: null;
				return { workspace, site };
			});
			services.log.info("The Superadmin finished the setup wizard", {
				personId: context.person.id,
				workspaceId: created.workspace?.id,
				siteId: created.site?.id,
			});
			return { stage: await services.setup.stage(), ...created };
		}),
};
