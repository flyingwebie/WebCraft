// Redirect rules (GLOSSARY.md), kept by the Redirects and 404 log Module: Editors, Owners and Staff
// send visitors from one path of a Site to another (or to another site), with a 301 or a 302. The
// Site pipeline applies them right after Redirect domains, before the Site's own pages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
const SITE = "https://bakery.sites.test";

/** The Redirects Module's rule procedures, as `browser` calls them. */
const rules = (browser: TestBrowser = editor) => moduleApi<typeof redirects>(browser, "redirects").rules;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry: post } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: post.id });
	const pagesId = (await editor.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id;
	const { entry: about } = await editor.api.entries.create({ siteId, postTypeId: pagesId ?? "", title: "About" });
	await editor.api.entries.publish({ siteId, entryId: about.id });
});

afterAll(async () => {
	await install.close();
});

describe("a Redirect rule", () => {
	test("sends visitors from a path to its target, before the Site's own pages", async () => {
		await rules().add({ siteId, from: "/old-bread", to: "/blog/fresh-bread", status: 301 });
		await rules().add({ siteId, from: "/about", to: "/blog/fresh-bread", status: 302 });

		const moved = await install.request(`${SITE}/old-bread`);
		expect(moved.status).toBe(301);
		expect(moved.headers.get("location")).toBe("/blog/fresh-bread");
		// Browsers check again each time, so a changed rule shows at once.
		expect(moved.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(moved.headers.get("x-robots-tag")).toBe("noindex");
		expectSiteHeaders(moved);

		// About is a published Page, yet the rule answers first.
		const about = await install.request(`${SITE}/about`);
		expect(about.status).toBe(302);
		expect(about.headers.get("location")).toBe("/blog/fresh-bread");
		expect((await install.request(`${SITE}/blog/fresh-bread`)).status).toBe(200);
	});
});

describe("wildcards and query strings", () => {
	test("a rule ending /* matches the path and every path under it, carrying the rest over to a target ending /*", async () => {
		await rules().add({ siteId, from: "/recipes/*", to: "/blog/*", status: 301 });
		await rules().add({ siteId, from: "/shop/*", to: "/about-us", status: 302 });

		const deep = await install.request(`${SITE}/recipes/bread/sourdough`);
		expect(deep.status).toBe(301);
		expect(deep.headers.get("location")).toBe("/blog/bread/sourdough");
		expect((await install.request(`${SITE}/recipes`)).headers.get("location")).toBe("/blog");
		expect((await install.request(`${SITE}/recipes/`)).headers.get("location")).toBe("/blog");
		// Without /* the target is the same for every path under the rule's.
		expect((await install.request(`${SITE}/shop/cakes/tiered`)).headers.get("location")).toBe("/about-us");
		// /recipes-old isn't under /recipes.
		expect((await install.request(`${SITE}/recipes-old`)).status).toBe(404);
	});

	test("the rule for the path itself wins over a wildcard, and the nearest wildcard over a wider one", async () => {
		await rules().add({ siteId, from: "/menu/*", to: "/blog", status: 301 });
		await rules().add({ siteId, from: "/menu/cakes/*", to: "/blog/fresh-bread", status: 301 });
		await rules().add({ siteId, from: "/menu/cakes/lemon", to: "/about-us", status: 301 });

		expect((await install.request(`${SITE}/menu/bread`)).headers.get("location")).toBe("/blog");
		expect((await install.request(`${SITE}/menu/cakes/carrot`)).headers.get("location")).toBe("/blog/fresh-bread");
		expect((await install.request(`${SITE}/menu/cakes/lemon`)).headers.get("location")).toBe("/about-us");
	});

	test("the request's query string is kept, adding only the parameters the target doesn't set", async () => {
		await rules().add({ siteId, from: "/offers", to: "/blog/fresh-bread?ref=offers", status: 301 });
		await rules().add({ siteId, from: "/partner", to: "https://partner.example/bakers", status: 302 });

		const kept = await install.request(`${SITE}/offers?utm_source=mail&ref=mine`);
		expect(kept.headers.get("location")).toBe("/blog/fresh-bread?ref=offers&utm_source=mail");
		const elsewhere = await install.request(`${SITE}/partner?utm_source=mail`);
		expect(elsewhere.status).toBe(302);
		expect(elsewhere.headers.get("location")).toBe("https://partner.example/bakers?utm_source=mail");
	});

	test("paths are matched in one form: decoded parts encoded again, without a trailing slash", async () => {
		await rules().add({ siteId, from: "/café/menu/", to: "/blog", status: 301 });

		expect((await install.request(`${SITE}/caf%C3%A9/menu`)).headers.get("location")).toBe("/blog");
		expect((await install.request(`${SITE}/caf%c3%a9/menu/`)).headers.get("location")).toBe("/blog");
		const listed = (await rules().list({ siteId })).rules.find(
			(rule) => rule.to === "/blog" && rule.from.startsWith("/caf"),
		);
		expect(listed?.from).toBe("/caf%C3%A9/menu");
	});
});

describe("what a rule may be", () => {
	test("a target is a path on the Site or an https:// address: any other scheme, or another host by //, is refused", async () => {
		for (const to of [
			"javascript:alert(1)",
			"http://partner.example/",
			"//evil.example/x",
			"data:text/html,hi",
			"ftp://x.example/",
			"mailto:a@b.example",
			"https://user:pass@x.example/",
		]) {
			await expect(rules().add({ siteId, from: "/bad-target", to, status: 301 }), to).rejects.toMatchObject({
				code: "MODULE_ERROR",
				data: { code: expect.stringMatching(/^TO_(INVALID|SCHEME)$/) },
			});
		}
		// A backslash can't make a path into another host: it is encoded.
		const { rule } = await rules().add({ siteId, from: "/odd-target", to: "/\\evil.example", status: 301 });
		expect(rule.to).toBe("/%5Cevil.example");
	});

	test("a rule can't match the Install's own paths, a * anywhere but the end, or a path with a query", async () => {
		const refused = async (from: string, to: string, code: string) =>
			expect(rules().add({ siteId, from, to, status: 301 }), from).rejects.toMatchObject({ data: { code } });
		await refused("/_media/x.png", "/blog", "FROM_RESERVED");
		await refused("/_wc/*", "/blog", "FROM_RESERVED");
		await refused("/old*", "/blog", "WILDCARD_INVALID");
		await refused("/a/*/b", "/blog", "WILDCARD_INVALID");
		await refused("/old", "/new/*", "WILDCARD_INVALID");
		await refused("/old?id=1", "/blog", "FROM_INVALID");
		await refused("old", "/blog", "FROM_INVALID");
		await refused("/a//b", "/blog", "FROM_INVALID");

		expect((await install.request(`${SITE}/_media/x.png`)).status).toBe(404);
	});

	test("one rule per path, and none that would send visitors round in a circle", async () => {
		await rules().add({ siteId, from: "/loop-a", to: "/loop-b", status: 301 });
		await expect(rules().add({ siteId, from: "/loop-a", to: "/blog", status: 301 })).rejects.toMatchObject({
			status: 409,
			data: { code: "RULE_TAKEN" },
		});
		await expect(rules().add({ siteId, from: "/loop-b", to: "/loop-a", status: 301 })).rejects.toMatchObject({
			status: 409,
			data: { code: "RULE_LOOP" },
		});
		await expect(rules().add({ siteId, from: "/self", to: "/self/", status: 301 })).rejects.toMatchObject({
			data: { code: "RULE_LOOP" },
		});
		// A wildcard whose target is under itself would never end.
		await expect(rules().add({ siteId, from: "/deep/*", to: "/deep/er/*", status: 301 })).rejects.toMatchObject({
			data: { code: "RULE_LOOP" },
		});
		await expect(rules().add({ siteId, from: "/loop-c/*", to: "/loop-a", status: 301 })).resolves.toBeDefined();
	});

	test("a chain of any length gets visitors there, whichever order its rules were added in", async () => {
		// Seven rules, each added before the next one exists, and seven added after it.
		for (let n = 1; n <= 7; n++) await rules().add({ siteId, from: `/head-${n}`, to: `/head-${n + 1}`, status: 301 });
		for (let n = 7; n >= 1; n--) await rules().add({ siteId, from: `/tail-${n}`, to: `/tail-${n + 1}`, status: 301 });

		for (const chain of ["head", "tail"]) {
			// One answer goes through at most 5 rules; the browser goes on from there.
			const first = await install.request(`${SITE}/${chain}-1`);
			expect(first.status).toBe(301);
			expect(first.headers.get("location")).toBe(`/${chain}-6`);
			const second = await install.request(`${SITE}/${chain}-6`);
			expect(second.headers.get("location")).toBe(`/${chain}-8`);
		}
		// Closing either chain into a circle is still refused.
		await expect(rules().add({ siteId, from: "/head-8", to: "/head-1", status: 301 })).rejects.toMatchObject({
			data: { code: "RULE_LOOP" },
		});
	});
});

describe("managing rules", () => {
	test("Editors, Owners and Staff manage rules; Authors don't", async () => {
		const workspaceId = (await staff.api.sites.get({ siteId })).site.workspaceId;
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		const author = (await install.createMember({ workspaceId, role: "author" })).browser;

		await expect(rules(owner).add({ siteId, from: "/by-owner", to: "/blog", status: 301 })).resolves.toBeDefined();
		await expect(rules(staff).add({ siteId, from: "/by-staff", to: "/blog", status: 301 })).resolves.toBeDefined();
		await expect(rules(author).list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(rules(author).add({ siteId, from: "/by-author", to: "/blog", status: 301 })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("a change applies at once, and each one is in the Audit log", async () => {
		const { rule } = await rules().add({ siteId, from: "/soon", to: "/blog", status: 302 });
		expect((await install.request(`${SITE}/soon`)).headers.get("location")).toBe("/blog");

		await rules().update({ siteId, ruleId: rule.id, to: "/about-us", status: 301 });
		const changed = await install.request(`${SITE}/soon`);
		expect([changed.status, changed.headers.get("location")]).toEqual([301, "/about-us"]);

		await rules().remove({ siteId, ruleId: rule.id });
		expect((await install.request(`${SITE}/soon`)).status).toBe(404);

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 3 });
		expect(entries.map((entry) => [entry.action, entry.details.from])).toEqual([
			["redirects.rule.remove", "/soon"],
			["redirects.rule.update", "/soon"],
			["redirects.rule.add", "/soon"],
		]);
		await expect(rules().remove({ siteId, ruleId: rule.id })).rejects.toMatchObject({
			status: 404,
			data: { code: "RULE_NOT_FOUND" },
		});
	});

	test("the list names each rule as people write it, the newest first", async () => {
		await install.clock.advance(60_000);
		await rules().add({ siteId, from: "/listed/*", to: "/blog/*", status: 302 });
		const [newest] = (await rules().list({ siteId })).rules;
		expect(newest).toMatchObject({ from: "/listed/*", to: "/blog/*", status: 302, automatic: false });
	});
});

describe("where the Module runs", () => {
	test("a redirect is never kept as a page, and HEAD gets the same answer", async () => {
		await rules().add({ siteId, from: "/headed", to: "/blog", status: 301 });
		const head = await install.request(`${SITE}/headed`, { method: "HEAD" });
		expect([head.status, head.headers.get("location")]).toEqual([301, "/blog"]);
		expect(head.headers.get("x-cache")).toBeNull();
		expect(head.headers.get("etag")).toBeNull();
		// Other methods aren't redirected.
		expect((await install.request(`${SITE}/headed`, { method: "POST" })).status).toBe(405);
	});

	test("switched off on the Site, its rules stop at once and come back when it is on again", async () => {
		await rules().add({ siteId, from: "/switchable", to: "/blog", status: 301 });
		await staff.api.modules.setOnSite({ siteId, moduleId: "redirects", on: false });
		expect((await install.request(`${SITE}/switchable`)).status).toBe(404);
		await staff.api.modules.setOnSite({ siteId, moduleId: "redirects", on: true });
		expect((await install.request(`${SITE}/switchable`)).status).toBe(301);
	});
});
