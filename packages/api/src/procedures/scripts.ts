import { publishPermission, SCRIPT_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { basedOn, id } from "../inputs.ts";

/**
 * The Site script and page scripts (ADR 0016): JavaScript Staff write in Code mode, Structure with a
 * Draft and a published version. Each runs as a file named by its hash on the Site's domain, never
 * inline (ADR 0023): the Site script on every page, a page script on its Entry's page.
 */
export const scripts = {
	/** The Site script (`entryId` null) or an Entry's page script; null while there is none. */
	get: signedIn.input(z.object({ siteId: id, entryId: id.nullable() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { script: await context.services.scripts.get(site, input.entryId) };
	}),

	/**
	 * Saves the Draft of the Site script (`entryId` null) or of an Entry's page script, making it the
	 * first time. Answers the script and its Draft's version; with `basedOn`, refused with
	 * `CHANGED_MEANWHILE` when someone saved it meanwhile. Visitors run nothing of it until it is published.
	 */
	saveDraft: signedIn
		.input(z.object({ siteId: id, entryId: id.nullable(), code: z.string().max(SCRIPT_MAX_LENGTH), basedOn }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const script = await context.services.scripts.saveDraft(site, input.entryId, input.code, {
				basedOn: input.basedOn,
			});
			return { script, version: script.version };
		}),

	/** Publishes a script's Draft: visitors run it from the next page they load, and the Site's page cache is cleared. */
	publish: signedIn.input(z.object({ siteId: id, scriptId: id })).handler(async ({ context, input }) => {
		const item = { kind: "script", id: input.scriptId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		const published = await context.services.publishing.publish(site, item);
		const script = await context.services.scripts.byId(site, input.scriptId);
		return { published, script };
	}),
};
