// A CDN in front of a Site (spec story 43): Staff connect the domain with the CDN's proxy off, wait for
// verification and the certificate, then turn the proxy on. From then on every visitor reaches the
// Install from the CDN's servers, and the CDN names the visitor in a header of its own
// (`CF-Connecting-IP`, `Fastly-Client-IP`). A Site's CDN setting says which header to believe, and it
// is believed only on connections from that CDN's published address ranges, so rate limits keep
// counting visitors rather than the CDN. The ranges ship with WebCraft and are refreshed daily for the
// CDNs Sites use.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

/** Where Caddy reaches the web process in the Compose file. */
const CADDY = "172.18.0.5";
/** Servers in the ranges each CDN publishes (as WebCraft ships them). */
const CLOUDFLARE_SERVER = "173.245.48.10";
const FASTLY_SERVER = "151.101.1.10";
/** Where each CDN publishes its ranges. */
const CLOUDFLARE_LIST = "https://api.cloudflare.com/client/v4/ips";
const FASTLY_LIST = "https://api.fastly.com/public-ip-list";
/** A public address for the lists' hosts, as DNS would answer. */
const LIST_HOST_ADDRESS = "93.184.216.34";
/** Consent records a client address may make on one Site in a minute. */
const CONSENT_LIMIT = 10;
const MINUTE = 60_000;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let owner: TestBrowser;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	install.dns.answer("api.cloudflare.com", [LIST_HOST_ADDRESS]);
	install.dns.answer("api.fastly.com", [LIST_HOST_ADDRESS]);
});

afterAll(async () => {
	await install.close();
});

