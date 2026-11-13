// Publish all in a real browser (ADR 0014): the list a Site's top bar opens, Content and Structure,
// for Staff and for an Owner (who sees Structure but can't tick it), in light and dark, opened and
// closed from the keyboard; and unticking an item and publishing the rest without a mouse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.account;
	const { api } = created.browser;
	owner = (await local.createMember({ workspaceId, role: "owner", name: "Olive Owner" })).account;
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const published = await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: published.entry.id });
	await api.entries.saveDraft({ siteId, entryId: published.entry.id, title: "Fresh sourdough" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "Spring menu" });
	await api.designSystem.saveDraft({ siteId, customCss: "main { padding: 2rem; }" });
});

afterAll(async () => {
	await install.close();
});

/** The Site's Overview as `account` sees it, with Publish all in the top bar. */
async function overview(theme: "light" | "dark", account: TestAccount): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, account);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.waitForLoadState("networkidle");
	return page;
}

/**
 * Opens Publish all from the keyboard, waits for its list, checks it with axe, then closes it with
 * Escape: focus goes back to the button.
 */
async function expectListUsable(page: Page, where: string): Promise<void> {
	const trigger = page.getByRole("button", { name: /^Publish all/ });
	await trigger.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog");
	await dialog.getByText(/\d+ of \d+ selected/).waitFor();
	// An open dialog sits outside the landmarks, as dialogs do: people reach it from its button.
	await expectNoAxeViolations(page, `${where} (open)`, ["region"]);
	expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await dialog.waitFor({ state: "hidden" });
	const back = await trigger.evaluate(
		(element) =>
			new Promise<boolean>((resolve) => {
				const deadline = performance.now() + 1000;
				const check = () => {
					if (element === document.activeElement) resolve(true);
					else if (performance.now() > deadline) resolve(false);
					else requestAnimationFrame(check);
				};
				check();
			}),
	);
	expect({ where, escapeClosesAndReturnsFocus: back }).toEqual({ where, escapeClosesAndReturnsFocus: true });
}

for (const theme of THEMES) {
	describe(`Publish all, ${theme}`, () => {
		test("Staff see every Draft, Content and Structure, ticked", async () => {
			const page = await overview(theme, staff);
			await expectListUsable(page, `Publish all, Staff (${theme})`);
		});

		test("an Owner sees Structure too, but never ticked: it is Staff's to publish", async () => {
			const page = await overview(theme, owner);
			await expectListUsable(page, `Publish all, an Owner (${theme})`);
		});
	});
}

describe("publishing from the list", () => {
	test("an item unticked with the keyboard stays a Draft; the rest go live", async () => {
		const page = await overview("light", staff);
		await page.getByRole("button", { name: "Publish all 3 changes" }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByText("3 of 3 selected").waitFor();

		await dialog.getByRole("checkbox", { name: "Spring menu" }).focus();
		await page.keyboard.press("Space");
		await dialog.getByText("2 of 3 selected").waitFor();
		await dialog.getByRole("button", { name: "Publish 2 items", exact: true }).focus();
		await page.keyboard.press("Enter");

		await dialog.waitFor({ state: "hidden" });
		await page.getByRole("button", { name: "Publish all 1 change" }).waitFor();
		const { drafts } = await (await install.install.superadmin()).api.publishing.drafts({ siteId });
		expect(drafts.map((draft) => draft.name)).toEqual(["Spring menu"]);
	});
});
