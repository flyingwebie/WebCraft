// What the Consent banner holds back on visitors' pages (ADR 0020). Pages stay cached and the same
// for every visitor, under the strict policy (ADR 0023): a script in a category other than Necessary
// sits inert in the page (a <template>) until the consent script, a file on the Site's domain, finds
// its category accepted. The banner is in the page, hidden until that script shows it, so without
// JavaScript the page is as it was and nothing held back runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { headOf } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders, policyOf } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with a published home page, a chat widget (Marketing) and a status check (Necessary). */
async function newSite() {
	const slug = `held-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	await goLive(install, siteId);
	const pages = (await editor.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Home" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	await staff.api.outsideScripts.add({
		siteId,
		name: "Chat widget",
		placement: "bodyEnd",
		consentCategory: "marketing",
		source: { kind: "url", url: "https://widgets.example.com/chat.js" },
	});
	await staff.api.outsideScripts.add({
		siteId,
		name: "Status check",
		placement: "head",
		consentCategory: "necessary",
		source: { kind: "url", url: "https://status.example.com/check.js" },
	});
	return { siteId, slug, url: (path: string) => `https://${slug}.live.test${path}` };
}

/** Script tags that run as the page loads: those outside any <template>. */
function liveScripts(html: string): string[] {
	const outside = html.replace(/<template\b[\s\S]*?<\/template>/g, "");
	return [...outside.matchAll(/<script\b[^>]*><\/script>/g)].map((match) => match[0]);
}

/** Script tags held back, by the Consent category of their <template>. */
function heldScripts(html: string): Record<string, string[]> {
	const held: Record<string, string[]> = {};
	for (const [, category = "", content = ""] of html.matchAll(
		/<template data-wc-consent="([a-z]+)"[^>]*>([\s\S]*?)<\/template>/g,
	)) {
		held[category] = [
			...(held[category] ?? []),
			...[...content.matchAll(/<script\b[^>]*><\/script>/g)].map((m) => m[0]),
		];
	}
	return held;
}

/** The consent script a page links: the one live script on the Site's domain besides the Site's own. */
function consentScriptIn(html: string): string | undefined {
	return liveScripts(headOf(html))
		.map((tag) => /src="([^"]+)"/.exec(tag)?.[1] ?? "")
		.find((src) => src.startsWith("/_wc/js/"));
}

/** A `<meta name>`'s content in the page's head. */
function metaIn(html: string, name: string): string | undefined {
	return new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(headOf(html))?.[1];
}

/** What comes right after the skip link: the banner, when the page has one. */
function afterSkipLink(html: string): string {
	return /<a class="wc-skip-link"[^>]*>[^<]*<\/a>\n([\s\S]*)$/.exec(html)?.[1] ?? "";
}

