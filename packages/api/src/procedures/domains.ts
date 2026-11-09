import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A domain as typed; the server checks it and keeps it in lower case and its ASCII form. */
const name = z.string().max(300);

/**
 * A Site's domains (ADR 0015): its Primary domain, its Redirect domains (301 to the same path on the
 * Primary domain) and its languages' domains. Everyone who sees the Site sees them; Staff change them
 * (Site settings, `structure.edit`), and a change applies at once. A domain serves the Site only once
 * the Install has verified it reaches it.
 */
export const domains = {
	/**
	 * The Site's domains, the Primary domain first, then the Redirect domains, then the languages'
	 * domains, each with its status and the DNS records to create; the Install's `edge`, which decides
	 * the steps to take (on Coolify and Railway the domain is also added in the platform's panel); and
	 * the Site's Staging address (`stagingUrl`, null without a sites domain).
	 */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return {
			...(await context.services.domains.list(site)),
			stagingUrl: context.services.sites.stagingUrl(site.site),
		};
	}),

	/**
	 * Adds a domain, and with `withPartner` its `www` partner (or, for `www.…`, the bare domain) as a
	 * Redirect domain. The first domain of a Site without a Primary domain becomes it; the rest are
	 * Redirect domains. Each waits for DNS until verified, and is checked again by itself: every few
	 * minutes for an hour, hourly for 7 days, then when Staff ask (`check`). Answers what was added.
	 */
	add: signedIn
		.input(z.object({ siteId: id, name, withPartner: z.boolean().default(false) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { domains: await context.services.domains.add(site, input) };
		}),

	/**
	 * Checks a domain now: one waiting for DNS is verified when it reaches the Install (and is checked
	 * every few minutes again otherwise, as when it was added). Answers the domain as it is now.
	 */
	check: signedIn.input(z.object({ siteId: id, domainId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { domain: await context.services.domains.check(site, input.domainId) };
	}),

	/**
	 * Makes a verified domain the Primary domain. The Primary domain before it becomes a Redirect
	 * domain, so its links keep working.
	 */
	makePrimary: signedIn.input(z.object({ siteId: id, domainId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return await context.services.domains.makePrimary(site, input.domainId);
	}),

	/**
	 * Removes a domain, in two steps. The first call removes nothing: it answers what would go
	 * (`preview`: its name, role, and whether it serves visitors now) and a `confirmation` id, valid
	 * for 5 minutes; calling again with it removes the domain, which stops working at once. A
	 * language's domain is changed in Languages (`DOMAIN_CHANGE_REFUSED`).
	 */
	remove: signedIn
		.input(z.object({ siteId: id, domainId: id, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return await context.services.domains.remove(site, input.domainId, input.confirmation);
		}),
};
