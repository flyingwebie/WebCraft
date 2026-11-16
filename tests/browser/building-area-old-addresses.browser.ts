// The old visual builder's addresses (`/builder/<site>/…`, BA-29), kept for links and bookmarks made
// before the building area: each opens the building area on the same Template or Component, with the
// Entry it previewed and the element it selected; one that names no document is not found.
import { afterAll, beforeAll, expect, test } from "bun:test";

import en from "../../apps/server/src/messages/en.json" with { type: "json" };
import type { TestAccount } from "../harness/index.ts";
import { frameOf } from "./building-area.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;
let componentId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace()).id;
	siteId = (await local.createSite(workspaceId, { slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<article><h1 data-wc-id="headline">{{ title }}</h1></article>',
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	entryId = (await api.entries.create({ siteId, postTypeId, title: "Fresh bread" })).entry.id;
	const { component } = await api.components.create({ siteId, name: "Card" });
	componentId = component.id;
	await api.components.saveMarkup({ siteId, componentId, markup: "<div><h2>Card title</h2></div>" });
	await api.components.publish({ siteId, componentId });
});

afterAll(async () => {
	await install.close();
});

test("an old Template address opens the building area on it, the Entry previewed and the element selected", async () => {
	const page = await install.newPage("light");
	await install.signIn(page, staff);
	await page.goto(
		install.adminUrl(
			`/builder/${siteId}/entry-template/${postTypeId}?entry=${entryId}&element=headline&returnPath=/sites/${siteId}/templates`,
		),
	);
	await page.waitForURL((url) => url.pathname === `/_webcraft/build/entry-template/${postTypeId}`);
	const frame = await frameOf(page);
	await frame.getByText("Fresh bread").waitFor();
	// The element is selected once the page is shown: the address says so.
	await page.waitForURL((url) => url.searchParams.get("wc-select") === "content#headline");
	expect(new URL(page.url()).searchParams.get("entry")).toBe(entryId);
	await page.close();
});

test("an old Site template or Component address opens the building area on it", async () => {
	const page = await install.newPage("light");
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/site-template`));
	await page.waitForURL((url) => url.pathname === "/_webcraft/build/site-template");
	await frameOf(page);
	await page.goto(install.adminUrl(`/builder/${siteId}/component/${componentId}`));
	await page.waitForURL((url) => url.pathname === `/_webcraft/build/component/${componentId}`);
	await (await frameOf(page)).getByText("Card title").waitFor();
	await page.close();
});

test("an old address that names no document is not found", async () => {
	const page = await install.newPage("light");
	await install.signIn(page, staff);
	for (const rest of ["", "nothing-here", "page/blog/fresh-bread"]) {
		await page.goto(install.adminUrl(`/builder/${siteId}/${rest}`));
		await page.getByRole("heading", { name: en.notFound.heading }).waitFor();
		expect(new URL(page.url()).pathname).toBe(`/builder/${siteId}/${rest}`.replace(/\/$/, ""));
	}
	await page.close();
});