describe("on an Opt-in Site (the default)", () => {
	test("an outside script in Marketing is held back; a Necessary one loads; the page carries the banner and the consent script", async () => {
		const site = await newSite();

		const page = await install.request(site.url("/"));
		const html = await expectSafePage(page.clone());

		expect(heldScripts(html)).toEqual({
			marketing: ['<script src="https://widgets.example.com/chat.js" async></script>'],
		});
		expect(liveScripts(html)).toContain('<script src="https://status.example.com/check.js" async></script>');
		expect(liveScripts(html).join("")).not.toContain("widgets.example.com");
		expect(metaIn(html, "webcraft-consent-mode")).toBe("optIn");
		expect(metaIn(html, "webcraft-consent-version")).toBe("1");
		expect(consentScriptIn(html)).toMatch(/^\/_wc\/js\/[0-9a-f]{16}\.js$/);
		// The banner comes first after the skip link, hidden until the consent script shows it.
		expect(afterSkipLink(html)).toMatch(/^<section class="wc-consent" id="wc-consent" data-layout="bar" [^>]*hidden>/);
		expect(afterSkipLink(html)).toContain(">Accept all</button>");
		expect(afterSkipLink(html)).toContain(">Reject all</button>");
		// The held-back script's host is still allowed, so it can load once accepted.
		expect(policyOf(page).get("script-src")).toContain("https://widgets.example.com");
	});

	test("the Site's stylesheet styles the banner's parts in its base layer, from the Design system's tokens", async () => {
		const site = await newSite();
		const html = await (await install.request(site.url("/"))).text();
		const stylesheet = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1] ?? "";

		const css = await (await install.request(site.url(stylesheet))).text();
		const base = /@layer base \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

		for (const hook of [
			".wc-consent{",
			".wc-consent[data-layout=bar]{",
			".wc-consent[data-layout=box]{",
			".wc-consent[data-layout=dialog]{",
			".wc-consent-button{",
			".wc-consent-settings{",
			".wc-consent-placeholder{",
		]) {
			expect({ hook, styled: base.includes(hook) }).toEqual({ hook, styled: true });
		}
		// Its spacing, corners and shadow follow the Design tokens (and custom CSS can change them).
		expect(base).toContain("--wc-consent-radius:var(--radius-m)");
		expect(base).toContain("--wc-consent-shadow:var(--shadow-l)");
	});

	test("the consent script is a file on the Site's domain, kept for a year", async () => {
		const site = await newSite();
		const html = await (await install.request(site.url("/"))).text();

		const file = await install.request(site.url(consentScriptIn(html) ?? ""));

		expect(file.status).toBe(200);
		expectSiteHeaders(file);
		expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await file.text()).toContain("webcraft:consent");
	});

	test("the page is the same for every visitor, whatever they chose: it comes from the page cache", async () => {
		const site = await newSite();
		const first = await install.request(site.url("/"));
		const chosen = await install.request(
			new Request(site.url("/"), {
				headers: { cookie: "__Host-webcraft.consent=7b0c7a9e-8f61-4d7c-9a51-2b1f3c4d5e6f.1.111" },
			}),
		);

		expect(chosen.headers.get("x-cache")).toBe("HIT");
		expect(chosen.headers.get("etag")).toBe(first.headers.get("etag"));
		expect(await chosen.text()).toBe(await first.text());
	});

	test("a page holding nothing back has no banner and no consent script", async () => {
		const site = await newSite();
		const { outsideScripts } = await staff.api.outsideScripts.list({ siteId: site.siteId });
		const chat = outsideScripts.find((script) => script.name === "Chat widget");
		await staff.api.outsideScripts.remove({ siteId: site.siteId, outsideScriptId: chat?.id as string });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(html).not.toContain("<template");
		expect(html).not.toContain("wc-consent");
		expect(metaIn(html, "webcraft-consent-mode")).toBeUndefined();
		expect(consentScriptIn(html)).toBeUndefined();
	});
});

describe("other modes", () => {
	test("Opt-out holds back too, so a visitor who declined never runs it: the consent script lets it load until then", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optOut", layout: "box" });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(heldScripts(html)).toEqual({
			marketing: ['<script src="https://widgets.example.com/chat.js" async></script>'],
		});
		expect(metaIn(html, "webcraft-consent-mode")).toBe("optOut");
		expect(metaIn(html, "webcraft-consent-version")).toBe("2");
		expect(afterSkipLink(html)).toMatch(/^<section class="wc-consent" id="wc-consent" data-layout="box" /);
	});

	test("the dialog layout is a modal <dialog>, closed until the consent script opens it", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optIn", layout: "dialog" });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(afterSkipLink(html)).toMatch(
			/^<dialog class="wc-consent" id="wc-consent" data-layout="dialog" aria-labelledby="wc-consent-title">/,
		);
	});

	test("with None, nothing is held back: outside scripts load as they are, with no banner and no consent script", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(heldScripts(html)).toEqual({});
		expect(liveScripts(html)).toContain('<script src="https://widgets.example.com/chat.js" async></script>');
		expect(html).not.toContain("wc-consent");
		expect(consentScriptIn(html)).toBeUndefined();
	});

	test("with an outside consent service, WebCraft shows no banner of its own: the consent script reads the service's answer", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "outside", layout: "bar" });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(heldScripts(html)).toEqual({
			marketing: ['<script src="https://widgets.example.com/chat.js" async></script>'],
		});
		expect(metaIn(html, "webcraft-consent-mode")).toBe("outside");
		expect(consentScriptIn(html)).toBeDefined();
		expect(html).not.toContain('id="wc-consent"');
	});

	test("a change to the setting reaches cached pages at once", async () => {
		const site = await newSite();
		await install.request(site.url("/"));

		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
		const page = await install.request(site.url("/"));

		expect(page.headers.get("x-cache")).toBe("MISS");
		expect(heldScripts(await page.text())).toEqual({});
	});
});

