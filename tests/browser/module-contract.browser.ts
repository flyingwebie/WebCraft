import { afterAll, beforeAll, expect, test } from "bun:test";
import type { TestAccount } from "../harness/index.ts";
import { type ComponentBlock, changedGallery, galleryArchive, importGallery } from "../harness/module-contracts.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let imported: Awaited<ReturnType<typeof importGallery>>;
beforeAll(async () => {
	// The browser runs the current v1 Module; this archive came from a different, explicit v2 contract.
	const archive = await galleryArchive({ module: changedGallery, altIsMedia: true });
	install = await startBrowserInstall();
	await (await install.install.superadmin()).api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
	imported = await importGallery(install.install, archive.bytes, "retained-editor");
	staff = (await install.install.createStaff({ workspaces: [imported.workspaceId] })).account;
});
afterAll(async () => {
	await install?.close();
});

for (const theme of THEMES) {
	test(`the Body editor keeps incompatible source Props and allows unrelated keyboard edits (${theme})`, async () => {
		const { admin, siteId, postTypeId, entryId, block } = imported;
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		const paragraph = page.getByRole("textbox", { name: "Paragraph, block 2", exact: true });
		await paragraph.waitFor();
		expect(await page.getByRole("button", { name: "a Component: Props", exact: true }).isDisabled()).toBe(true);
		await expectAccessibleScreen(page, `retained Module Block ${theme}`);
		await paragraph.focus();
		await page.keyboard.press("End");
		await page.keyboard.type(` ${theme} edit`);
		await page.keyboard.press("Tab");
		const started = Date.now();
		while (true) {
			const read = (await admin.api.entries.get({ siteId, entryId })).entry;
			if (JSON.stringify(read.draft.fields.body).includes(`${theme} edit`)) {
				expect((read.draft.fields.body as ComponentBlock[])[0]).toEqual(block);
				break;
			}
			if (Date.now() - started > 5000) throw new Error("The paragraph edit did not save");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await page.getByRole("button", { name: "Add Block", exact: true }).focus();
		await page.keyboard.press("Enter");
		await page.getByRole("combobox", { name: "Blocks", exact: true }).fill("gallery");
		expect(await page.getByRole("option", { name: "Gallery", exact: true }).count()).toBe(0);
		await expectNoAxeViolations(page, `incompatible Gallery is unavailable ${theme}`);
		await page.keyboard.press("Escape");
		await page.close();
	});
}
