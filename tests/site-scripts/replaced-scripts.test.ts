// Script files are named by their hash and kept by browsers for a year: a page loaded just before a
// publish still asks for the Site script the publish replaced. Like replaced stylesheets, replaced
// script files are still served for 30 days, then forgotten.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
const origin = "https://bakery.sites.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "Home",
		slug: "home",
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
});

afterAll(async () => {
	await install.close();
});

/** The Site script a page loads. */
async function siteScriptOf(): Promise<string> {
	const html = await (await install.request(`${origin}/`)).text();
	return /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer><\/script>/.exec(html)?.[1] ?? "";
}

test("a Site script a publish replaced is still served for 30 days, then forgotten", async () => {
	const { script } = await staff.api.scripts.saveDraft({ siteId, entryId: null, code: "window.version = 1;" });
	await staff.api.scripts.publish({ siteId, scriptId: script.id });
	const first = await siteScriptOf();

	await staff.api.scripts.saveDraft({ siteId, entryId: null, code: "window.version = 2;" });
	await staff.api.scripts.publish({ siteId, scriptId: script.id });
	const second = await siteScriptOf();
	expect(second).not.toBe(first);

	const old = await install.request(`${origin}${first}`);
	expect(old.status).toBe(200);
	expect(old.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
	expect(await old.text()).toBe("window.version = 1;");

	await install.clock.advance(31 * 24 * 60 * 60 * 1000);
	expect((await install.drainJobs()).failed).toEqual([]);
	expect((await install.request(`${origin}${first}`)).status).toBe(404);
	expect(await (await install.request(`${origin}${second}`)).text()).toBe("window.version = 2;");
});
