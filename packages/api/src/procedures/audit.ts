import { AUDIT_VIA_KINDS } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * What to read: one Workspace's entries (Staff and Owners, and the Superadmin) or, without
 * `workspaceId`, the whole Install's (the Superadmin); then who, what, how, which Site and when.
 * `from` is included, `to` isn't.
 */
const filters = {
	workspaceId: id.optional(),
	personId: id.optional(),
	action: z.string().trim().min(1).max(200).optional(),
	via: z.enum(AUDIT_VIA_KINDS).optional(),
	siteId: id.optional(),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
};

/** The `next` of the page before. */
const after = z.string().regex(/^\d{1,18}$/);

/**
 * The Audit log: read at each level, never changed. No procedure writes, changes or deletes an
 * entry; old ones go only by the Install's retention (`install.security.setAuditRetention`).
 */
export const audit = {
	/**
	 * A page of entries, newest first, with the names of the people, Workspaces and Sites they
	 * mention; `next` reads the page after it. An Owner reaching some Sites reads only the
	 * Workspace's own entries and those Sites'.
	 */
	list: signedIn
		.input(
			z
				.object({ ...filters, after: after.optional(), limit: z.number().int().min(1).max(200).default(50) })
				.default({ limit: 50 }),
		)
		.handler(({ context, input }) => context.services.audit.list(context.access, input)),

	/**
	 * The entries `list` reads with the same filters, as a CSV file: UTF-8 with a BOM, formulas made
	 * text, the newest 50,000 (`truncated` when there were more).
	 */
	export: signedIn
		.input(z.object(filters))
		.handler(({ context, input }) => context.services.audit.export(context.access, input)),
};
