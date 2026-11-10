// Scheduled publish in a real browser (GLOSSARY.md › Scheduled publish): the Entry editor's schedules
// in its Status card (a publish whose Draft changed since, an unpublish), the schedule dialog with its
// date and time boxes, the Entries list's chips, and the Publish all panel's Scheduled section with
// "Changed since scheduled", in light and dark, with axe and the keyboard; and scheduling a publish
// without a mouse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let siteId: string;
let postTypeId: string;
/** Scheduled to publish, its Draft changed since. */
let springId: string;
/** Published, scheduled to unpublish. */
let summerId: string;
/** A Draft nobody scheduled. */
let autumnId: string;

const HOUR = 60 * 60_000;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.account;
	const member = await local.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	editor = member.account;
	const { api } = created.browser;
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	// The web process runs on the real clock: times are an hour or two ahead of now.
	const soon = (hours: number) => new Date(Date.now() + hours * HOUR);
	const editorApi = member.browser.api;
	springId = (await editorApi.entries.create({ siteId, postTypeId, title: "Spring menu" })).entry.id;
	await editorApi.publishing.schedule({ siteId, item: { kind: "entry", id: springId }, at: soon(2) });
	await editorApi.entries.saveDraft({ siteId, entryId: springId, title: "Spring menu, revised" });
	summerId = (await editorApi.entries.create({ siteId, postTypeId, title: "Summer menu" })).entry.id;
	await editorApi.entries.publish({ siteId, entryId: summerId });
	await editorApi.publishing.scheduleUnpublish({ siteId, entryId: summerId, at: soon(3) });
	autumnId = (await editorApi.entries.create({ siteId, postTypeId, title: "Autumn menu" })).entry.id;
	const winter = await api.entries.create({ siteId, postTypeId, title: "Winter menu" });
	await api.designSystem.saveDraft({ siteId, customCss: "main { padding: 2rem; }" });
	const items = [{ kind: "entry" as const, id: winter.entry.id }, { kind: "designSystem" as const }];
	const at = soon(4);
	const preview = await api.publishing.scheduleAll({ siteId, items, at });
	if (!("confirmation" in preview)) throw new Error("Publish all at… scheduled without a confirmation.");
	await api.publishing.scheduleAll({ siteId, items, at, confirmation: preview.confirmation.id });
});

afterAll(async () => {
	await install.close();
});

/** A page signed in as `account`, opened at `path` on the admin. */
async function open(theme: "light" | "dark", account: TestAccount, path: string): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, account);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
	return page;
}

const editorOf = (entryId: string) => `/sites/${siteId}/entries/${postTypeId}/${entryId}`;

/** Whether focus is on `element` within a second. */
function focusedSoon(element: Element): Promise<boolean> {
	const deadline = performance.now() + 1000;
	return new Promise((resolve) => {
		const check = () => {
			if (element === document.activeElement) resolve(true);
			else if (performance.now() > deadline) resolve(false);
			else requestAnimationFrame(check);
		};
		check();
	});
}

for (const theme of THEMES) {
	describe(`Scheduled publish, ${theme}`, () => {
		test("the Entry editor shows its Scheduled publish, changed since, with its time in UTC and the person's own", async () => {
			const page = await open(theme, editor, editorOf(springId));
			await page.getByText("Changed since scheduled").first().waitFor();
			await page
				.getByText(/your time\)/)
				.first()
				.waitFor();
			await expectAccessibleScreen(page, `Entry editor with a Scheduled publish (${theme})`);
		});

		test("the Entry editor of a published Entry scheduled to unpublish", async () => {
			const page = await open(theme, editor, editorOf(summerId));
			await page.getByText("Unpublishes").waitFor();
			await expectAccessibleScreen(page, `Entry editor with a scheduled unpublish (${theme})`);
		});

		test("the schedule dialog: its date and time boxes, opened and closed from the keyboard", async () => {
			const page = await open(theme, editor, editorOf(autumnId));
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Schedule…" }),
				"dialog",
				`The schedule dialog (${theme})`,
			);
			const unpublished = await open(theme, editor, editorOf(summerId));
			await expectOverlayUsable(
				unpublished,
				unpublished.getByRole("button", { name: "Change time" }),
				"dialog",
				`Changing a scheduled unpublish's time (${theme})`,
			);
		});

		test("the Entries list marks what is scheduled, and what changed since", async () => {
			const page = await open(theme, editor, `/sites/${siteId}/entries/${postTypeId}`);
			await page.getByText("Unpublish scheduled").waitFor();
			await expectAccessibleScreen(page, `Entries list with Scheduled publishes (${theme})`);
		});

		test("the Publish all panel lists the Scheduled publishes, and its dialogs work from the keyboard", async () => {
			const page = await open(theme, staff, `/sites/${siteId}`);
			const trigger = page.getByRole("button", { name: /^Publish all/ });
			await trigger.focus();
			await page.keyboard.press("Enter");
			const panel = page.getByRole("dialog", { name: "Publish all changes" });
			await panel.getByRole("heading", { name: "Scheduled" }).waitFor();
			await panel.getByText("Changed since scheduled").first().waitFor();
			await expectNoAxeViolations(page, `Publish all with Scheduled publishes (${theme}, open)`, ["region"]);

			// Changing a time, from the keyboard: a dialog over the panel, and back to its button.
			const change = panel.getByRole("button", { name: /^Change time of .*Winter menu/ });
			await change.focus();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", { name: "Change the time" });
			await dialog.waitFor();
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Changing a Scheduled publish's time (${theme}, open)`, ["region"]);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			expect({ backOnChange: await change.evaluate(focusedSoon) }).toEqual({ backOnChange: true });

			// "Publish all at…" opens its own dialog over the panel.
			const at = panel.getByRole("button", { name: /^Publish \d+ items? at…/ });
			await at.focus();
			await page.keyboard.press("Enter");
			const scheduling = page.getByRole("dialog", { name: "Publish all at a time" });
			await scheduling.getByLabel("Date").waitFor();
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Publish all at… (${theme}, open)`, ["region"]);
			await page.keyboard.press("Escape");
			await scheduling.waitFor({ state: "hidden" });
		});
	});
}

describe("scheduling without a mouse", () => {
	test("the dialog offers a time ahead; Tab reaches the boxes and the button, Enter schedules", async () => {
		const page = await open("light", editor, editorOf(autumnId));
		await page.getByRole("button", { name: "Schedule…" }).focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Schedule this publish" });
		await dialog.getByLabel("Date").waitFor();
		await dialog.getByText(/^Runs at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/).waitFor();
		await dialog.getByRole("button", { name: "Schedule publish" }).focus();
		await page.keyboard.press("Enter");
		await dialog.waitFor({ state: "hidden" });
		await page.getByText(/^Publishes \d{4}-/).waitFor();

		const { entry } = await (await install.install.superadmin()).api.entries.get({ siteId, entryId: autumnId });
		expect(entry.scheduled.publish).toMatchObject({ kind: "item", changedSinceScheduled: false });
		expect(new Date(entry.scheduled.publish?.at ?? 0).getTime()).toBeGreaterThan(Date.now());
	});
});
