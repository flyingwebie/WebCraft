// Caddy's "ask" endpoint (ADR 0015): before Caddy gets a certificate for a hostname on demand, it asks
// the Install on the admin host. Only the admin host, the Staging addresses of existing Sites and
// verified domains (Primary, Redirect and language) are approved; anything else is refused, quickly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let siteId: string;
let slug: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	({ id: siteId, slug } = await install.createSite(workspaceId, { slug: "ask-bakery" }));
	await admin.api.languages.add({ siteId, code: "fr", domain: "ask-bakery.fr" });
	await admin.api.domains.add({ siteId, name: "ask-bakery.example", withPartner: true });
	await admin.api.domains.add({ siteId, name: "ask-waiting.example" });
	for (const name of ["ask-bakery.example", "www.ask-bakery.example", "ask-bakery.fr"]) install.connectDomain(name);
	await install.clock.advance(60_000);
	await install.drainJobs();
});

afterAll(async () => {
	await install.close();
});

function ask(domain: string | null, init?: RequestInit): Promise<Response> {
	const url = new URL(install.adminUrl("/caddy/ask"));
	if (domain !== null) url.searchParams.set("domain", domain);
	return install.request(url, init);
}

describe("Caddy's ask endpoint", () => {
	test("approves the admin host, Staging addresses of Sites and verified domains", async () => {
		for (const domain of [
			install.adminHost,
			`${slug}.sites.test`,
			"ask-bakery.example",
			"www.ask-bakery.example",
			"ask-bakery.fr",
			"ASK-Bakery.example.",
		]) {
			const response = await ask(domain);
			expect({ domain, status: response.status }).toEqual({ domain, status: 200 });
		}
	});

	test("refuses a domain waiting for DNS, any other name, and the sites domain's own names", async () => {
		for (const domain of [
			"ask-waiting.example",
			"unknown-bakery.example",
			"no-such-site.sites.test",
			"sites.test",
			"deeper.ask-bakery.sites.test",
		]) {
			const response = await ask(domain);
			expect({ domain, status: response.status }).toEqual({ domain, status: 404 });
		}
	});

	test("refuses what isn't a hostname, and any method but GET", async () => {
		for (const domain of [null, "", "not a host", "203.0.113.10", "a".repeat(300)]) {
			expect((await ask(domain)).status).toBe(400);
		}
		const post = await ask("ask-bakery.example", { method: "POST" });
		expect(post.status).toBe(405);
	});

	test("answers every ask, however many: it is never rate-limited", async () => {
		const answers = await Promise.all(Array.from({ length: 40 }, () => ask("unknown-bakery.example")));
		expect(new Set(answers.map((response) => response.status))).toEqual(new Set([404]));
	});

	test("is the admin's only: on a Site's hostname the path is the Site's", async () => {
		const response = await install.request("https://ask-bakery.example/caddy/ask?domain=ask-bakery.example");
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
	});
});
