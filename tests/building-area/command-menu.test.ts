// What the building area's Command menu draws by (BA-10): `builder.commandMenu` on the Site's address
// answers each person the Permissions they hold (`can()`, never a role name) and Go to's lists. Staff
// get Structure (the Site's Components, Templates); a Member gets Pages and Entries only; an Author
// holds no `entry.publish` (Send for review instead of Publish). The server still refuses a Member
// what the menu leaves out: making a Component from the Site's address.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea } from "../harness/building-area.ts";
import { buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	await staff.api.components.create({ siteId, name: "HeroSplit" });
	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id;
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pagesId ?? "", title: "Menu", slug: "menu" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install.close();
});

/** What the Command menu reads as it opens, from the Site's address, for a person in the building area. */
async function menuFor(person: TestBrowser) {
	const area = buildingAreaApi(install, await openBuildingArea(install, person, siteId));
	return { area, data: await area.api.builder.commandMenu({ siteId }) };
}

describe("the building area's Command menu, by Permission", () => {
	test("Staff hold Structure: the Site's Components are in Go to and Insert", async () => {
		const { data } = await menuFor(staff);
		expect(data.permissions).toContain("structure.edit");
		expect(data.permissions).toContain("entry.publish");
		expect(data.components.map((each) => each.name)).toContain("HeroSplit");
		expect(data.pages.map((each) => each.path)).toContain("/menu");
	});

	test("a Member gets Pages and Entries, no Structure; the server refuses making a Component", async () => {
		const { area, data } = await menuFor(editor);
		expect(data.permissions).not.toContain("structure.edit");
		expect(data.permissions).toContain("entry.edit");
		expect(data.permissions).toContain("entry.publish");
		expect(data.components).toEqual([]);
		expect(data.pages.map((each) => each.path)).toContain("/menu");

		const refused = await refusalOf(await area.call("components.create", { siteId, name: "Section1" }));
		expect(refused.status).toBe(403);
		expect((await staff.api.components.list({ siteId })).components.map((each) => each.name)).not.toContain("Section1");
	});

	test("an Author holds no entry.publish: their menu offers Send for review", async () => {
		const { data } = await menuFor(author);
		expect(data.permissions).toContain("entry.edit");
		expect(data.permissions).not.toContain("entry.publish");
		expect(data.permissions).not.toContain("structure.edit");
	});
});
