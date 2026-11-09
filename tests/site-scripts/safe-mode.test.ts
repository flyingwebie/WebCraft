// Safe mode (ADR 0022): Edit mode with none of the Site's own scripts (no Libraries, no Site script,
// no page script), so a broken script can never lock anyone out of editing. It opens from the admin's
// "Edit on site" menu (a link that says so) or from the editing bar, and lasts for the browser's Edit
// mode session. Outside scripts never run in Edit mode at all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { headOf } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { fakeNpmPackage } from "../harness/fake-npm.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let library: { src: string };
const origin = "https://bakery.sites.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
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
	library = (
		await staff.api.libraries.add({ siteId, library: { source: "npm", packageName: "motion-kit", version: "1.0.0" } })
	).library;
	await staff.api.outsideScripts.add({
		siteId,
		name: "Chat widget",
		placement: "bodyEnd",
		consentCategory: "marketing",
		source: { kind: "url", url: "https://widgets.example.com/chat.js" },
	});
});

afterAll(async () => {
	await install.close();
});

/** The script tags of a page's <head>, in order. */
function headScripts(html: string): string[] {
	return [...headOf(html).matchAll(/<script\b[^>]*><\/script>/g)].map((match) => match[0]);
}

/** Whether a page in Edit mode says it is in Safe mode, for the editing bar. */
function inSafeMode(html: string): boolean {
	return html.includes('<meta name="webcraft-safe-mode" content="on">');
}

describe("Edit mode", () => {
	test("runs the Site's own scripts and Libraries, each saying what it is, so the bar can name one that fails", async () => {
		const editing = await openEditMode(install, editor, siteId, "/");
		const html = await expectSafePage(await editing.page("/"), "editMode");

		const scripts = headScripts(html);
		expect(scripts[0]).toMatch(/^<script src="\/_webcraft\/edit\/assets\/bar-[0-9a-f]{16}\.js"><\/script>$/);
		expect(scripts.slice(1)).toEqual([
			`<script src="${library.src}" integrity="${(await staff.api.libraries.list({ siteId })).libraries[0]?.integrity}" defer data-wc-library="motion-kit"></script>`,
			expect.stringMatching(/^<script src="\/_wc\/js\/[0-9a-f]{16}\.js" defer data-wc-script="site"><\/script>$/),
			expect.stringMatching(/^<script src="\/_wc\/js\/[0-9a-f]{16}\.js" defer data-wc-script="page"><\/script>$/),
		]);
		expect(inSafeMode(html)).toBe(false);
	});
});

describe("Safe mode", () => {
	test("opened from the admin, Edit mode runs none of the Site's own scripts; WebCraft's still run", async () => {
		const { url } = await editor.api.editMode.open({ siteId, path: "/", safeMode: true });
		expect(new URL(url).searchParams.get("safe")).toBe("1");

		const editing = await openEditMode(install, editor, siteId, "/", { safeMode: true });
		const html = await expectSafePage(await editing.page("/"), "editMode");

		expect(inSafeMode(html)).toBe(true);
		expect(headScripts(html)).toEqual([
			expect.stringMatching(/^<script src="\/_webcraft\/edit\/assets\/bar-[0-9a-f]{16}\.js"><\/script>$/),
		]);
		expect(html).not.toContain("/_wc/lib/");
		expect(html).not.toContain("/_wc/js/");
		// Outside scripts never run in Edit mode: their placeholders still show.
		expect(html).toContain('<span class="wc-outside-script-name">Chat widget</span>');
		// The 404 page too.
		const missing = await editing.page("/nothing-here");
		expect(missing.status).toBe(404);
		expect(await missing.text()).not.toContain("/_wc/js/");
	});

	test("the editing bar turns it on and off for this browser's Edit mode session", async () => {
		const editing = await openEditMode(install, staff, siteId, "/");
		expect(inSafeMode(await (await editing.page("/")).text())).toBe(false);

		const started = await editing.edit("safe/start");
		expect(started.status).toBe(200);
		expect(await started.json()).toEqual({ safe: true });
		expect(started.headers.get("set-cookie")).toMatch(
			/^__Host-webcraft\.safe=on; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/,
		);
		const safe = await (await editing.page("/")).text();
		expect(inSafeMode(safe)).toBe(true);
		expect(safe).not.toContain("/_wc/js/");

		const stopped = await editing.edit("safe/stop");
		expect(await stopped.json()).toEqual({ safe: false });
		const again = await (await editing.page("/")).text();
		expect(inSafeMode(again)).toBe(false);
		expect(again).toContain("/_wc/js/");
	});

	test("in Code mode it runs none of the scripts' Drafts either", async () => {
		const editing = await openEditMode(install, staff, siteId, "/");
		await editing.edit("code/start");
		await editing.edit("safe/start");

		const html = await (await editing.page("/")).text();
		expect(html).toContain('<meta name="webcraft-code-mode" content="on">');
		expect(inSafeMode(html)).toBe(true);
		expect(html).not.toContain("/_webcraft/edit/js/");
		expect(html).not.toContain("/_wc/lib/");
	});

	test("asking for it needs a page in Edit mode, as every edit request does", async () => {
		const editing = await openEditMode(install, editor, siteId, "/");
		expect((await editing.edit("safe/start", {}, { headerToken: null })).status).toBe(403);
		expect((await editing.edit("safe/start", {}, { origin: "https://elsewhere.example" })).status).toBe(403);
	});

	test("never reaches visitors, and an ordinary link ends it", async () => {
		const html = await (await install.request(`${origin}/`, { headers: { cookie: "__Host-webcraft.safe=on" } })).text();
		expect(html).toContain("/_wc/js/");
		expect(html).toContain("widgets.example.com");

		const editing = await openEditMode(install, editor, siteId, "/", { safeMode: true });
		expect(inSafeMode(await (await editing.page("/")).text())).toBe(true);
		const { url } = await editor.api.editMode.open({ siteId, path: "/" });
		const entered = await editing.browser.request(url);
		expect(entered.headers.get("set-cookie")).toContain("__Host-webcraft.safe=; Path=/; Max-Age=0");
		expect(inSafeMode(await (await editing.page("/")).text())).toBe(false);
	});
});
