// The admin's text boxes on a shared Draft, in a real browser. After every save the Draft's document
// takes what the save stored (audit A3-1), and the editor shows the document: that must never undo
// what its own person is typing. The save trims text, so a space typed between two words, then a
// pause, must still be there for the next word; rich text is handed on as a save keeps it, so typing
// draws no correction; and a link's address reaches the Draft as it was typed, escaped once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let api: TestBrowser["api"];
let siteId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.account;
	api = created.browser.api;
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
		],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install?.close();
});

async function openNewEntry(title: string): Promise<{ page: Page; entryId: string }> {
	const entryId = (await api.entries.create({ siteId, postTypeId, title })).entry.id;
	const page = await install.newPage("light");
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
	await page.getByRole("status").filter({ hasText: "All changes saved" }).first().waitFor();
	return { page, entryId };
}

/** Waits until the Draft the API reads holds what `check` looks for. */
async function untilDraft(entryId: string, check: (fields: Record<string, unknown>) => boolean): Promise<void> {
	const started = Date.now();
	for (;;) {
		const { entry } = await api.entries.get({ siteId, entryId });
		if (check(entry.draft.fields as Record<string, unknown>)) return;
		if (Date.now() - started > 5000) throw new Error(`The Draft never held it: ${JSON.stringify(entry.draft.fields)}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("typing into a shared Draft", () => {
	test("a space typed before a pause is still there for the next word", async () => {
		const { page, entryId } = await openNewEntry("Fresh bread");
		const summary = page.getByLabel("Summary");
		await summary.focus();
		await page.keyboard.type("Crusty ");
		// The batch goes, the save trims it, the document's answer comes back: the box keeps the space.
		await untilDraft(entryId, (fields) => fields.summary === "Crusty");
		await page.getByRole("status").filter({ hasText: "All changes saved" }).first().waitFor();
		await page.waitForTimeout(600);
		expect(await summary.inputValue()).toBe("Crusty ");
		await page.keyboard.type("and warm");
		await untilDraft(entryId, (fields) => fields.summary === "Crusty and warm");
		expect(await summary.inputValue()).toBe("Crusty and warm");
		await page.close();
	});

	test("rich text typed with pauses is kept as typed, and the box keeps its place", async () => {
		const { page, entryId } = await openNewEntry("Rye bread");
		const intro = page.getByRole("textbox", { name: "Intro" });
		await intro.focus();
		await page.keyboard.type("Crusty ");
		await page.waitForTimeout(900);
		await page.keyboard.type("and warm");
		await page.keyboard.press("Enter");
		await page.keyboard.type("Second line");
		await untilDraft(entryId, (fields) => typeof fields.intro === "string" && fields.intro.includes("Second line"));
		const { entry } = await api.entries.get({ siteId, entryId });
		expect(String(entry.draft.fields.intro).replace(/<[^>]+>/g, "|")).toMatch(/^\|?Crusty and warm\|+Second line\|?$/);
		expect(await intro.textContent()).toBe("Crusty and warmSecond line");
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});

	test("a link's address reaches the Draft as it was typed", async () => {
		const { page, entryId } = await openNewEntry("Soda bread");
		const intro = page.getByRole("textbox", { name: "Intro" });
		await intro.focus();
		await page.keyboard.type("Read more");
		await page.keyboard.press("ControlOrMeta+a");
		await page.getByRole("button", { name: "Add a link", exact: true }).click();
		const address = `https://example.com/search?q="rye"&sort=<new>`;
		await page.getByRole("dialog").getByLabel("Address").fill(address);
		await page.getByRole("dialog").getByRole("button", { name: "Add link", exact: true }).click();
		await untilDraft(entryId, (fields) => typeof fields.intro === "string" && fields.intro.includes("<a "));
		const { entry } = await api.entries.get({ siteId, entryId });
		expect(entry.draft.fields.intro).toContain(
			'<a href="https://example.com/search?q=&quot;rye&quot;&amp;sort=&lt;new&gt;">Read more</a>',
		);
		await page.close();
	});
});
