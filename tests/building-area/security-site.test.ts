// What the Site's own code may see of the building area (ADR 0037), held to what Edit mode's own
// security tests hold it to. Modules' Site routes answer on the same origin as the building area, so
// they never see its cookies (`webcraft.build` among WebCraft's own), never replace them, and answer
// under WebCraft's policy. Safe mode runs none of the Site's scripts in the building area, nor their
// Drafts that Staff's frame and the HTML pane's preview would otherwise carry; it never reaches
// visitors, and a link that doesn't ask for it ends it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { fakeNpmPackage } from "../harness/fake-npm.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders, policyOf } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";
import { sample } from "../modules/sample/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
const origin = "https://bakery.live.test";
const BUILD_COOKIE = "__Host-webcraft.build";
const SAFE_COOKIE = "__Host-webcraft.safe";

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
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
	// The Site script has a Draft no visitor runs: Staff's frame runs it, unless in Safe mode.
	await staff.api.scripts.saveDraft({ siteId, entryId: null, code: "window.site = 'draft';" });
	fakeNpmPackage(install, "motion-kit", { "1.0.0": { files: { "index.js": "window.motionKit = {};" } } });
	await staff.api.libraries.add({ siteId, library: { source: "npm", packageName: "motion-kit", version: "1.0.0" } });
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

/** Whether HTML names any of the Site's scripts: published, their Drafts, or its Libraries. */
function siteScriptsIn(html: string): string[] {
	return ["/_wc/js/", "/_webcraft/edit/js/", "/_wc/lib/", "data-wc-script", "data-wc-library"].filter((part) =>
		html.includes(part),
	);
}

describe("a Module's Site routes, beside the building area", () => {
	test("never see the building-area cookie, nor the edit cookie, of someone in it, nor replace them", async () => {
		const area = await openBuildingArea(install, staff, siteId);
		const held = new Map(area.browser.cookies);
		expect(held.has(BUILD_COOKIE)).toBe(true);

		const answer = await area.browser.request(`${origin}/_wc/m/sample/cookies`);

		expect(await answer.json()).toEqual({ cookie: null });
		expect(new Map(area.browser.cookies)).toEqual(new Map([...held, ["sample-seen", "1"]]));
		// The session goes on as it was: the shell, and its edit requests.
		expect(shellConfigIn(await (await area.shell(area.landed)).text())?.token).toBeString();
		expect((await area.edit("state", { path: "/" })).status).toBe(200);
	});

	test("never see any of WebCraft's cookies, however they are named", async () => {
		const answer = await install.request(`${origin}/_wc/m/sample/cookies`, {
			headers: {
				cookie: [
					`${BUILD_COOKIE}=%2Fsites`,
					"webcraft.build=%2Fsites",
					"__Host-webcraft.edit=secret",
					`${SAFE_COOKIE}=on`,
					"__Secure-webcraft.session_token=also-secret",
					"theme=dark",
				].join("; "),
			},
		});

		expect(await answer.json()).toEqual({ cookie: "theme=dark" });
	});

	test("answer under WebCraft's policy, never the Module's own, for a browser in the building area", async () => {
		const area = await openBuildingArea(install, staff, siteId);

		const answer = await area.browser.request(`${origin}/_wc/m/sample/page`);

		expect(answer.status).toBe(200);
		expectSiteHeaders(answer);
		const policy = policyOf(answer);
		expect(policy.get("default-src")).toEqual(["'none'"]);
		expect(policy.get("sandbox")).toEqual([]);
		expect(policy.has("script-src")).toBe(false);
	});
});

describe("Safe mode in the building area", () => {
	test("Staff's frame runs none of the Site's scripts, nor their Drafts; outside scripts stay placeholders", async () => {
		const usual = await openBuildingArea(install, staff, siteId);
		expect(siteScriptsIn(await (await usual.page("/")).text())).toContain("/_webcraft/edit/js/");

		const safe = await openBuildingArea(install, staff, siteId, { safeMode: true });
		const html = await (await safe.page("/")).text();

		expect(html).toContain('<meta name="webcraft-safe-mode" content="on">');
		expect(siteScriptsIn(html)).toEqual([]);
		expect(html).not.toContain("widgets.example.com");
		expect(html).toContain('<span class="wc-outside-script-name">Chat widget</span>');
		const missing = await safe.page("/nothing-here");
		expect(missing.status).toBe(404);
		expect(siteScriptsIn(await missing.text())).toEqual([]);
	});

	test("the HTML pane's preview carries none of them either", async () => {
		const usual = await openBuildingArea(install, staff, siteId);
		const shown = (await (await usual.edit("code/preview", { path: "/" })).json()) as { html: string };
		expect(siteScriptsIn(shown.html)).toContain("/_webcraft/edit/js/");

		const safe = await openBuildingArea(install, staff, siteId, { safeMode: true });
		const preview = await safe.edit("code/preview", { path: "/" });

		expect(preview.status).toBe(200);
		const { html } = (await preview.json()) as { html: string };
		expect(siteScriptsIn(html)).toEqual([]);
		expect(html).toContain('<meta name="webcraft-safe-mode" content="on">');
	});

	test("never reaches visitors, whatever cookies they send", async () => {
		const html = await (
			await install.request(`${origin}/`, {
				headers: { cookie: `${SAFE_COOKIE}=on; ${BUILD_COOKIE}=%2Fsites` },
			})
		).text();

		expect(html).toContain("/_wc/js/");
		expect(html).toContain("/_wc/lib/");
		expect(html).toContain("widgets.example.com");
		expect(html).not.toContain("webcraft-safe-mode");
	});

	test("a link into the building area that doesn't ask for it ends it", async () => {
		const safe = await openBuildingArea(install, editor, siteId, { safeMode: true });
		expect(safe.browser.cookies.has(SAFE_COOKIE)).toBe(true);
		expect(siteScriptsIn(await (await safe.page("/")).text())).toEqual([]);

		const { url } = await editor.api.editMode.open({ siteId, building: true });
		const entered = await safe.browser.request(url);

		expect(entered.headers.getSetCookie()).toContain(
			`${SAFE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
		);
		expect(safe.browser.cookies.has(SAFE_COOKIE)).toBe(false);
		const html = await (await safe.page("/")).text();
		expect(html).not.toContain("webcraft-safe-mode");
		expect(html).toContain("/_wc/js/");
	});
});