/** A published Note at /notes/first whose body shows a video. */
async function withVideo(siteId: string): Promise<void> {
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
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "First",
		slug: "first",
		fields: { body: [{ type: "video", url: "https://vimeo.com/76979871", title: "Our ovens" }] },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
}

/** The page's <main>. */
function mainOf(html: string): string {
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

describe("a body's video", () => {
	test("is held back as Media: its link stays for browsers without JavaScript, with a labelled placeholder offering to load it", async () => {
		const site = await newSite();
		await withVideo(site.siteId);

		const page = await install.request(site.url("/notes/first"));
		const html = await expectSafePage(page.clone());

		expect(mainOf(html)).toBe(
			[
				'<article><h1>First</h1><figure class="wc-embed" data-wc-consent="media">',
				'<a href="https://vimeo.com/76979871" data-wc-embed="https://player.vimeo.com/video/76979871?autoplay=1&amp;dnt=1" data-wc-title="Our ovens">Play video: Our ovens</a>',
				'<div class="wc-consent-placeholder" hidden>',
				'<p class="wc-consent-placeholder-title" id="wc-held-1"><strong>Our ovens</strong> · vimeo.com</p>',
				"<p>This content comes from another site, which may set cookies or learn about your visit.</p>",
				'<div class="wc-consent-placeholder-actions">',
				'<button type="button" class="wc-consent-button" data-wc-consent-action="load" aria-describedby="wc-held-1">Load content</button>',
				'<label class="wc-consent-remember"><input type="checkbox" data-wc-consent-remember> Always load Media content</label>',
				"</div></div></figure></article>",
			].join(""),
		);
		expect(consentScriptIn(html)).toBeDefined();
		expect(afterSkipLink(html)).toStartWith('<section class="wc-consent"');
		// Once loaded, the player comes from its own site, as without a banner.
		expect(policyOf(page).get("frame-src")).toContain("https://player.vimeo.com");
	});

	test("on a page asking nothing else, the video alone brings the banner and the consent script", async () => {
		const site = await newSite();
		await withVideo(site.siteId);
		const { outsideScripts } = await staff.api.outsideScripts.list({ siteId: site.siteId });
		for (const script of outsideScripts) {
			await staff.api.outsideScripts.remove({ siteId: site.siteId, outsideScriptId: script.id });
		}

		const html = await expectSafePage(await install.request(site.url("/notes/first")));

		expect(heldScripts(html)).toEqual({});
		expect(consentScriptIn(html)).toBeDefined();
		expect(html).toContain('data-wc-consent="media"');
	});

	test("with None, it is its link alone", async () => {
		const site = await newSite();
		await withVideo(site.siteId);
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });

		const html = await expectSafePage(await install.request(site.url("/notes/first")));

		expect(mainOf(html)).toBe(
			'<article><h1>First</h1><figure class="wc-embed"><a href="https://vimeo.com/76979871" data-wc-embed="https://player.vimeo.com/video/76979871?autoplay=1&amp;dnt=1" data-wc-title="Our ovens">Play video: Our ovens</a></figure></article>',
		);
	});

	test("in Edit mode, it is its link alone: people editing aren't asked", async () => {
		const site = await newSite();
		await withVideo(site.siteId);
		const editing = await openEditMode(install, staff, site.siteId, "/notes/first");

		const html = await expectSafePage(await editing.page("/notes/first"), "editMode");

		expect(html).not.toContain("data-wc-consent");
		expect(html).not.toContain("wc-consent-placeholder");
	});
});

describe("in Edit mode", () => {
	test("there is no banner and no consent script: outside scripts show their placeholders, as always", async () => {
		const site = await newSite();
		const editing = await openEditMode(install, staff, site.siteId, "/");

		const html = await expectSafePage(await editing.page("/"), "editMode");

		expect(html).not.toContain('id="wc-consent"');
		expect(html).not.toContain("<template");
		expect(metaIn(html, "webcraft-consent-mode")).toBeUndefined();
		expect(html).toContain('data-wc-outside-script="');
		expect(liveScripts(html).join("")).not.toContain("widgets.example.com");
	});
});
