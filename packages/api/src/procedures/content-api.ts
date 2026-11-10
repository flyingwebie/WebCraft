import { CONTENT_KEY_LIMITS } from "@webcraft/core";
import { z } from "zod";

import { onSite, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A Content key's name as typed; the server checks it (`CONTENT_API_INVALID`). */
const name = z.string().max(CONTENT_KEY_LIMITS.name * 2);

/** A key's origins as typed (`https://shop.example.com`); the server checks each (`CONTENT_API_INVALID`). */
const origins = z
	.array(z.string().max(300))
	.max(CONTENT_KEY_LIMITS.origins * 2)
	.optional();

/** Field paths (`summary`, `address.city`), as typed. */
const paths = z.array(z.string().max(300)).max(1_000);

/**
 * A Site's Content API (ADR 0029, GLOSSARY.md › Content API): the read-only API frontends built
 * elsewhere call on the Site's domains at `/_content/v1/…`. Site settings, Staff only
 * (`structure.edit`): the switch (off by default), the Post Types and Fields it hides, and its
 * Content keys. Each change applies at once and is recorded in the Audit log. Making a key isn't a
 * Sensitive action: a key reads published content only, which the Site shows its visitors anyway.
 */
export const contentApi = {
	/**
	 * Whether the Content API is on, what it hides (Post Type ids, Field paths by Post Type id, the
	 * Globals' Field paths), its Content keys (never the keys themselves: a hint, origins, status and
	 * use per day) and where frontends call it.
	 */
	get: signedIn
		.input(z.object({ siteId: id }))
		.use(onSite("structure.edit"))
		.handler(async ({ context }) => await context.services.contentApi.get(context.site)),

	/**
	 * Switches the Content API on or off, and replaces each list of what it hides that is given:
	 * `hidden.postTypes` (Post Type ids), `hidden.fields` (by Post Type id, its Fields' paths, such as
	 * `summary` or `address.city`) and `hidden.globals` (the Globals' Field paths). Refused with
	 * `CONTENT_API_INVALID`, each problem at its place.
	 */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				enabled: z.boolean().optional(),
				hidden: z
					.object({
						postTypes: z.array(id).max(1_000).optional(),
						fields: z.record(z.string().max(100), paths).optional(),
						globals: paths.optional(),
					})
					.optional(),
			}),
		)
		.use(onSite("structure.edit"))
		.handler(async ({ context, input }) => {
			const { siteId: _, ...change } = input;
			return await context.services.contentApi.update(context.site, change);
		}),

	keys: {
		/**
		 * Makes a Content key with a name and the origins browsers on other sites may send it from
		 * (exact origins such as `https://shop.example.com`; none by default: servers only). Answers
		 * the key itself (`secret`) this once: it is never shown again.
		 */
		create: signedIn
			.input(z.object({ siteId: id, name, origins }))
			.use(onSite("structure.edit"))
			.handler(
				async ({ context, input }) =>
					await context.services.contentApi.createKey(context.site, { name: input.name, origins: input.origins }),
			),

		/** Renames a Content key or replaces its origins, at once. */
		update: signedIn
			.input(z.object({ siteId: id, keyId: id, name: name.optional(), origins }))
			.use(onSite("structure.edit"))
			.handler(async ({ context, input }) => ({
				key: await context.services.contentApi.updateKey(context.site, input.keyId, {
					name: input.name,
					origins: input.origins,
				}),
			})),

		/** Revokes a Content key at once: requests sending it are refused (`CONTENT_KEY_INVALID`, `revoked`) from now on. */
		revoke: signedIn
			.input(z.object({ siteId: id, keyId: id }))
			.use(onSite("structure.edit"))
			.handler(async ({ context, input }) => ({
				key: await context.services.contentApi.revokeKey(context.site, input.keyId),
			})),
	},
};
