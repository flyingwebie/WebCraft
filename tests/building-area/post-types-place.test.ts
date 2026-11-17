// The Content place's Post Types and Fields on the server (ADR 0037, BA-21): Staff create, change and
// delete Post Types from the Site's address through the Management API there, as in the admin; a
// Member is refused (Structure), and the place's addresses (a Post Type's Fields and Settings) are the
// shell's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildingAreaApi } from "../harness/building-area-api.ts";
import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

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
});

afterAll(async () => {
	await install.close();
});

describe("Post Types from the Site's address", () => {
	test("Staff create a Post Type, add and reorder its Fields, rename it and delete it", async () => {
		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));

		const { postType } = await area.api.postTypes.create({
			siteId,
			name: "Team",
			key: "team",
			urlPattern: "/team/{slug}",
		});
		const fields = [
			{ key: "role", label: "Role", type: "text" as const },
			{ key: "photo", label: "Photo", type: "media" as const },
		];
		await area.api.postTypes.update({ siteId, postTypeId: postType.id, fields });
		const { postType: changed } = await area.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			name: "Our team",
			fields: [fields[1], fields[0]].map((field) => ({ ...field })) as typeof fields,
		});
		expect(changed.name).toBe("Our team");
		expect(changed.fields.map((field) => field.key)).toEqual(["photo", "role"]);
		// The admin reads the same Post Type.
		expect((await staff.api.postTypes.get({ siteId, postTypeId: postType.id })).postType.name).toBe("Our team");

		const first = await area.api.postTypes.delete({ siteId, postTypeId: postType.id });
		if (first.deleted) throw new Error("deleted on the first call");
		expect(first).toMatchObject({ entries: 0, templates: 0 });
		expect(
			await area.api.postTypes.delete({ siteId, postTypeId: postType.id, confirmation: first.confirmation.id }),
		).toEqual({ deleted: true, entries: 0, templates: 0 });
		expect((await staff.api.postTypes.list({ siteId })).postTypes.map((each) => each.id)).not.toContain(postType.id);
	});

	test("a Member can't create, change or delete a Post Type there: it is Structure", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Events", urlPattern: "/events/{slug}" });
		const area = buildingAreaApi(install, await openBuildingArea(install, editor, siteId));

		expect(
			await rejection(area.api.postTypes.create({ siteId, name: "Leaked", urlPattern: "/leaked/{slug}" })),
		).toMatchObject({ code: "FORBIDDEN" });
		expect(
			await rejection(area.api.postTypes.update({ siteId, postTypeId: postType.id, name: "Renamed" })),
		).toMatchObject({ code: "FORBIDDEN" });
		expect(await rejection(area.api.postTypes.delete({ siteId, postTypeId: postType.id }))).toMatchObject({
			code: "FORBIDDEN",
		});
		expect((await staff.api.postTypes.get({ siteId, postTypeId: postType.id })).postType.name).toBe("Events");
	});

	test("a Post Type's Fields and Settings are addresses of the shell", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Recipes", urlPattern: "/recipes/{slug}" });
		const building = await openBuildingArea(install, staff, siteId);
		for (const place of [`content/${postType.id}/fields`, `content/${postType.id}/settings`, "content/post-types"]) {
			const response = await building.shell(
				`/_webcraft/build/page/?wc-place=${encodeURIComponent(place)}&wc-view=field%3Dtitle`,
			);
			expect(response.status).toBe(200);
			expect(shellConfigIn(await response.text())?.page).toBe("/");
		}
	});
});
