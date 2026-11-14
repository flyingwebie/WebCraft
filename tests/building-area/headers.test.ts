// What the building area (ADR 0037) is served with. The shell is WebCraft's own code only: hashed
// files from the Site's address, a policy of its own, framed by nobody, running none of the Site's
// scripts. The pages its frame shows are Edit mode's pages, with the page agent first instead of the
// editing bar, and may be framed by their own origin (and no other); without the building-area cookie
// they are exactly what they are today.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { codeTagsIn, headOf } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { fakeNpmPackage } from "../harness/fake-npm.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
const origin = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "Home",
		slug: "home",
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	for (const [entryId, code] of [
		[null, "window.site = true;"],
		[entry.id, "window.page = true;"],
	] as const) {
		const { script } = await staff.api.scripts.saveDraft({ siteId, entryId, code });
		await staff.api.scripts.publish({ siteId, scriptId: script.id });
	}
	fakeNpmPackage(install, "motion-kit", { "1.0.0": { files: { "index.js": "window.motionKit = {};" } } });
	await staff.api.libraries.add({ siteId, library: { source: "npm", packageName: "motion-kit", version: "1.0.0" } });
	await staff.api.outsideScripts.add({
		siteId,
		name: "Chat widget",
		placement: "bodyEnd",
		consentCategory: "marketing",
		source: { kind: "url", url: "https://widgets.example.com/chat.js" },
	});
	await staff.api.csp.addHost({ siteId, host: "api.example.com" });
});

afterAll(async () => {
	await install.close();
});

/** The script tags of a page's <head>, in order. */
function headScripts(html: string): string[] {
	return [...headOf(html).matchAll(/<script\b[^>]*><\/script>/g)].map((match) => match[0]);
}

/** Every header of an answer but the ones that change on each request. */
function steadyHeaders(response: Response): Record<string, string> {
	const headers = Object.fromEntries(response.headers);
	delete headers["x-request-id"];
	delete headers["set-cookie"];
	return headers;
}

