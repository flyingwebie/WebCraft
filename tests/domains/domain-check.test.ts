// The Domain check (ADR 0015): every hour, each verified domain is checked again. A domain whose DNS
// no longer points at the Install, whose certificate is missing or runs out within 14 days, or which
// answers something other than the Install, is marked Unreachable, and the Site's Owners get the
// `domain-unreachable` email once. It keeps serving: it may come back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let install: TestInstall;
let workspaceId: string;
let owner: { email: string };
let otherSitesOwner: { email: string };
let editor: { email: string };
let staff: TestBrowser;

async function api(): Promise<TestBrowser["api"]> {
	return (await install.superadmin()).api;
}

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner", email: "owner@client.example" })).account;
	editor = (await install.createMember({ workspaceId, role: "editor", email: "editor@client.example" })).account;
	const elsewhere = (await install.createSite(workspaceId)).id;
	otherSitesOwner = (
		await install.createMember({
			workspaceId,
			role: "owner",
			sites: [elsewhere],
			email: "careers-owner@client.example",
		})
	).account;
});

afterAll(async () => {
	await install.close();
});

async function after(ms: number): Promise<void> {
	await install.clock.advance(ms);
	expect((await install.drainJobs()).failed).toEqual([]);
}

/** A new Site with a verified Primary domain. */
async function liveSite(name: string): Promise<{ siteId: string; domainId: string }> {
	const { id: siteId } = await install.createSite(workspaceId, { name: "Acme Bakery" });
	const { domains } = await (await api()).domains.add({ siteId, name });
	install.connectDomain(name);
	await after(MINUTE);
	return { siteId, domainId: domains[0]?.id ?? "" };
}

async function domainOf(siteId: string, domainId: string) {
	const found = (await (await api()).domains.list({ siteId })).domains.find((domain) => domain.id === domainId);
	if (!found) throw new Error("No such domain.");
	return found;
}

/** The `domain-unreachable` emails that went to an address about a domain. */
async function unreachableEmailsTo(address: string, domain: string): Promise<{ subject: string; text: string }[]> {
	await install.drainJobs();
	const logged = install.logs.flatMap((entry) => {
		const email = entry.email as { to?: string; subject?: string; text?: string } | undefined;
		return email?.to === address ? [{ subject: email.subject ?? "", text: email.text ?? "" }] : [];
	});
	return logged.filter((email) => email.subject === `${domain} is unreachable`);
}

describe("the hourly Domain check", () => {
	test("a domain that still reaches the Install, with a lasting certificate, stays active", async () => {
		const { siteId, domainId } = await liveSite("steady-bakery.example");
		const expiresAt = new Date(install.clock.now().getTime() + 60 * DAY);
		install.tls.answer("steady-bakery.example", { expiresAt });

		await after(HOUR);

		const domain = await domainOf(siteId, domainId);
		expect(domain).toMatchObject({ status: "active", problem: null, certificateExpiresAt: expiresAt });
		expect(domain.lastCheckedAt).toEqual(install.clock.now());
		expect(await unreachableEmailsTo(owner.email, "steady-bakery.example")).toEqual([]);
	});

	test("DNS that moved makes it Unreachable, and the Site's Owners are emailed once", async () => {
		const { siteId, domainId } = await liveSite("moved-bakery.example");
		install.dns.answer("moved-bakery.example", ["93.184.216.34"]);
		install.http.respond("GET", /^http:\/\/moved-bakery\.example\//, { body: "Parked domain" });

		await after(HOUR);

		expect(await domainOf(siteId, domainId)).toMatchObject({ status: "unreachable", problem: "dns" });
		const [email] = await unreachableEmailsTo(owner.email, "moved-bakery.example");
		expect(email?.text).toContain("Acme Bakery");
		expect(email?.text).toContain(`https://${install.adminHost}/sites/${siteId}/domains`);
		for (const address of [editor.email, otherSitesOwner.email]) {
			expect(await unreachableEmailsTo(address, "moved-bakery.example")).toEqual([]);
		}

		await after(HOUR);
		await after(HOUR);
		expect(await unreachableEmailsTo(owner.email, "moved-bakery.example")).toHaveLength(1);
	});

	test("it keeps serving while Unreachable, and is active again once it passes; a new failure emails again", async () => {
		const { siteId, domainId } = await liveSite("flaky-bakery.example");
		install.dns.answer("flaky-bakery.example", []);
		await after(HOUR);
		expect(await domainOf(siteId, domainId)).toMatchObject({ status: "unreachable", problem: "dns" });

		const ask = await install.request(install.adminUrl("/caddy/ask?domain=flaky-bakery.example"));
		expect(ask.status).toBe(200);
		expect((await install.request("https://flaky-bakery.example/")).status).toBe(404);
		expect((await install.request("https://flaky-bakery.example/")).headers.get("content-type")).toBe(
			"text/html; charset=utf-8",
		);

		install.connectDomain("flaky-bakery.example");
		await after(HOUR);
		expect(await domainOf(siteId, domainId)).toMatchObject({ status: "active", problem: null });

		install.dns.answer("flaky-bakery.example", []);
		await after(HOUR);
		expect(await unreachableEmailsTo(owner.email, "flaky-bakery.example")).toHaveLength(2);
	});

	test("a certificate that is missing, not trusted or runs out within 14 days makes it Unreachable", async () => {
		const cases = [
			["nocert-bakery.example", null, "certificate-missing"],
			[
				"selfsigned-bakery.example",
				{ expiresAt: new Date(install.clock.now().getTime() + 90 * DAY), trusted: false },
				"certificate-missing",
			],
			[
				"expiring-bakery.example",
				{ expiresAt: new Date(install.clock.now().getTime() + 10 * DAY) },
				"certificate-expiring",
			],
		] as const;
		const sites = [];
		for (const [name] of cases) sites.push(await liveSite(name));
		for (const [name, certificate] of cases) install.tls.answer(name, certificate);

		await after(HOUR);

		for (const [index, [name, , problem]] of cases.entries()) {
			const site = sites[index];
			if (!site) throw new Error("No Site.");
			// The domain's own name says which case failed.
			expect(await domainOf(site.siteId, site.domainId)).toMatchObject({
				name,
				status: "unreachable",
				problem,
			});
			expect(await unreachableEmailsTo(owner.email, name)).toHaveLength(1);
		}
	});

	test("an answer that isn't the Install's makes it Unreachable", async () => {
		const { siteId, domainId } = await liveSite("hijacked-bakery.example");
		install.http.respond("GET", /^http:\/\/hijacked-bakery\.example\//, { body: "Something else" });

		await after(HOUR);

		expect(await domainOf(siteId, domainId)).toMatchObject({ status: "unreachable", problem: "response" });
	});

	test("Staff run the Domain check on a live domain at once with Check now", async () => {
		const { siteId, domainId } = await liveSite("checked-bakery.example");
		install.tls.answer("checked-bakery.example", null);

		const { domain } = await staff.api.domains.check({ siteId, domainId });

		expect(domain).toMatchObject({ status: "unreachable", problem: "certificate-missing" });
		expect(domain.lastCheckedAt).toEqual(install.clock.now());
	});
});
