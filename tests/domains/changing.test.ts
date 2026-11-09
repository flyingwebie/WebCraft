// Changing a Site's domains (ADR 0015): a verified domain can become the Primary domain (the one
// before becomes a Redirect domain), and a domain can be removed after confirming, which stops it at
// once. A language's domain is changed in Languages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A new Site with a published home page and these domains, each verified unless listed in `waiting`. */
async function siteWith(
	names: string[],
	waiting: string[] = [],
): Promise<{ siteId: string; ids: Map<string, string> }> {
	const { id: siteId, slug } = await install.createSite(workspaceId, { name: "Acme Bakery" });
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Welcome" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	const ids = new Map<string, string>();
	for (const name of names) {
		const { domains } = await staff.api.domains.add({ siteId, name });
		ids.set(name, domains[0]?.id ?? "");
		if (!waiting.includes(name)) install.connectDomain(name);
	}
	await install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);
	expect(slug).toBeTruthy();
	return { siteId, ids };
}

function id(ids: Map<string, string>, name: string): string {
	const found = ids.get(name);
	if (!found) throw new Error(`No domain ${name}.`);
	return found;
}

describe("making a domain the Primary domain", () => {
	test("a verified Redirect domain takes over; the Primary domain before it redirects there", async () => {
		const { siteId, ids } = await siteWith(["first-primary.example", "next-primary.example"]);

		const { domains } = await staff.api.domains.makePrimary({ siteId, domainId: id(ids, "next-primary.example") });

		expect(domains.map(({ name, role }) => [name, role])).toEqual([
			["next-primary.example", "primary"],
			["first-primary.example", "redirect"],
		]);
		expect((await install.request("https://next-primary.example/")).status).toBe(200);
		const old = await install.request("https://first-primary.example/?from=card");
		expect(old.status).toBe(301);
		expect(old.headers.get("location")).toBe("https://next-primary.example/?from=card");
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((entry) => entry.action === "domain.makePrimary" && entry.siteId === siteId)?.details).toEqual({
			name: "next-primary.example",
			before: "first-primary.example",
		});
	});

	test("a domain waiting for DNS, or a language's, can't", async () => {
		const { siteId, ids } = await siteWith(
			["live-primary.example", "slow-redirect.example"],
			["slow-redirect.example"],
		);
		await staff.api.languages.add({ siteId, code: "fr", domain: "lang-primary.fr" });
		const french = (await staff.api.domains.list({ siteId })).domains.find((domain) => domain.language === "fr");

		await expect(
			staff.api.domains.makePrimary({ siteId, domainId: id(ids, "slow-redirect.example") }),
		).rejects.toMatchObject({ code: "DOMAIN_CHANGE_REFUSED", data: { problem: "not-verified" } });
		await expect(staff.api.domains.makePrimary({ siteId, domainId: french?.id ?? "" })).rejects.toMatchObject({
			code: "DOMAIN_CHANGE_REFUSED",
			data: { problem: "language" },
		});
	});
});

describe("removing a domain", () => {
	test("asks to confirm first, then the domain stops working at once", async () => {
		const { siteId, ids } = await siteWith(["kept-bakery.example", "gone-bakery.example"]);
		const domainId = id(ids, "gone-bakery.example");

		const asked = await staff.api.domains.remove({ siteId, domainId });
		expect(asked).toMatchObject({
			removed: false,
			preview: { name: "gone-bakery.example", role: "redirect", live: true },
		});
		expect((await install.request("https://gone-bakery.example/")).status).toBe(301);

		const done = await staff.api.domains.remove({
			siteId,
			domainId,
			confirmation: asked.removed ? "" : asked.confirmation.id,
		});

		expect(done.removed).toBe(true);
		expect((await staff.api.domains.list({ siteId })).domains.map(({ name }) => name)).toEqual(["kept-bakery.example"]);
		const response = await install.request("https://gone-bakery.example/");
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not Found");
		expect((await install.request(install.adminUrl("/caddy/ask?domain=gone-bakery.example"))).status).toBe(404);
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((entry) => entry.action === "domain.remove" && entry.siteId === siteId)?.details).toEqual({
			name: "gone-bakery.example",
			role: "redirect",
		});
	});

	test("without its Primary domain, the Site is on its Staging address again, and its Redirect domains wait", async () => {
		const { siteId, ids } = await siteWith(["only-primary.example", "orphan-redirect.example"]);
		const asked = await staff.api.domains.remove({ siteId, domainId: id(ids, "only-primary.example") });
		if (asked.removed) throw new Error("Removed without confirming.");
		await staff.api.domains.remove({
			siteId,
			domainId: id(ids, "only-primary.example"),
			confirmation: asked.confirmation.id,
		});

		expect((await install.request("https://only-primary.example/")).status).toBe(404);
		expect((await install.request("https://orphan-redirect.example/")).status).toBe(404);
		const { url } = await staff.api.editMode.open({ siteId, path: "/" });
		expect(new URL(url).hostname).toEndWith(".sites.test");
	});

	test("a removed domain can be added to another Site, where it is verified again", async () => {
		const first = await siteWith(["moving-bakery.example"]);
		const asked = await staff.api.domains.remove({
			siteId: first.siteId,
			domainId: id(first.ids, "moving-bakery.example"),
		});
		if (asked.removed) throw new Error("Removed without confirming.");
		await staff.api.domains.remove({
			siteId: first.siteId,
			domainId: id(first.ids, "moving-bakery.example"),
			confirmation: asked.confirmation.id,
		});
		const { id: second } = await install.createSite(workspaceId);

		const { domains } = await staff.api.domains.add({ siteId: second, name: "moving-bakery.example" });

		expect(domains[0]).toMatchObject({ status: "waiting", verifiedAt: null });
		expect((await install.request("https://moving-bakery.example/")).status).toBe(404);
	});

	test("a language's domain is removed in Languages, not here", async () => {
		const { siteId } = await siteWith([]);
		await staff.api.languages.add({ siteId, code: "fr", domain: "lang-remove.fr" });
		const french = (await staff.api.domains.list({ siteId })).domains.find((domain) => domain.language === "fr");

		await expect(staff.api.domains.remove({ siteId, domainId: french?.id ?? "" })).rejects.toMatchObject({
			code: "DOMAIN_CHANGE_REFUSED",
			data: { problem: "language" },
		});
		await staff.api.languages.update({ siteId, code: "fr", domain: null });
		expect((await staff.api.domains.list({ siteId })).domains).toEqual([]);
	});

	test("only Staff change domains", async () => {
		const { siteId, ids } = await siteWith(["owned-bakery.example"]);
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		const domainId = id(ids, "owned-bakery.example");

		await expect(owner.api.domains.remove({ siteId, domainId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.domains.makePrimary({ siteId, domainId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
