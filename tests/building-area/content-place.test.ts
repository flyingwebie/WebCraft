// The Content place's ground on the server (ADR 0037, BA-20): the shell starts from the Site's
// languages and its address in the admin; a place's view (`wc-view`) is the shell's, never the page's;
// and the Globals' Draft is saved from the Site's address, by a Member as by Staff, as in the admin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { buildingAreaApi } from "../harness/building-area-api.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await staff.api.languages.add({ siteId, code: "it" });
	await staff.api.globals.setFields({
		siteId,
		fields: [
			{ key: "phone", label: "Phone", type: "text" },
			{
				key: "hours",
				label: "Opening hours",
				type: "group",
				fields: [{ key: "weekdays", label: "Weekdays", type: "text" }],
			},
		],
	});
});

afterAll(async () => {
	await install.close();
});

describe("the Content place's ground", () => {
	test("the shell starts from the Site's languages, Default first, and the Site in the admin", async () => {
		const building = await openBuildingArea(install, staff, siteId);
		const config = shellConfigIn(await (await building.shell(building.landed)).text());

		expect(config?.languages).toEqual({
			default: "en",
			all: [
				{ code: "en", name: expect.any(String) },
				{ code: "it", name: expect.any(String) },
			],
		});
		expect(config?.admin).toBe(install.adminUrl(`/sites/${siteId}`));
	});

	test("a place's view stays the shell's: the page framed keeps only its own query", async () => {
		const building = await openBuildingArea(install, staff, siteId);
		const response = await building.shell(
			"/_webcraft/build/page/menu?sort=price&wc-place=content%2Fpages&wc-view=q%3Drye%26sort%3Dtitle",
		);

		expect(response.status).toBe(200);
		expect(shellConfigIn(await response.text())?.page).toBe("/menu?sort=price");
	});

	test("the Globals place is an address of the shell", async () => {
		const building = await openBuildingArea(install, staff, siteId);
		for (const place of ["content%2Fglobals", "content%2Fglobals%2Fhours"]) {
			const response = await building.shell(`/_webcraft/build/page/?wc-place=${place}`);
			expect(response.status).toBe(200);
			expect(shellConfigIn(await response.text())?.page).toBe("/");
		}
	});

	test("a Member saves the Globals' Draft from the Site's address, and a Group's values with it", async () => {
		const area = buildingAreaApi(install, await openBuildingArea(install, editor, siteId));

		const { globals } = await area.api.globals.saveDraft({
			siteId,
			fields: { phone: "+353 21 000 0000", hours: { weekdays: "8–18" } },
		});

		expect(globals.draft).toMatchObject({ phone: "+353 21 000 0000", hours: { weekdays: "8–18" } });
		// The same Draft as in the admin, and nothing published.
		const read = (await staff.api.globals.get({ siteId })).globals;
		expect(read.draft).toMatchObject({ phone: "+353 21 000 0000", hours: { weekdays: "8–18" } });
		expect(read.published).toBeNull();
	});
});
