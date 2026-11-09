// The Media library's dialogs and menus from the keyboard: New folder, a folder's menu, Import from
// URL, Delete (with where the file is used), Empty Trash, the Workspace's quota; and setting a Focal
// point without a mouse. In light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { pdf, photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;
let siteId: string;
let imageId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const admin = await install.install.superadmin();
	await admin.api.media.folders.create({ siteId, name: "Weddings" });
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 640, height: 480 }), "harbour.jpg"),
	});
	imageId = media.id;
	const { media: document } = await admin.api.media.upload({ siteId, file: upload(pdf("Old"), "old.pdf") });
	const asked = await admin.api.media.delete({ siteId, mediaId: document.id });
	if (!asked.trashed)
		await admin.api.media.delete({ siteId, mediaId: document.id, confirmation: asked.confirmation.id });
	await install.install.drainJobs();
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Media library, ${theme}`, () => {
		test("the New folder dialog opens and closes from the keyboard, and shows a missing name accessibly", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media`));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "New folder" });

			await expectOverlayUsable(page, trigger, "dialog", `New folder (${theme})`);

			await trigger.click();
			await page.getByRole("button", { name: "Create folder" }).click();
			await page.getByText("Give the folder a name.").waitFor();
			await expectNoAxeViolations(page, `New folder, no name (${theme})`, ["region"]);
		});

		test("a folder's menu opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media`));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Weddings" }),
				"menu",
				`Folder menu (${theme})`,
			);
		});

		test("Import from URL opens and closes from the keyboard, and shows a missing address accessibly", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media`));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "Import from URL" });

			await expectOverlayUsable(page, trigger, "dialog", `Import from URL (${theme})`);

			await trigger.click();
			await page.getByRole("button", { name: "Import", exact: true }).click();
			await page.getByText("Enter the address of a file.").waitFor();
			await expectNoAxeViolations(page, `Import from URL, no address (${theme})`, ["region"]);
		});

		test("Delete opens from the keyboard, says where the file is used, and closes again", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media?file=${imageId}`));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Delete", exact: true }),
				"dialog",
				`Delete a file (${theme})`,
			);
		});

		test("Empty Trash opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media?trash=true`));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Empty Trash" }),
				"dialog",
				`Empty Trash (${theme})`,
			);
		});

		test("the Workspace's quota dialog opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/workspaces/${workspaceId}`));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /^(Set|Change) quota$/ }),
				"dialog",
				`Quota (${theme})`,
			);
		});

		test("a Focal point is set without a mouse", async () => {
			const admin = await install.install.superadmin();
			await admin.api.media.update({ siteId, mediaId: imageId, focalPoint: null });
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media?file=${imageId}`));
			await page.waitForLoadState("networkidle");

			const across = page.getByRole("slider", { name: "Across" });
			await across.focus();
			for (let step = 0; step < 15; step++) await page.keyboard.press("ArrowRight");
			await page.keyboard.press("Tab");
			expect(
				await page.getByRole("slider", { name: "Down" }).evaluate((slider) => slider === document.activeElement),
			).toBe(true);
			for (let step = 0; step < 20; step++) await page.keyboard.press("ArrowLeft");
			await page.getByText("65% from the left, 30% from the top").waitFor();
			await expectNoAxeViolations(page, `Focal point set (${theme})`, ["region"]);

			await page.getByRole("button", { name: "Save" }).focus();
			await page.keyboard.press("Enter");
			await page.getByText("Saved. Pages showing this file change at once.").waitFor();

			expect((await admin.api.media.get({ siteId, mediaId: imageId })).media.focalPoint).toEqual({ x: 65, y: 30 });
		});
	});
}
