import { PermissionDeniedError, WEBCRAFT_VERSION, WorkspaceNotFoundError } from "@webcraft/core";

import { signedIn } from "../context.ts";

/** Who a call acts as. */
export const access = {
	/**
	 * Who the call acts as: its person, and for an API client (an API token, or a grant its person
	 * approved for an AI client or `webcraft login`) the client: its kind and name, its Workspace and
	 * the Sites it reaches, whether it only reads or may publish, and its Toolsets. With the Install's
	 * admin address and WebCraft version. In the admin, `client` is null.
	 */
	current: signedIn.handler(async ({ context }) => {
		const { services, person, client } = context;
		const install = { address: services.config.adminOrigin, version: WEBCRAFT_VERSION };
		const who = { id: person.id, name: person.name, email: person.email };
		const actor = client?.access.actor;
		if (!client || !actor || (actor.kind !== "token" && actor.kind !== "grant")) {
			return { person: who, install, client: null };
		}
		const workspace = await services.data
			.workspace(client.access, actor.workspaceId, "workspace.view")
			.catch((error: unknown) => {
				if (error instanceof WorkspaceNotFoundError || error instanceof PermissionDeniedError) return null;
				throw error;
			});
		// The Sites the client sees are those it reaches.
		const seen = workspace ? await services.sites.list(workspace) : [];
		return {
			person: who,
			install,
			client: {
				kind: client.client.kind === "token" ? ("apiToken" as const) : ("oauthGrant" as const),
				name: client.client.name,
				workspace: { id: actor.workspaceId, name: workspace?.workspace.name ?? null },
				sites: actor.sites === "all" ? ("all" as const) : seen.map((site) => ({ id: site.id, name: site.name })),
				readOnly: client.client.readOnly,
				mayPublish: client.client.mayPublish,
				toolsets: [...client.client.toolsets],
			},
		};
	}),
};
