// The building area's shell (ADR 0037) on a Site's own address, `/_webcraft/build/page/<path>`: for a
// browser that entered it, the shell document with what it starts from (the session's header token,
// the page to frame, where the logo tile goes back to, its words); for anyone else, a page that sends
// them to the admin. A page of the Site opened at the top level goes into the shell.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
let siteId: string;
let entryId: string;
// Live on its Primary domain, where anyone may ask for the building area's address (the Staging
// address asks everyone it doesn't know to sign in first, before anything else).
const origin = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	entryId = entry.id;
});

afterAll(async () => {
	await install.close();
});

describe("the shell", () => {
	test("starts from the session's header token, the page to frame and the admin address to go back to", async () => {
		const building = await openBuildingArea(install, editor, siteId, {
			open: "/page/blog/fresh-bread",
			returnTo: `/sites/${siteId}/entries`,
		});

		const response = await building.shell("/_webcraft/build/page/blog/fresh-bread");

		expect(response.status).toBe(200);
		const config = shellConfigIn(await response.text());
		expect(config).toMatchObject({
			page: "/blog/fresh-bread",
			returnTo: install.adminUrl(`/sites/${siteId}/entries`),
			language: "en",
			safe: false,
		});
		expect((config?.words as { backToAdmin?: string } | undefined)?.backToAdmin).toBe("Back to the admin");
		// The token opens edit requests for this session, as the editing bar's does.
		const state = await building.edit("state", { path: "/blog/fresh-bread" });
		expect(state.status).toBe(200);
		expect(((await state.json()) as { page: { item: string } }).page.item).toBe(`entry:${entryId}`);
	});

	test("speaks the person's Admin language", async () => {
		await editor.api.me.updatePreferences({ adminLanguage: "it" });
		try {
			const building = await openBuildingArea(install, editor, siteId);
			const html = await (await building.shell("/_webcraft/build/page/")).text();

			expect(html).toContain('<html lang="it" class="dark">');
			expect(shellConfigIn(html)).toMatchObject({ language: "it" });
			expect((shellConfigIn(html)?.words as { backToAdmin?: string } | undefined)?.backToAdmin).toBe("Torna all'admin");
		} finally {
			await editor.api.me.updatePreferences({ adminLanguage: null });
		}
	});

	test("keeps the page's query for the frame", async () => {
		const building = await openBuildingArea(install, editor, siteId);

		const config = shellConfigIn(await (await building.shell("/_webcraft/build/page/blog?page=2")).text());

		expect(config?.page).toBe("/blog?page=2");
	});

	test("its address alone opens the home page", async () => {
		const building = await openBuildingArea(install, editor, siteId);

		for (const address of ["/_webcraft/build", "/_webcraft/build/"]) {
			const response = await building.browser.request(`${origin}${address}`);
			expect(response.status).toBe(303);
			expect(response.headers.get("location")).toBe("/_webcraft/build/page/");
		}
		expect(shellConfigIn(await (await building.shell("/_webcraft/build/page")).text())?.page).toBe("/");
	});

	test("answers only GET, and only the addresses it has", async () => {
		const building = await openBuildingArea(install, editor, siteId);

		const posted = await building.browser.request(`${origin}/_webcraft/build/page/`, { method: "POST" });
		expect(posted.status).toBe(405);
		expect((await building.browser.request(`${origin}/_webcraft/build/elsewhere`)).status).toBe(404);
		expect((await building.browser.request(`${origin}/_webcraft/build/page//evil.example`)).status).toBe(404);
	});
});

describe("someone not in the building area", () => {
	test("without an Edit mode session gets a page that sends them to the admin", async () => {
		const visitor = install.browser({ origin });

		const response = await visitor.request(`${origin}/_webcraft/build/page/blog/fresh-bread`);

		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		const html = await response.text();
		expect(html).toContain("<h1>Open the building area from the admin</h1>");
		const admin = new URL(install.adminUrl(`/sites/${siteId}/build`));
		admin.searchParams.set("open", "/page/blog/fresh-bread");
		expect(html).toContain(`<a href="${admin.toString().replaceAll("&", "&amp;")}">Go to the admin</a>`);
		// Nothing of the session: no token, no shell.
		expect(shellConfigIn(html)).toBeUndefined();
		expect(html).not.toContain("<script");
	});

	test("on the Staging address, is asked to sign in there first, as for any of its addresses", async () => {
		const response = await install.browser().request("https://bakery.sites.test/_webcraft/build/page/");

		expect(response.status).toBe(403);
		expect(shellConfigIn(await response.text())).toBeUndefined();
	});

	test("in Edit mode without having entered the building area gets the same page", async () => {
		const editing = await openEditMode(install, editor, siteId, "/");

		const response = await editing.browser.request(`${origin}/_webcraft/build/page/`);

		expect(response.status).toBe(401);
		expect(shellConfigIn(await response.text())).toBeUndefined();
	});

	test("whose session ended (signed out of the admin) gets it too", async () => {
		const { browser: member } = await install.createMember({ workspaceId, role: "editor" });
		const building = await openBuildingArea(install, member, siteId);
		await member.api.session.signOut();

		const response = await building.browser.request(`${origin}/_webcraft/build/page/`);

		expect(response.status).toBe(401);
	});
});

describe("a page opened at the top level with the building-area cookie", () => {
	test("goes into the shell, at that page", async () => {
		const building = await openBuildingArea(install, editor, siteId);

		const response = await building.page("/blog/fresh-bread?page=1", "document");

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/_webcraft/build/page/blog/fresh-bread?page=1");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("loaded by the frame, or by a client that doesn't say, is the page itself", async () => {
		const building = await openBuildingArea(install, editor, siteId);

		for (const destination of ["iframe", null] as const) {
			const response = await building.page("/blog/fresh-bread", destination);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("<h1 data-wc-item=");
		}
	});

	test("without the cookie, Edit mode opens the page as before", async () => {
		const editing = await openEditMode(install, editor, siteId, "/blog/fresh-bread");

		const response = await editing.browser.request(`${origin}/blog/fresh-bread`, {
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(200);
	});
});
