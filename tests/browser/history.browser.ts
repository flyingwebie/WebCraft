// An item's history in a real browser: the Entry editor's History card, the History screen with a
// Revision compared with the Draft (only the parts that differ, then every part, then another
// language), a Structure item's markup line by line, the Restore dialog from the keyboard and a restore
// made without a mouse, Install settings › Revisions and a Post Type's Revisions tab, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;
let revisionId: string;
let componentId: string;
let componentRevisionId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.account;
	const { api } = created.browser;
	await api.languages.add({ siteId, code: "fr" });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "body", label: "Body", type: "body" },
			{
				key: "topic",
				label: "Topic",
				type: "select",
				options: [
					{ value: "bread", label: "Bread" },
					{ value: "cakes", label: "Cakes" },
				],
			},
		],
	});
	postTypeId = postType.id;
	const { entry } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: {
			summary: "Crusty",
			topic: "bread",
			body: [
				{ id: "b1", type: "paragraph", text: "Bake it slowly." },
				{ id: "b2", type: "paragraph", text: "Serve it warm." },
			],
		},
	});
	entryId = entry.id;
	await api.entries.saveDraft({ siteId, entryId, language: "fr", title: "Pain frais" });
	await api.entries.publish({ siteId, entryId });
	const item = { kind: "entry", id: entryId } as const;
	revisionId = (await api.history.list({ siteId, item })).copies.find((copy) => copy.type === "revision")?.id ?? "";
	await api.entries.saveDraft({
		siteId,
		entryId,
		title: "Fresh bread, sliced",
		fields: {
			topic: "cakes",
			body: [
				{ id: "b1", type: "paragraph", text: "Bake it very slowly." },
				{ id: "b3", type: "quote", text: "Best in town." },
			],
		},
	});
	const { secret } = await createApiToken(created.browser, { workspaceId, name: "Nightly sync" });
	await tokenClient(local, secret).api.entries.saveDraft({ siteId, entryId, fields: { summary: "Crusty and warm" } });
	await api.history.leave({ siteId, item });

	const { component } = await api.components.create({ siteId, name: "PriceTag" });
	componentId = component.id;
	await api.components.saveMarkup({ siteId, componentId, markup: "<p>Price</p>\n<p>Per loaf</p>" });
	await api.components.publish({ siteId, componentId });
	componentRevisionId =
		(await api.history.list({ siteId, item: { kind: "component", id: componentId } })).copies[0]?.id ?? "";
	await api.components.saveMarkup({ siteId, componentId, markup: "<p>Price</p>\n<p>Per dozen</p>" });
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

const entryHistory = (more = "") =>
	`/sites/${siteId}/history?item=entry&itemId=${entryId}&copy=revision:${revisionId}${more}`;

for (const theme of THEMES) {
	describe(`history, ${theme}`, () => {
		test("the Entry editor's History card", async () => {
			const page = await open(theme, staff, `/sites/${siteId}/entries/${postTypeId}/${entryId}`);
			await page.getByRole("heading", { name: "History", level: 2 }).waitFor();
			await expectAccessibleScreen(page, `Entry editor with its History card (${theme})`);
		});

		test("a Revision next to the Draft: the parts that differ, then every part", async () => {
			const page = await open(theme, staff, entryHistory());
			await page.getByText("4 parts differ from the Draft.").waitFor();
			await expectAccessibleScreen(page, `History, a Revision compared (${theme})`);

			await page.getByRole("link", { name: "Show every part" }).click();
			await page.getByRole("link", { name: "Show only what differs" }).waitFor();
			await expectAccessibleScreen(page, `History, every part (${theme})`);
		});

		test("another language, chosen from the keyboard", async () => {
			const page = await open(theme, staff, entryHistory());
			await page.getByRole("link", { name: /Français/ }).focus();
			await page.keyboard.press("Enter");
			await page.getByText("1 part differs from the Draft.").waitFor();
			await expectAccessibleScreen(page, `History, in French (${theme})`);
		});

		test("a Component's markup, line by line", async () => {
			const page = await open(
				theme,
				staff,
				`/sites/${siteId}/history?item=component&itemId=${componentId}&copy=revision:${componentRevisionId}`,
			);
			await page.getByText("Per dozen").waitFor();
			await expectAccessibleScreen(page, `History, a Component (${theme})`);
		});

		test("the Restore dialog opens and closes from the keyboard", async () => {
			const page = await open(theme, staff, entryHistory());
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Restore this Revision" }),
				"dialog",
				`History, Restore (${theme})`,
			);
		});

		test("Install settings › Revisions", async () => {
			const page = await open(theme, superadmin, "/settings/history");
			await page.getByRole("heading", { name: "Revisions", level: 1 }).waitFor();
			await expectAccessibleScreen(page, `Install settings › Revisions (${theme})`);
		});

		test("a Post Type's Revisions tab", async () => {
			const page = await open(theme, staff, `/sites/${siteId}/post-types/${postTypeId}?tab=revisions`);
			await page.getByText("Save a Revision each time an Entry of Blog posts is published").waitFor();
			await expectAccessibleScreen(page, `Post Type › Revisions (${theme})`);
		});
	});
}

describe("restoring from the keyboard", () => {
	test("puts the Revision into the Draft, keeps the Draft as a Checkpoint and publishes nothing", async () => {
		const page = await open("light", staff, entryHistory());
		await page.getByRole("button", { name: "Restore this Revision" }).focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("button", { name: "Restore into the Draft" }).focus();
		await page.keyboard.press("Enter");
		await page.waitForURL(/\/entries\//);

		const { api } = await install.install.superadmin();
		const { entry } = await api.entries.get({ siteId, entryId });
		expect(entry.draft.title).toBe("Fresh bread");
		expect(entry.published?.title).toBe("Fresh bread");
		// The Draft as it was is the newest Checkpoint (taken when the editor was left, so nothing new was needed).
		const item = { kind: "entry", id: entryId } as const;
		const { copies } = await api.history.list({ siteId, item });
		const kept = copies.find((copy) => copy.type === "checkpoint");
		const content = await api.history.get({ siteId, item, copy: { type: "checkpoint", id: kept?.id ?? "" } });
		expect(JSON.stringify(content.content)).toContain("Fresh bread, sliced");
	});
});

describe("closing the Consent banner's words", () => {
	test("keeps their changed Draft as a Checkpoint", async () => {
		const page = await open("light", staff, `/sites/${siteId}/consent-banner`);
		await page.getByRole("textbox", { name: "Heading" }).fill("Before you browse the bakery");
		const { api } = await install.install.superadmin();
		const item = { kind: "consentBanner" } as const;
		// The words reach their Draft as they are typed; then the editor closes.
		await waitFor(async () => {
			const { banner } = await api.consentBanner.get({ siteId });
			return JSON.stringify(banner.text.draft).includes("Before you browse the bakery");
		});
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.waitForLoadState("networkidle");

		await waitFor(async () => {
			const { copies } = await api.history.list({ siteId, item });
			return copies.some((copy) => copy.type === "checkpoint" && copy.reason === "left");
		});
		const { copies } = await api.history.list({ siteId, item });
		const kept = copies.find((copy) => copy.type === "checkpoint" && copy.reason === "left");
		const content = await api.history.get({ siteId, item, copy: { type: "checkpoint", id: kept?.id ?? "" } });
		expect(JSON.stringify(content.content)).toContain("Before you browse the bakery");
		await page.close();
	});
});

/** Waits until `check` answers true, or fails after 15 seconds. */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
	const until = Date.now() + 15_000;
	while (!(await check())) {
		if (Date.now() > until) throw new Error("Timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}
