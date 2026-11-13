import { expect, test } from "bun:test";

import { createTestInstall } from "../harness/index.ts";

test("Popup reads keep Content available to Members while Structure Checks require structure.edit", async () => {
	const install = await createTestInstall();
	try {
		const workspace = await install.createWorkspace();
		const siteId = (await install.createSite(workspace.id)).id;
		const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		const { popup } = await staff.api.popups.create({ siteId, name: "Early offer" });
		await staff.api.popups.saveDraft({ siteId, popupId: popup.id, popup: { trigger: { kind: "load" } } });
		await staff.api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "An offer to edit" } });
		const checks = [{ check: "popupPhoneEarly" as const, at: "trigger" }];
		expect((await staff.api.popups.get({ siteId, popupId: popup.id })).popup.checks).toEqual(checks);
		expect((await staff.api.popups.list({ siteId })).popups.find((row) => row.id === popup.id)?.checks).toEqual(checks);
		for (const role of ["owner", "editor", "author"] as const) {
			const member = (await install.createMember({ workspaceId: workspace.id, role })).browser;
			const read = await member.api.popups.get({ siteId, popupId: popup.id });
			expect(read.content.draft.values.title).toBe("An offer to edit");
			expect(read.popup.checks).toEqual([]);
			expect((await member.api.popups.list({ siteId })).popups.find((row) => row.id === popup.id)?.checks).toEqual([]);
		}
	} finally {
		await install.close();
	}
});
