// Staging addresses: with WEBCRAFT_SITES_DOMAIN set, each Site answers on `<site slug>.<sites domain>`.
// The admin host stays reserved: it is never a Site's address, and Site hostnames never reach the admin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let admin: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

/** Publishes a page at /pages/<slug> on a Site: a Post Type, its Entry template and one Entry. */
async function publishPage(siteId: string, slug: string, title: string): Promise<void> {
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Pages", urlPattern: "/pages/{slug}" });
	const { template } = await admin.api.templates.saveEntryTemplate({
		siteId,
		postTypeId: postType.id,
		tree: tree(element("h1", [value("title")])),
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title, slug });
	await admin.api.entries.publish({ siteId, entryId: entry.id });
}

function expectUnbrandedNotFound(response: Response, body: string): void {
	expect(response.status).toBe(404);
	expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	expect(body).toBe("Not Found");
	for (const [name, header] of response.headers) expect(`${name}: ${header}`.toLowerCase()).not.toContain("webcraft");
}

/** The Site's own 404 page (the built-in one here), which names nothing of what serves it. */
function expectSiteNotFoundPage(response: Response, body: string): void {
	expect(response.status).toBe(404);
	expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(body).toContain("<h1>Page not found</h1>");
	expect(body.toLowerCase()).not.toContain("webcraft");
	for (const [name, header] of response.headers) expect(`${name}: ${header}`.toLowerCase()).not.toContain("webcraft");
}

describe("each Site's Staging address", () => {
	test("is <site slug>.<sites domain>, and shows that Site's pages only", async () => {
		const bakery = await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" });
		const careers = await install.createSite(workspaceId, { name: "Acme Careers", slug: "careers" });
		await publishPage(bakery.id, "about", "About the bakery");
		await publishPage(careers.id, "about", "Work with us");

		const bakeryUrl = (await admin.api.sites.get({ siteId: bakery.id })).stagingUrl;
		const careersUrl = (await admin.api.sites.get({ siteId: careers.id })).stagingUrl;

		expect(bakeryUrl).toBe("https://bakery.sites.test");
		expect(careersUrl).toBe("https://careers.sites.test");
		expect(await (await install.request(`${bakeryUrl}/pages/about`)).text()).toContain("<h1>About the bakery</h1>");
		expect(await (await install.request(`${careersUrl}/pages/about`)).text()).toContain("<h1>Work with us</h1>");
	});

	test("matches the hostname in any case, with or without the trailing dot", async () => {
		const shop = await install.createSite(workspaceId, { name: "Acme Shop", slug: "shop" });
		await publishPage(shop.id, "hours", "Opening hours");

		for (const hostname of ["SHOP.Sites.Test", "shop.sites.test."]) {
			const response = await install.request(`https://${hostname}/pages/hours`);
			expect(response.status).toBe(200);
		}
	});

	test("tells search engines not to index it", async () => {
		const response = await install.request("https://bakery.sites.test/pages/about");
		const missing = await install.request("https://bakery.sites.test/pages/no-such-page");

		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		expect(missing.headers.get("x-robots-tag")).toBe("noindex");
	});

	test("answers a path with no page with the Site's own unbranded 404 page", async () => {
		for (const path of ["/", "/pages/no-such-page", "/pages", "/pages/about/more", "//pages/about"]) {
			const response = await install.request(`https://bakery.sites.test${path}`);
			expectSiteNotFoundPage(response, await response.text());
		}
	});

	test("answers only GET and HEAD; HEAD has the headers without the page", async () => {
		const post = await install.request("https://bakery.sites.test/pages/about", { method: "POST", body: "x" });
		const head = await install.request("https://bakery.sites.test/pages/about", { method: "HEAD" });

		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(head.headers.get("etag")).toBeTruthy();
		expect(await head.text()).toBe("");
	});
});

describe("hostnames that are no Site's", () => {
	test("a name under the sites domain that no Site has, the sites domain itself and deeper names get the unbranded 404", async () => {
		for (const hostname of ["no-such-site.sites.test", "sites.test", "about.bakery.sites.test"]) {
			const response = await install.request(`https://${hostname}/pages/about`);
			expectUnbrandedNotFound(response, await response.text());
		}
	});
});

describe("Site hostnames never reach the admin", () => {
	test("the admin's own paths on a Staging address are the Site's, not the admin's", async () => {
		for (const path of ["/healthz", "/readyz", "/sign-in", "/api/rpc/session/current"]) {
			const response = await install.request(`https://bakery.sites.test${path}`);
			expectSiteNotFoundPage(response, await response.text());
		}
		const call = await install.request("https://bakery.sites.test/api/rpc/session/current", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(call.status).toBe(405);
	});

	test("when the admin host sits under the sites domain, its name can't be a Site's slug", async () => {
		const shared = await createTestInstall({ adminHost: "cms.sites.test", sitesDomain: "sites.test" });
		try {
			const superadmin = await shared.superadmin();
			const { workspace } = await superadmin.api.workspaces.create({ name: "Acme Ltd" });

			await expect(
				superadmin.api.sites.create({ workspaceId: workspace.id, name: "CMS", slug: "cms" }),
			).rejects.toMatchObject({ code: "SLUG_INVALID", data: { problem: "reserved" } });
			expect((await shared.request("https://cms.sites.test/healthz")).status).toBe(200);
		} finally {
			await shared.close();
		}
	});
});

describe("an Install without WEBCRAFT_SITES_DOMAIN", () => {
	test("gives Sites no Staging address, and answers every Site hostname with the unbranded 404", async () => {
		const bare = await createTestInstall({ sitesDomain: null });
		try {
			const superadmin = await bare.superadmin();
			const { workspace } = await superadmin.api.workspaces.create({ name: "Acme Ltd" });
			const { site } = await superadmin.api.sites.create({ workspaceId: workspace.id, name: "Bakery", slug: "bakery" });

			expect((await superadmin.api.sites.get({ siteId: site.id })).stagingUrl).toBeNull();
			const response = await bare.request("https://bakery.sites.test/");
			expectUnbrandedNotFound(response, await response.text());
		} finally {
			await bare.close();
		}
	});
});
