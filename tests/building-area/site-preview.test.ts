// "Preview on the site" (FX-04): the bottom bar opens the page shown in a new tab, as visitors will see
// it once its Drafts are published, or as they see it now where nothing shows the Drafts. A browser in
// the building area has its pages go into the shell, so the page carries `?wc-visitor`: on the Staging
// address it is then the page with every Draft published, on a domain the published page, never Edit
// mode's page (no agent, no tags). The shell's document says which one its button opens, and how.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BUILDING_VISITOR_PARAMETER } from "@webcraft/core";

import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let stagingSiteId: string;
let liveSiteId: string;

/** A Site whose page `/menu` is published as "Fresh bread", its Draft since saying "Rye on Fridays". */
async function siteWithDraft(workspaceId: string, slug: string): Promise<string> {
	const siteId = (await install.createSite(workspaceId, { name: `Bakery ${slug}`, slug })).id;
	const site = await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "Fresh bread",
		slug: "menu",
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Rye on Fridays" });
	return siteId;
}

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).browser;
	stagingSiteId = await siteWithDraft(workspaceId, "bakery");
	liveSiteId = await siteWithDraft(workspaceId, "rye");
	await goLive(install, liveSiteId);
});

afterAll(async () => {
	await install.close();
});

describe("Preview on the site", () => {
	test("on the Staging address, the page with its Drafts, on the shell's own address", async () => {
		const building = await openBuildingArea(install, staff, stagingSiteId);
		const config = shellConfigIn(await (await building.shell(building.landed)).text());
		expect(config?.preview).toEqual({ draft: true, staging: null });

		// Without the parameter, a page opened at the top level goes into the shell.
		const plain = await building.page("/menu", "document");
		expect(plain.status).toBe(303);
		expect(plain.headers.get("location")).toContain("/_webcraft/build/page/menu");

		const shown = await building.page(`/menu?${BUILDING_VISITOR_PARAMETER}=`, "document");
		expect(shown.status).toBe(200);
		const html = await shown.text();
		expect(html).toContain("Rye on Fridays");
		// As a visitor of the Staging address sees it: no agent, no tags.
		expect(html).not.toContain("/_webcraft/edit/assets/agent-");
		expect(html).not.toContain("data-wc-code");
		expect(html).not.toContain("data-wc-item");
	});

	test("on a domain, the admin's hand-off to the Staging address; the parameter there shows the published page", async () => {
		const building = await openBuildingArea(install, staff, liveSiteId);
		const config = shellConfigIn(await (await building.shell(building.landed)).text());
		expect(config?.preview).toEqual({ draft: true, staging: install.adminUrl(`/staging/${liveSiteId}`) });

		const shown = await building.page(`/menu?${BUILDING_VISITOR_PARAMETER}=`, "document");
		expect(shown.status).toBe(200);
		const html = await shown.text();
		expect(html).toContain("Fresh bread");
		expect(html).not.toContain("Rye on Fridays");
		expect(html).not.toContain("/_webcraft/edit/assets/agent-");
	});

	test("the parameter changes nothing for a visitor", async () => {
		const building = await openBuildingArea(install, staff, liveSiteId);
		const outside = install.browser({ origin: building.origin });
		const page = await outside.request(new URL(`/menu?${BUILDING_VISITOR_PARAMETER}=`, building.origin));
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Fresh bread");
		expect(html).not.toContain("Rye on Fridays");
	});
});
