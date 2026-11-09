// The Staging address as the people reviewing a Site use it: someone signed in to the admin opens it
// from there ("Staging" in the top bar), which hands their browser a single-use link to the Staging
// address; following it sets the Staging cookie there. People without an account give the Site's
// staging password on the page the Staging address shows them instead.
import { expect } from "bun:test";

import type { TestBrowser, TestInstall } from "./index.ts";

/** A browser looking at one Site's Staging address. */
export type StagingBrowser = {
	/** The Staging address's origin, such as `https://bakery.sites.test`. */
	origin: string;
	/** The browser itself, on the Staging address: it holds the Staging cookie. */
	browser: TestBrowser;
	/** Loads a path of the Staging address, with the browser's cookies. */
	page(path: string, init?: RequestInit): Promise<Response>;
};

/**
 * Opens a Site's Staging address for the person whose admin browser this is: asks for a link with
 * `staging.open` and follows it in a new browser on the Staging address.
 */
export async function openStaging(
	install: TestInstall,
	admin: TestBrowser,
	siteId: string,
	path = "/",
): Promise<StagingBrowser> {
	const { url } = await admin.api.staging.open({ siteId, path });
	const origin = new URL(url).origin;
	const browser = install.browser({ origin });
	const entered = await browser.request(url);
	expect(entered.status).toBe(303);
	return stagingBrowser(origin, browser);
}

/** A browser on the Staging address of the Site with this slug, holding no cookie yet. */
export function stagingVisitor(install: TestInstall, slug: string): StagingBrowser {
	const origin = `https://${slug}.sites.test`;
	return stagingBrowser(origin, install.browser({ origin }));
}

/**
 * Gives the Site's staging password on its Staging address, as its password page sends it: a form
 * post from the page itself. Answers the password page's answer.
 */
export async function givePassword(visitor: StagingBrowser, password: string, path = "/"): Promise<Response> {
	return visitor.browser.request(
		new Request(`${visitor.origin}/_webcraft/staging/password`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password, path }).toString(),
		}),
	);
}

function stagingBrowser(origin: string, browser: TestBrowser): StagingBrowser {
	return {
		origin,
		browser,
		page: (path, init) => browser.request(new Request(new URL(path, origin), init)),
	};
}

/** The domain test Sites go live on: `<slug>.live.test`. */
export const TEST_LIVE_DOMAIN = "live.test";

/**
 * Puts a Site live, as visitors find it: its Primary domain `<site slug>.live.test`, pointed at the
 * Install and verified at once (as "Check now" does). Answers its origin, `https://<slug>.live.test`,
 * where the Site shows what is published. Its Staging address shows its Drafts to the people
 * reviewing it instead (ADR 0014), so tests of what visitors see go here. Going live again answers
 * the same origin.
 */
export async function goLive(install: TestInstall, siteId: string): Promise<string> {
	const admin = await install.superadmin();
	const { site } = await admin.api.sites.get({ siteId });
	const name = `${site.slug}.${TEST_LIVE_DOMAIN}`;
	const origin = `https://${name}`;
	const listed = await admin.api.domains.list({ siteId });
	if (listed.domains.some((domain) => domain.name === name && domain.verifiedAt !== null)) return origin;
	install.connectDomain(name);
	const existing = listed.domains.find((domain) => domain.name === name);
	const domainId = existing?.id ?? (await admin.api.domains.add({ siteId, name })).domains[0]?.id;
	if (!domainId) throw new Error(`${name} wasn't added.`);
	const { domain } = await admin.api.domains.check({ siteId, domainId });
	if (domain.verifiedAt === null) throw new Error(`${name} wasn't verified: ${JSON.stringify(domain)}`);
	return origin;
}