async function newSite(cdn?: "cloudflare" | "fastly") {
	const slug = `cdn-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { slug });
	if (cdn) await staff.api.domains.setCdn({ siteId, cdn });
	// Visitors on the Site's domain: its Staging address lets in only the people reviewing it.
	return { siteId, origin: await goLive(install, siteId) };
}

/**
 * A visitor's choice on the Consent banner, as it reaches the web process: through Caddy, from
 * `from` (the address Caddy saw), with `headers` (a CDN's own, or a client's attempt at one).
 */
function consent(site: { origin: string }, from: string, headers: Record<string, string> = {}) {
	const request = new Request(`${site.origin}/_wc/consent`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: site.origin,
			"sec-fetch-site": "same-origin",
			"x-forwarded-for": from,
			...headers,
		},
		body: JSON.stringify({ choices: { analytics: true, marketing: false, media: true }, version: 1, language: "en" }),
	});
	return install.request(fromAddress(request, CADDY));
}

/** Records choices until the limit refuses one: how many it took. */
async function recordedBeforeLimit(post: () => Promise<Response>): Promise<number> {
	for (let made = 0; made <= CONSENT_LIMIT + 1; made++) {
		const answer = await post();
		if (answer.status === 429) return made;
		expect(answer.status).toBe(201);
	}
	return Number.POSITIVE_INFINITY;
}

describe("a Site's CDN (Site settings)", () => {
	test("Staff choose the CDN in front of a Site; everyone who sees the Site sees it; the change is in the Audit log", async () => {
		const { siteId } = await newSite();
		expect((await owner.api.domains.list({ siteId })).cdn).toBeNull();

		await expect(staff.api.domains.setCdn({ siteId, cdn: "cloudflare" })).resolves.toEqual({ cdn: "cloudflare" });

		expect((await owner.api.domains.list({ siteId })).cdn).toBe("cloudflare");
		await staff.api.domains.setCdn({ siteId, cdn: null });
		expect((await staff.api.domains.list({ siteId })).cdn).toBeNull();
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(
			entries.filter((entry) => entry.action === "cdn.change" && entry.siteId === siteId).map((entry) => entry.details),
		).toEqual([
			{ from: "cloudflare", to: null },
			{ from: null, to: "cloudflare" },
		]);
	});

	test("only Staff change it", async () => {
		const { siteId } = await newSite();

		await expect(owner.api.domains.setCdn({ siteId, cdn: "fastly" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect((await staff.api.domains.list({ siteId })).cdn).toBeNull();
	});

	test("only the CDNs WebCraft knows the ranges of", async () => {
		const { siteId } = await newSite();

		await expect(staff.api.domains.setCdn({ siteId, cdn: "my-own-cdn" as unknown as "fastly" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});

describe("the visitor's address behind a Site's CDN", () => {
	test("on a connection from the CDN's published ranges, its header names the visitor: each visitor is counted apart", async () => {
		const site = await newSite("cloudflare");

		const first = () => consent(site, CLOUDFLARE_SERVER, { "cf-connecting-ip": "198.51.100.50" });
		expect(await recordedBeforeLimit(first)).toBe(CONSENT_LIMIT);
		const second = await consent(site, CLOUDFLARE_SERVER, { "cf-connecting-ip": "2001:db8:cafe::51" });
		expect(second.status).toBe(201);
	});

	test("from anywhere else the header is ignored: a client can't choose its address by sending it", async () => {
		const site = await newSite("cloudflare");
		let n = 0;

		const forged = () => consent(site, "203.0.113.70", { "cf-connecting-ip": `198.51.100.${++n}` });

		expect(await recordedBeforeLimit(forged)).toBe(CONSENT_LIMIT);
	});

	test("a Site without a CDN never reads such a header", async () => {
		const site = await newSite();
		let n = 0;

		const fromCloudflare = () => consent(site, CLOUDFLARE_SERVER, { "cf-connecting-ip": `198.51.100.${++n}` });

		expect(await recordedBeforeLimit(fromCloudflare)).toBe(CONSENT_LIMIT);
	});

	test("each CDN's own header, from its own ranges only: Fastly's Fastly-Client-IP", async () => {
		const site = await newSite("fastly");

		expect(await recordedBeforeLimit(() => consent(site, FASTLY_SERVER, { "fastly-client-ip": "198.51.100.60" }))).toBe(
			CONSENT_LIMIT,
		);
		expect((await consent(site, FASTLY_SERVER, { "fastly-client-ip": "198.51.100.61" })).status).toBe(201);
		// Another CDN's servers, or another CDN's header, name nobody.
		let n = 0;
		const elsewhere = () =>
			consent(site, CLOUDFLARE_SERVER, {
				"fastly-client-ip": `198.51.100.${++n}`,
				"cf-connecting-ip": "198.51.100.62",
			});
		expect(await recordedBeforeLimit(elsewhere)).toBe(CONSENT_LIMIT);
	});

	test("a header that isn't an address leaves the CDN's server as the address", async () => {
		const site = await newSite("cloudflare");
		let n = 0;

		const garbled = () => consent(site, CLOUDFLARE_SERVER, { "cf-connecting-ip": `visitor number ${++n}` });

		expect(await recordedBeforeLimit(garbled)).toBe(CONSENT_LIMIT);
	});

	test("the admin never reads a Site's CDN header", async () => {
		await newSite("cloudflare");
		const { account } = await install.createStaff({ workspaces: [workspaceId] });
		const admin = await install.signIn(account, {
			address: CADDY,
			headers: { "x-forwarded-for": CLOUDFLARE_SERVER, "cf-connecting-ip": "198.51.100.70" },
		});

		const { sessions } = await admin.api.me.sessions.list();

		expect(sessions.find((session) => session.current)?.network).toBe("173.245.48.*");
	});
});

describe("the CDNs' published ranges", () => {
	/** Answers Cloudflare's list with these IPv4 and IPv6 ranges. */
	function cloudflareLists(ipv4: string[], ipv6: string[] = []) {
		install.http.respond("GET", CLOUDFLARE_LIST, {
			body: JSON.stringify({ result: { ipv4_cidrs: ipv4, ipv6_cidrs: ipv6, etag: "e" }, success: true }),
			headers: { "content-type": "application/json" },
		});
	}

	test("are fetched daily for the CDNs Sites use, through the guarded fetcher; the new list counts within minutes", async () => {
		const site = await newSite("cloudflare");
		cloudflareLists(["192.0.2.0/24"], ["2001:db8:cf::/48"]);
		const asked = install.http.requests.length;

		await install.clock.advance(24 * 60 * MINUTE);
		const report = await install.drainJobs();
		await install.clock.advance(5 * MINUTE);

		expect(report.failed).toEqual([]);
		const fetched = install.http.requests.slice(asked).filter((request) => request.url === CLOUDFLARE_LIST);
		expect(fetched.length).toBeGreaterThan(0);
		expect(fetched.every((request) => request.address === LIST_HOST_ADDRESS)).toBe(true);
		// A server in the new list names its visitor; one only in the old list no longer does.
		expect((await consent(site, "192.0.2.9", { "cf-connecting-ip": "198.51.100.80" })).status).toBe(201);
		expect(await recordedBeforeLimit(() => consent(site, "192.0.2.9", { "cf-connecting-ip": "198.51.100.81" }))).toBe(
			CONSENT_LIMIT,
		);
		let n = 0;
		expect(
			await recordedBeforeLimit(() => consent(site, CLOUDFLARE_SERVER, { "cf-connecting-ip": `198.51.101.${++n}` })),
		).toBe(CONSENT_LIMIT);
	});

	test("a list that doesn't read as address ranges changes nothing: the Install keeps the ranges it had and says so", async () => {
		const site = await newSite("cloudflare");
		const logged = install.logs.length;
		for (const broken of [
			{ result: { ipv4_cidrs: ["192.0.2.0/24", "not a range"], ipv6_cidrs: [] }, success: true },
			{ result: { ipv4_cidrs: [], ipv6_cidrs: [] }, success: true },
			{ result: { ipv4_cidrs: ["0.0.0.0/1"], ipv6_cidrs: [] }, success: true },
			{ success: false },
		]) {
			install.http.respond("GET", CLOUDFLARE_LIST, { body: JSON.stringify(broken) });
			await install.clock.advance(24 * 60 * MINUTE);
			expect((await install.drainJobs()).failed).toEqual([]);
		}
		await install.clock.advance(5 * MINUTE);

		const warnings = install.logs.slice(logged).filter((entry) => entry.cdn === "cloudflare" && entry.level === "warn");
		expect(warnings.length).toBeGreaterThanOrEqual(4);
		// The last good list (from the test before) still counts.
		expect((await consent(site, "192.0.2.10", { "cf-connecting-ip": "198.51.100.90" })).status).toBe(201);
		expect(await recordedBeforeLimit(() => consent(site, "192.0.2.10", { "cf-connecting-ip": "198.51.100.91" }))).toBe(
			CONSENT_LIMIT,
		);
	});

	test("only the lists of CDNs in use are fetched, and choosing a CDN fetches its list at once", async () => {
		const fresh = await createTestInstall();
		try {
			fresh.dns.answer("api.fastly.com", [LIST_HOST_ADDRESS]);
			fresh.http.respond("GET", FASTLY_LIST, {
				body: JSON.stringify({ addresses: ["198.18.0.0/24"], ipv6_addresses: ["2001:db8:f5::/48"] }),
			});
			const { id: freshWorkspace } = await fresh.createWorkspace();
			const { browser: freshStaff } = await fresh.createStaff({ workspaces: [freshWorkspace] });
			const { id: siteId, slug } = await fresh.createSite(freshWorkspace);
			await goLive(fresh, siteId);
			await fresh.clock.advance(24 * 60 * MINUTE);
			await fresh.drainJobs();
			expect(fresh.http.requests.some((request) => request.url === FASTLY_LIST)).toBe(false);

			await freshStaff.api.domains.setCdn({ siteId, cdn: "fastly" });
			expect((await fresh.drainJobs()).completed.map((job) => job.name)).toContain("cdn.refresh-ranges");
			await fresh.clock.advance(5 * MINUTE);

			expect(fresh.http.requests.filter((request) => request.url === FASTLY_LIST)).toHaveLength(1);
			const post = (visitor: string) =>
				fresh.request(
					fromAddress(
						new Request(`https://${slug}.live.test/_wc/consent`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								origin: `https://${slug}.live.test`,
								"sec-fetch-site": "same-origin",
								"x-forwarded-for": "198.18.0.7",
								"fastly-client-ip": visitor,
							},
							body: JSON.stringify({
								choices: { analytics: true, marketing: false, media: true },
								version: 1,
								language: "en",
							}),
						}),
						CADDY,
					),
				);
			expect((await post("198.51.100.95")).status).toBe(201);
			expect(await recordedBeforeLimit(() => post("198.51.100.96"))).toBe(CONSENT_LIMIT);
		} finally {
			await fresh.close();
		}
	});
});
