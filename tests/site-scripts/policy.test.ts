// A Site's Content Security Policy (ADR 0023): Strict by default (`script-src 'self'` plus the Site's
// allowed hosts), Relaxed (inline scripts and eval allowed, for tag managers) or Report only, and the
// fixed security headers on every answer on the Site's domain. Pages are cached, so the policy is
// worked out per Site (and per page, for a body's videos) and kept with the page until a change clears
// the cache.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import {
	expectNoInlineCode,
	expectSafePage,
	expectSiteHeaders,
	policyOf,
	reportOnlyPolicyOf,
} from "../harness/site-safety.ts";
import { sample } from "../modules/sample/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/**
 * A new Site with a Body field Post Type whose Entry template shows the body, and one published Entry
 * at `/notes/first` (with a video in its body when asked). Answers the Site and an address on it.
 */
async function newSite(options: { video?: boolean } = {}) {
	const slug = `policy-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Notes",
		key: "notes",
		urlPattern: "/notes/{slug}",
		fields: [{ key: "body", label: "Body", type: "body" }],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const body = [{ type: "paragraph", text: "Fresh every morning." }];
	if (options.video) body.push({ type: "video", url: "https://vimeo.com/76979871" } as never);
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "First",
		slug: "first",
		fields: { body },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, slug, url: (path: string) => `https://${slug}.sites.test${path}` };
}

describe("the fixed security headers", () => {
	test("every answer on the Site's domain carries them: pages, 404s, files, redirects and refusals", async () => {
		const site = await newSite();
		const { media } = await editor.api.media.upload({ siteId: site.siteId, file: upload(pdf(), "menu.pdf") });
		const page = await install.request(site.url("/notes/first"));
		const html = await page.clone().text();
		const stylesheet = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1] ?? "";

		const answers: [string, Response][] = [
			["a page", page],
			["a page again, from the cache", await install.request(site.url("/notes/first"))],
			[
				"a page the browser has (304)",
				await install.request(site.url("/notes/first"), {
					headers: { "if-none-match": page.headers.get("etag") ?? "" },
				}),
			],
			["the 404 page", await install.request(site.url("/nothing-here"))],
			["a reserved path", await install.request(site.url("/_nothing"))],
			["a file name", await install.request(site.url("/robots.txt"))],
			["the stylesheet", await install.request(site.url(stylesheet))],
			["a redirect", await install.request(site.url("/notes/first/"))],
			["the Language switcher's redirect", await install.request(site.url("/_wc/lang/notes/first"))],
			["a refused method", await install.request(site.url("/notes/first"), { method: "POST" })],
			["an Edit mode link that doesn't work", await install.request(site.url("/_webcraft/edit/enter?token=nope"))],
			["a Module route on a Site where it doesn't run", await install.request(site.url("/_wc/m/sample/notes"))],
		];
		for (const [what, response] of answers) {
			expect(response.status, what).not.toBe(500);
			expectSiteHeaders(response);
		}

		const file = await install.request(site.url(media.url ?? ""));
		expect(file.status).toBe(200);
		expectSiteHeaders(file, { media: true });
		// A PDF opens in the browser's own viewer: no policy here may block it.
		expect(policyOf(file).get("object-src")).toBeUndefined();
		expect(policyOf(file).get("default-src")).toBeUndefined();
	});

	test("hostnames that are no Site's still get the unbranded 404", async () => {
		const response = await install.request("https://nobody.sites.test/");
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not Found");
	});
});

