// What client editing starts from (ADR 0037, BA-14; SPEC 13): the shell's document says whether the
// person may change Structure (Staff get the whole shell, a Member client editing), whether they have
// seen the first-visit card (their editor preferences), and who looks after the Site for Help's "Ask your
// agency" (Install branding's sender name and footer), and, for Staff, the Member roles they may see the
// page as (FX-04). Whatever the shell draws, a Member's calls that change Structure are refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EDITOR_LAYOUT_VERSION } from "@webcraft/core";

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
});

afterAll(async () => {
	await install.close();
});

/** The shell's config for a person entering the building area now. */
async function configFor(person: TestBrowser) {
	const building = await openBuildingArea(install, person, siteId);
	return { building, config: shellConfigIn(await (await building.shell(building.landed)).text()) };
}

describe("client editing's ground", () => {
	test("Structure decides the shell: Staff hold it, a Member doesn't", async () => {
		expect((await configFor(staff)).config?.permissions).toContain("structure.edit");
		expect((await configFor(editor)).config?.permissions).not.toContain("structure.edit");
	});

	test("Staff are offered the page as a client sees it, as an Owner or Editor or as an Author; a Member isn't (FX-04)", async () => {
		const roles = (await configFor(staff)).config?.clientRoles as { key: string; permissions: string[] }[];
		expect(roles.map((role) => role.key)).toEqual(["editor", "author"]);
		const [editorView, authorView] = roles;
		// An Owner changes what an Editor does in the building area: one view for both.
		expect(editorView?.permissions).toEqual(expect.arrayContaining(["entry.edit", "entry.publish", "media.manage"]));
		expect(authorView?.permissions).toEqual(expect.arrayContaining(["entry.edit", "media.upload"]));
		expect(authorView?.permissions).not.toContain("entry.publish");
		expect(authorView?.permissions).not.toContain("media.manage");
		for (const role of roles) expect(role.permissions).not.toContain("structure.edit");
		expect((await configFor(editor)).config?.clientRoles).toEqual([]);
	});

	test("the first-visit card is the person's: shown until they have seen it, on every Site", async () => {
		expect((await configFor(editor)).config?.hintSeen).toBe(false);
		await editor.api.me.saveEditorPreferences({
			siteId,
			preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
		});
		expect((await configFor(editor)).config?.hintSeen).toBe(true);
	});

	test("Help's agency is Install branding's sender name and footer, else the Install's name", async () => {
		expect((await configFor(editor)).config?.agency).toEqual({ name: "WebCraft", note: null });
		const { api } = await install.superadmin();
		await api.install.emailBranding.update({ senderName: "Acme Studio", footer: "hello@acme.studio" });
		expect((await configFor(editor)).config?.agency).toEqual({ name: "Acme Studio", note: "hello@acme.studio" });
	});

	test("a Member's call that changes Structure is refused, whatever the shell draws", async () => {
		const { building } = await configFor(editor);
		const response = await buildingAreaApi(install, building).call("pageLayouts.configure", {
			siteId,
			enabled: true,
		});
		expect(response.status).toBe(403);
		expect(((await response.json()) as { json: { code: string } }).json.code).toBe("FORBIDDEN");
	});
});
