import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** Edit mode (ADR 0022): opening a Site on its own domain to change its Content in place. */
export const editMode = {
	/**
	 * "Edit on site": a link that opens `path` (the home page unless given) on the Site's own
	 * address in Edit mode. It works once, within 60 seconds, for this person and this Site only;
	 * following it signs this browser into Edit mode there for at most 8 hours, tied to this admin
	 * session. Needs `entry.edit` on the Site; `EDIT_MODE_UNAVAILABLE` while the Site has no address.
	 */
	open: signedIn
		.input(z.object({ siteId: id, path: z.string().max(2000).default("/") }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return await context.services.editMode.openLink(site, { adminSessionId: context.session.id, path: input.path });
		}),
};
