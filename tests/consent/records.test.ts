// Consent records (ADR 0020, GLOSSARY.md): the proof of one visitor's choice on the Consent banner.
// The consent script posts the choice to `/_wc/consent` on the Site's own domain; the Site keeps a
// random id, the time, the choices, the banner version and the language, and nothing that
// identifies the visitor (no IP address), for 12 months. The answer sets the `webcraft.consent`
// cookie naming the record, which the consent script reads on the visitor's next pages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ipv6Network } from "../harness/addresses.ts";
import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let owner: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;
let addresses = 0;

async function newSite() {
	const slug = `records-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	await goLive(install, siteId);
	return { siteId, origin: `https://${slug}.live.test` };
}

type Choice = { choices?: unknown; version?: unknown; language?: unknown };

/** A visitor's browser posting a choice, as the consent script does: from the Site's own page, as JSON. */
function post(
	site: { origin: string },
	body: Choice | string = { choices: { analytics: true, marketing: false, media: true }, version: 1, language: "en" },
	options: { address?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<Response> {
	const request = new Request(`${site.origin}/_wc/consent`, {
		method: options.method ?? "POST",
		headers: {
			"content-type": "application/json",
			origin: site.origin,
			"sec-fetch-site": "same-origin",
			...options.headers,
		},
		body: options.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
	});
	return install.request(fromAddress(request, options.address ?? `198.51.100.${++addresses % 250}`));
}

describe("recording a visitor's choice", () => {
	test("keeps a random id, the time, the choices, the banner version and the language; the answer's cookie names it", async () => {
		const site = await newSite();
		const now = install.clock.now();

		const answer = await post(site);

		expect(answer.status).toBe(201);
		expectSiteHeaders(answer);
		expect(answer.headers.get("cache-control")).toBe("no-store");
		const { id } = (await answer.json()) as { id: string };
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		// Read by the consent script on the next pages, so not HttpOnly; kept six months.
		expect(answer.headers.get("set-cookie")).toBe(
			`__Host-webcraft.consent=${id}.1.101; Path=/; Max-Age=15552000; Secure; SameSite=Lax`,
		);

		const { record } = await owner.api.consentBanner.record({ siteId: site.siteId, recordId: id });
		expect(record).toEqual({
			id,
			createdAt: now,
			choices: { necessary: true, analytics: true, marketing: false, media: true },
			bannerVersion: 1,
			language: "en",
		});
	});

	test("records the language of the page and the version the visitor answered", async () => {
		const site = await newSite();
		await staff.api.languages.add({ siteId: site.siteId, code: "fr" });
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optOut", layout: "bar" });
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optIn", layout: "bar" });

		// A page loaded before the last change still answers the version it showed.
		const answer = await post(site, {
			choices: { analytics: false, marketing: false, media: false },
			version: 2,
			language: "fr",
		});

		expect(answer.status).toBe(201);
		const { id } = (await answer.json()) as { id: string };
		expect(answer.headers.get("set-cookie")).toStartWith(`__Host-webcraft.consent=${id}.2.000;`);
		expect((await owner.api.consentBanner.record({ siteId: site.siteId, recordId: id })).record).toMatchObject({
			choices: { necessary: true, analytics: false, marketing: false, media: false },
			bannerVersion: 2,
			language: "fr",
		});
	});

	test("each choice is a record of its own, even from the same address", async () => {
		const site = await newSite();

		const first = (await (await post(site, undefined, { address: "198.51.100.200" })).json()) as { id: string };
		const second = (await (await post(site, undefined, { address: "198.51.100.200" })).json()) as { id: string };

		expect(first.id).not.toBe(second.id);
	});

	test("a record is the Site's own: another Site, or an unknown id, finds nothing", async () => {
		const site = await newSite();
		const other = await newSite();
		const { id } = (await (await post(site)).json()) as { id: string };

		for (const call of [
			() => owner.api.consentBanner.record({ siteId: other.siteId, recordId: id }),
			() => owner.api.consentBanner.record({ siteId: site.siteId, recordId: crypto.randomUUID() }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "CONSENT_RECORD_NOT_FOUND" });
		}
	});
});

describe("what is refused", () => {
	test("anything but a POST", async () => {
		const site = await newSite();

		const answer = await post(site, {}, { method: "GET" });

		expect(answer.status).toBe(405);
		expect(answer.headers.get("allow")).toBe("POST");
		expectSiteHeaders(answer);
	});

	test("a post from another site's pages, or one that doesn't say where it comes from", async () => {
		const site = await newSite();

		const crossSite = await post(site, undefined, {
			headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" },
		});
		const unsaid = await install.request(
			new Request(`${site.origin}/_wc/consent`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					choices: { analytics: true, marketing: true, media: true },
					version: 1,
					language: "en",
				}),
			}),
		);

		expect(crossSite.status).toBe(403);
		expect(unsaid.status).toBe(403);
		expectSiteHeaders(crossSite);
	});

	test("a body that isn't JSON, is too big, or doesn't say what was chosen", async () => {
		const site = await newSite();
		const good = { choices: { analytics: true, marketing: false, media: true }, version: 1, language: "en" };

		expect((await post(site, "analytics=1", { headers: { "content-type": "text/plain" } })).status).toBe(415);
		expect((await post(site, JSON.stringify({ ...good, padding: "x".repeat(5000) }))).status).toBe(413);
		for (const body of [
			"{",
			{ ...good, choices: { analytics: true, marketing: false } },
			{ ...good, choices: { analytics: "yes", marketing: false, media: true } },
			{ ...good, choices: { ...good.choices, necessary: false } },
			{ ...good, version: 0 },
			{ ...good, version: 2 },
			{ ...good, language: "fr" },
		]) {
			const answer = await post(site, body);
			expect({ body, status: answer.status }).toEqual({ body, status: 400 });
			expect(answer.headers.get("set-cookie")).toBeNull();
		}
	});

	test("an IPv6 connection is counted by its /64, whichever of its addresses each post comes from", async () => {
		const site = await newSite();
		const network = ipv6Network();

		for (let n = 0; n < 10; n++) expect((await post(site, undefined, { address: network(n + 1) })).status).toBe(201);

		expect((await post(site, undefined, { address: network(11) })).status).toBe(429);
		expect((await post(site, undefined, { address: ipv6Network()(1) })).status).toBe(201);
	});

	test("too many posts from one address: refused for the rest of the minute", async () => {
		const site = await newSite();
		const address = "203.0.113.77";

		for (let n = 0; n < 10; n++) expect((await post(site, undefined, { address })).status).toBe(201);
		const refused = await post(site, undefined, { address });

		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("60");
		expect((await post(site, undefined, { address: "203.0.113.78" })).status).toBe(201);
		await install.clock.advance(61_000);
		expect((await post(site, undefined, { address })).status).toBe(201);
	});

	test("a Site that asks nothing records nothing: with None, or an outside consent service", async () => {
		const site = await newSite();

		for (const mode of ["none", "outside"] as const) {
			await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode, layout: "bar" });
			const answer = await post(site);
			expect({ mode, status: answer.status }).toEqual({ mode, status: 404 });
		}
	});
});

describe("how long records are kept", () => {
	test("12 months, then the daily purge removes them", async () => {
		const site = await newSite();
		const day = 24 * 60 * 60 * 1000;
		const { id } = (await (await post(site)).json()) as { id: string };
		// The Superadmin signs in again whenever a session ran out while the clock moved on.
		const lookUp = async () =>
			(await install.superadmin()).api.consentBanner.record({ siteId: site.siteId, recordId: id });

		await install.clock.advance(364 * day);
		await install.drainJobs();
		expect((await lookUp()).record.id).toBe(id);

		await install.clock.advance(2 * day);
		await install.drainJobs();
		await expect(lookUp()).rejects.toMatchObject({ code: "CONSENT_RECORD_NOT_FOUND" });
	});
});