describe("the shell", () => {
	let building: BuildingAreaBrowser;

	beforeAll(async () => {
		building = await openBuildingArea(install, staff, siteId);
	});

	test("has a policy of its own: WebCraft's files from the Site's address, nothing inline, framed by nobody", async () => {
		const response = await building.shell("/_webcraft/build/page/");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			[
				"default-src 'self'",
				"script-src 'self'",
				"style-src 'self'",
				"font-src 'self'",
				"img-src 'self' data: https:",
				"connect-src 'self' wss://bakery.live.test",
				"frame-src 'self'",
				"frame-ancestors 'none'",
				"base-uri 'none'",
				"object-src 'none'",
				"form-action 'self'",
			].join("; "),
		);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("runs none of the Site's scripts: only its own module, and no inline code", async () => {
		const html = await (await building.shell("/_webcraft/build/page/")).text();

		expect(html).not.toContain("data-wc-script");
		expect(html).not.toContain("data-wc-library");
		expect(html).not.toContain("widgets.example.com");
		const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
		expect(scripts).toEqual([
			expect.stringMatching(/^<script type="module" src="\/_webcraft\/edit\/assets\/shell-[0-9a-f]{16}\.js">$/),
			// Its data: a JSON block, which no browser runs.
			'<script type="application/json" id="webcraft-building-area-config">',
		]);
		expect(html).not.toMatch(/\son[a-z]+=/i);
		expect(html).not.toMatch(/\sstyle=/i);
	});

	test("its files are hashed and kept a year, its font served from the Site's address", async () => {
		const html = await (await building.shell("/_webcraft/build/page/")).text();
		const script = /src="(\/_webcraft\/edit\/assets\/shell-[0-9a-f]{16}\.js)"/.exec(html)?.[1] ?? "";
		const styles = /href="(\/_webcraft\/edit\/assets\/shell-[0-9a-f]{16}\.css)"/.exec(html)?.[1] ?? "";

		for (const [path, type] of [
			[script, "text/javascript; charset=utf-8"],
			[styles, "text/css; charset=utf-8"],
		] as const) {
			const file = await install.browser({ origin }).request(`${origin}${path}`);
			expect(file.status).toBe(200);
			expect(file.headers.get("content-type")).toBe(type);
			expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		}
		const css = await (await install.browser({ origin }).request(`${origin}${styles}`)).text();
		const font = /url\((\/_webcraft\/edit\/assets\/inter-[0-9a-f]{16}\.woff2)\)/.exec(css)?.[1] ?? "";
		const fontFile = await install.browser({ origin }).request(`${origin}${font}`);
		expect(fontFile.status).toBe(200);
		expect(fontFile.headers.get("content-type")).toBe("font/woff2");
	});
});

describe("a page shown in the building area's frame", () => {
	let building: BuildingAreaBrowser;

	beforeAll(async () => {
		building = await openBuildingArea(install, editor, siteId);
	});

	test("has the page agent first in its head instead of the editing bar, then the Site's own scripts", async () => {
		const response = await building.page("/");
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).not.toContain("<webcraft-edit-bar");
		expect(html).not.toMatch(/\/_webcraft\/edit\/assets\/(bar|code|page)-/);
		const scripts = headScripts(html);
		expect(scripts[0]).toMatch(/^<script src="\/_webcraft\/edit\/assets\/agent-[0-9a-f]{16}\.js"><\/script>$/);
		expect(scripts.slice(1)).toEqual([
			expect.stringMatching(/data-wc-library="motion-kit"/),
			expect.stringMatching(/data-wc-script="site"/),
			expect.stringMatching(/data-wc-script="page"/),
		]);
		// An outside script never runs in Edit mode: it shows as a placeholder.
		expect(html).not.toContain("https://widgets.example.com/chat.js");
		expect(html).toContain('<aside class="wc-outside-scripts"');
		expect(headOf(html)).toMatch(/<link rel="stylesheet" href="\/_webcraft\/edit\/assets\/agent-[0-9a-f]{16}\.css">/);
		expect(headOf(html)).toContain(`<meta name="webcraft-edit-token" content="${await building.headerToken()}">`);
	});

	test("may be framed by its own origin, and by no other; the rest of Edit mode's policy stands", async () => {
		const framed = await building.page("/");
		const plain = await (await openEditMode(install, editor, siteId, "/")).page("/");

		expect(framed.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		const policy = framed.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("frame-ancestors 'self'");
		expect(policy).not.toContain("frame-ancestors 'none'");
		expect(policy).toBe(
			(plain.headers.get("content-security-policy") ?? "").replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
		);
		expect(policy).toContain("connect-src 'self' https://api.example.com");
		const { "x-frame-options": framing, "content-security-policy": _framed, ...rest } = steadyHeaders(framed);
		const { "x-frame-options": _plainFraming, "content-security-policy": _plain, ...plainRest } = steadyHeaders(plain);
		expect(framing).toBe("SAMEORIGIN");
		expect(rest).toEqual(plainRest);
		expect(rest["cache-control"]).toBe("no-store");
	});

	test("a page with no page there is framed the same way", async () => {
		const response = await building.page("/no-such-page");

		expect(response.status).toBe(404);
		expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
		expect(headScripts(await response.text())[0]).toMatch(/\/_webcraft\/edit\/assets\/agent-[0-9a-f]{16}\.js/);
	});

	test("in Safe mode it runs none of the Site's own scripts; the agent still runs", async () => {
		const safe = await openBuildingArea(install, editor, siteId, { safeMode: true });
		const html = await (await safe.page("/")).text();

		const scripts = headScripts(html);
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/\/_webcraft\/edit\/assets\/agent-[0-9a-f]{16}\.js/);
		expect(html).not.toContain("data-wc-script");
		expect(html).not.toContain("data-wc-library");
		expect(html).toContain('<meta name="webcraft-safe-mode" content="on">');
	});

	test("Code mode's cookie changes nothing in it: the agent, never Code mode's script", async () => {
		const staffBuilding = await openBuildingArea(install, staff, siteId);
		const before = await (await staffBuilding.page("/")).text();
		expect((await staffBuilding.edit("code/start")).status).toBe(200);

		const html = await (await staffBuilding.page("/")).text();

		expect(html).not.toContain('<meta name="webcraft-code-mode" content="on">');
		// Staff's frame tags every element (BA-08), with the cookie or without it.
		expect(codeTagsIn(html)).toEqual(codeTagsIn(before));
		expect(headScripts(html)[0]).toMatch(/\/_webcraft\/edit\/assets\/agent-/);
	});
});

describe("without the building-area cookie", () => {
	test("a page in Edit mode is served exactly as before: the editing bar, never framed", async () => {
		const editing = await openEditMode(install, editor, siteId, "/");

		const response = await editing.page("/");

		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		const html = await response.text();
		expect(headScripts(html)[0]).toMatch(/\/_webcraft\/edit\/assets\/bar-[0-9a-f]{16}\.js/);
		expect(html).not.toContain("/_webcraft/edit/assets/agent-");
	});
});
