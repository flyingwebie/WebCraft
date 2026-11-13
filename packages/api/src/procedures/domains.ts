import { CDN_KEYS, CDN_SECRET_HEADER } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** The CDN secret's header as people write it. */
const CDN_SECRET_HEADER_NAME = CDN_SECRET_HEADER.replace(/(^|-)([a-z]+)/g, (_match, dash: string, word: string) =>
	word === "cdn" ? `${dash}CDN` : `${dash}${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
);

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
	 * the Site's Staging address (`stagingUrl`, null without a sites domain); and the CDN in front of
	 * the Site (`cdn`, null for none; see `setCdn`) with whether the Site has a CDN secret (`cdnSecret`;
	 * see `newCdnSecret`).
	 */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return {
			...(await context.services.domains.list(site)),
			stagingUrl: context.services.sites.stagingUrl(site.site),
			cdn: await context.services.cdns.siteCdn(site),
			cdnSecret: await context.services.cdns.siteHasCdnSecret(site),
		};
	}),

	/**
	 * Sets the CDN in front of the Site (`cloudflare`, `fastly`; null for none). With one set, a visitor
	 * request that comes from the CDN's published address ranges and carries the Site's CDN secret (see
	 * `newCdnSecret`) counts as coming from the visitor the CDN names in its own header
	 * (`CF-Connecting-IP`, `Fastly-Client-IP`), so rate limits keep counting visitors. Applies at once;
	 * logged `cdn.change`. A change forgets the Site's CDN secret. Answers the Site's CDN.
	 */
	setCdn: signedIn
		.input(z.object({ siteId: id, cdn: z.enum(CDN_KEYS).nullable() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { cdn: await context.services.cdns.setSiteCdn(site, input.cdn) };
		}),

	/**
	 * Makes the Site's CDN secret, in place of any it had, and answers it with the request header to
	 * send it in (`header`): the only time it is shown. Staff add that header, with the secret, to every
	 * request their service at the CDN sends on to the Site; until a request carries it, the CDN's
	 * servers count as the client, whatever visitor the CDN's header names (the CDN's address ranges are
	 * every customer's). Logged `cdnSecret.change`. `CDN_NOT_SET` for a Site without a CDN.
	 */
	newCdnSecret: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { secret: await context.services.cdns.newSiteCdnSecret(site), header: CDN_SECRET_HEADER_NAME };
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

	/**
	 * The Site's Paused domains: those a Site import brought (ADR 0033), which serve nothing until Staff
	 * switch them on (Site settings, `structure.edit`).
	 */
	paused: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { paused: await context.services.domains.paused(site) };
	}),

	/**
	 * Switches a Paused domain on: a language's becomes that language's domain again, any other is added
	 * (the Primary domain when the Site has none); it then waits for DNS and is verified like any domain.
	 * `DOMAIN_TAKEN` while another Site of the Install has it. Logged `domain.add`.
	 */
	switchOnPaused: signedIn.input(z.object({ siteId: id, pausedId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		await context.services.domains.switchOnPaused(site, input.pausedId);
		return { ...(await context.services.domains.list(site)), paused: await context.services.domains.paused(site) };
	}),

	/** Forgets a Paused domain the Site won't use here. Logged `pausedDomain.discard`. */
	discardPaused: signedIn.input(z.object({ siteId: id, pausedId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		await context.services.domains.discardPaused(site, input.pausedId);
		return { paused: await context.services.domains.paused(site) };
	}),
};