describe("the Site's policy", () => {
	test("is Strict by default: scripts, styles, fonts and requests only from the Site, images and media from https too", async () => {
		const site = await newSite();
		const page = await install.request(site.url("/notes/first"));

		await expectSafePage(page.clone(), "strict");
		const policy = policyOf(page);
		expect(Object.fromEntries(policy)).toEqual({
			"default-src": ["'self'"],
			"script-src": ["'self'"],
			"style-src": ["'self'"],
			"img-src": ["'self'", "data:", "https:"],
			"media-src": ["'self'", "https:"],
			"font-src": ["'self'"],
			"connect-src": ["'self'"],
			"frame-src": ["'self'"],
			"object-src": ["'none'"],
			"base-uri": ["'self'"],
			"form-action": ["'self'"],
			"frame-ancestors": ["'self'"],
		});
		expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
		expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect((await staff.api.csp.get({ siteId: site.siteId })).policy).toEqual({
			mode: "strict",
			hosts: [],
			moduleHosts: [],
		});
	});

	test("the 404 page is under the same policy", async () => {
		const site = await newSite();
		const response = await install.request(site.url("/nothing-here"));
		expect(response.status).toBe(404);
		await expectSafePage(response, "strict");
	});

	test("a page showing a body's video lets the players' frames in; pages without one don't", async () => {
		const site = await newSite({ video: true });
		const withVideo = await install.request(site.url("/notes/first"));
		await expectSafePage(withVideo.clone());
		expect(policyOf(withVideo).get("frame-src")).toEqual([
			"'self'",
			"https://www.youtube-nocookie.com",
			"https://player.vimeo.com",
		]);
		// From the page cache too: the policy is kept with the page.
		const cached = await install.request(site.url("/notes/first"));
		expect(cached.headers.get("x-cache")).toBe("HIT");
		expect(policyOf(cached).get("frame-src")).toEqual(policyOf(withVideo).get("frame-src"));

		const other = await newSite();
		expect(policyOf(await install.request(other.url("/notes/first"))).get("frame-src")).toEqual(["'self'"]);
	});

	test("Relaxed allows inline scripts and eval, for tag managers; the page still carries no inline code", async () => {
		const site = await newSite();
		await install.request(site.url("/notes/first"));

		const { policy } = await staff.api.csp.setMode({ siteId: site.siteId, mode: "relaxed" });
		expect(policy.mode).toBe("relaxed");

		// The change clears the page cache: the next page is rendered under the new policy.
		const page = await install.request(site.url("/notes/first"));
		expect(page.headers.get("x-cache")).toBe("MISS");
		await expectSafePage(page.clone(), "relaxed");
		expect(policyOf(page).get("script-src")).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
		expect(policyOf(page).get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
		expect(policyOf(page).get("object-src")).toEqual(["'none'"]);
	});

	test("Report only reports the Strict policy and enforces only the fixed directives", async () => {
		const site = await newSite();
		await staff.api.csp.setMode({ siteId: site.siteId, mode: "reportOnly" });

		const page = await install.request(site.url("/notes/first"));
		await expectSafePage(page.clone(), "reportOnly");
		expect(Object.fromEntries(policyOf(page))).toEqual({
			"object-src": ["'none'"],
			"base-uri": ["'self'"],
			"form-action": ["'self'"],
			"frame-ancestors": ["'self'"],
		});
		expect(reportOnlyPolicyOf(page).get("script-src")).toEqual(["'self'"]);

		await staff.api.csp.setMode({ siteId: site.siteId, mode: "strict" });
		const strict = await install.request(site.url("/notes/first"));
		expect(strict.headers.get("content-security-policy-report-only")).toBeNull();
		expect(policyOf(strict).get("script-src")).toEqual(["'self'"]);
	});

	test("allowed hosts Staff add join scripts, styles, fonts, requests and frames, over https only", async () => {
		const site = await newSite();
		await install.request(site.url("/notes/first"));

		const added = await staff.api.csp.addHost({ siteId: site.siteId, host: " Tags.Example.COM " });
		expect(added.policy.hosts).toEqual([{ host: "tags.example.com", source: "hand", usedBy: [] }]);
		await staff.api.csp.addHost({ siteId: site.siteId, host: "*.cdn.example.net" });

		const page = await install.request(site.url("/notes/first"));
		expect(page.headers.get("x-cache")).toBe("MISS");
		const policy = policyOf(page);
		const hosts = ["https://*.cdn.example.net", "https://tags.example.com"];
		for (const directive of ["script-src", "style-src", "font-src", "connect-src", "frame-src"]) {
			expect(policy.get(directive), directive).toEqual(["'self'", ...hosts]);
		}
		// Forms never post elsewhere, whatever is allowed.
		expect(policy.get("form-action")).toEqual(["'self'"]);

		await staff.api.csp.removeHost({ siteId: site.siteId, host: "tags.example.com" });
		expect(policyOf(await install.request(site.url("/notes/first"))).get("script-src")).toEqual([
			"'self'",
			"https://*.cdn.example.net",
		]);
	});

	test("a host that isn't one is refused, so nothing can be added to the policy but a host", async () => {
		const site = await newSite();
		for (const host of [
			"tags.example.com; script-src *",
			"https://tags.example.com",
			"tags.example.com/path",
			"'unsafe-inline'",
			"*",
			"*.com",
			"localhost",
			"tags example.com",
			"",
			`${"a".repeat(64)}.example.com`,
		]) {
			await expect(staff.api.csp.addHost({ siteId: site.siteId, host }), host).rejects.toMatchObject({
				code: "HOST_INVALID",
			});
		}
		expect((await staff.api.csp.get({ siteId: site.siteId })).policy.hosts).toEqual([]);
	});

	test("a Module's outside hosts are allowed only on Sites where it runs", async () => {
		const site = await newSite();
		const superadmin = await install.superadmin();
		await superadmin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });

		const page = await install.request(site.url("/notes/first"));
		expect(policyOf(page).get("connect-src")).toEqual(["'self'", "https://hooks.sample.example"]);
		expect(policyOf(page).get("script-src")).toEqual(["'self'", "https://hooks.sample.example"]);
		expect((await staff.api.csp.get({ siteId: site.siteId })).policy.moduleHosts).toEqual([
			{ host: "hooks.sample.example", moduleId: "sample", module: "Sample notes" },
		]);

		// Switching it off on the Site takes its hosts out at once.
		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "sample", on: false });
		expect(policyOf(await install.request(site.url("/notes/first"))).get("connect-src")).toEqual(["'self'"]);

		await superadmin.api.modules.withdraw({ moduleId: "sample" });
	});

	test("Edit mode keeps its own strict policy, letting Site scripts reach the allowed hosts", async () => {
		const site = await newSite();
		await staff.api.csp.setMode({ siteId: site.siteId, mode: "relaxed" });
		await staff.api.csp.addHost({ siteId: site.siteId, host: "api.example.com" });
		const editing = await openEditMode(install, staff, site.siteId, "/notes/first");

		const page = await editing.page("/notes/first");
		await expectSafePage(page.clone(), "editMode");
		const policy = policyOf(page);
		expect(policy.get("script-src")).toEqual(["'self'"]);
		expect(policy.get("connect-src")).toEqual(["'self'", "https://api.example.com"]);
		expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
		expect(page.headers.get("x-frame-options")).toBe("DENY");
	});

	test("only Staff see and change it; each change is in the Audit log", async () => {
		const site = await newSite();
		for (const call of [
			() => editor.api.csp.get({ siteId: site.siteId }),
			() => editor.api.csp.setMode({ siteId: site.siteId, mode: "relaxed" }),
			() => editor.api.csp.addHost({ siteId: site.siteId, host: "tags.example.com" }),
			() => editor.api.csp.removeHost({ siteId: site.siteId, host: "tags.example.com" }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}

		await staff.api.csp.setMode({ siteId: site.siteId, mode: "reportOnly" });
		await staff.api.csp.addHost({ siteId: site.siteId, host: "tags.example.com" });
		await staff.api.csp.removeHost({ siteId: site.siteId, host: "tags.example.com" });
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 10 });
		const ours = entries.filter((entry) => entry.siteId === site.siteId).map((entry) => [entry.action, entry.details]);
		expect(ours.slice(0, 3)).toEqual([
			["allowedHost.remove", { host: "tags.example.com" }],
			["allowedHost.add", { host: "tags.example.com" }],
			["csp.change", { from: "strict", to: "reportOnly" }],
		]);
	});
});

describe("the page checks every Site test uses", () => {
	test("catch inline code, and not escaped text that looks like it", () => {
		for (const html of [
			"<script>go()</script>",
			'<script src="/_wc/js/a.js">go()</script>',
			'<p style="color: red">Hi</p>',
			"<style>p { color: red }</style>",
			'<img src="/a.png" onerror="go()">',
			'<a href="javascript:go()">Go</a>',
		]) {
			expect(() => expectNoInlineCode(html), html).toThrow();
		}
		expectNoInlineCode('<p title="&quot;&gt;&lt;img src=x onerror=go()&gt;">&lt;script&gt;go()&lt;/script&gt;</p>');
		expectNoInlineCode('<script type="application/ld+json">{"@type":"WebPage"}</script>');
	});
});
