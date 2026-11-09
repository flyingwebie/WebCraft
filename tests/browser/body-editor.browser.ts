// The block editor of a Body field in a browser: axe and keyboard checks in light and dark with every
// Block, its problems and Checks showing; the `/` menu and Markdown shortcuts from the keyboard; and
// moving a Block without dragging. What is typed autosaves to the Draft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let siteId: string;
let articlesId: string;
let entryId: string;

type Admin = Awaited<ReturnType<BrowserInstall["install"]["superadmin"]>>;
let admin: Admin;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	owner = (await local.createMember({ workspaceId, role: "owner", name: "Sarah Murphy" })).account;
	admin = await local.superadmin();

	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Articles",
		key: "articles",
		urlPattern: "/articles/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "body", label: "Body", type: "body", required: true, blocksOff: ["code"] },
		],
	});
	articlesId = postType.id;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 640, height: 480 }), "spring-loaves.jpg"),
	});
	await local.drainJobs();
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: articlesId,
		title: "Spring menu 2027",
		fields: {
			summary: "Three new loaves.",
			body: [
				{ type: "paragraph", text: [{ text: "Spring arrives with " }, { text: "three new loaves", marks: ["bold"] }, { text: ". " }, { text: "Click here", link: "/menu" }, { text: " for the menu." }] },
				{ type: "heading", level: 2, text: "Breads" },
				{ type: "heading", level: 4, text: "Rye" },
				{ type: "list", style: "bulleted", items: ["Spelt", { text: "Rye", items: ["Dark rye"] }] },
				{ type: "quote", text: "The best loaf in Cork." },
				{ type: "image", media: media.id },
				{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
				{ type: "table", headerRow: false, rows: [["Loaf", "Price"], ["Rye", "€4"]] },
				{ type: "callout", tone: "warning", text: "Contains gluten." },
				{ type: "code", code: "bake()" },
				{ type: "divider" },
				{ type: "toggle", summary: "Allergens", text: "Gluten, sesame." },
				{ type: "paragraph", text: "" },
			],
		},
	});
	entryId = entry.id;
});

afterAll(async () => {
	await install.close();
});

async function open(page: Page, account: TestAccount, path: string): Promise<void> {
	await install.signIn(page, account);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

/** The Draft's Blocks, as the API answers them, once `ready` says the autosave has landed. */
async function draftBlocks(ready: (blocks: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
	let blocks: Record<string, unknown>[] = [];
	for (let look = 0; look < 60; look++) {
		const { entry } = await admin.api.entries.get({ siteId, entryId });
		blocks = entry.draft.fields.body as Record<string, unknown>[];
		if (ready(blocks)) return blocks;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return blocks;
}

for (const theme of THEMES) {
	describe(`the block editor, ${theme}`, () => {
		test("every Block, with its problems and Checks showing", async () => {
			const page = await install.newPage(theme);
			await open(page, owner, `/sites/${siteId}/entries/${articlesId}/${entryId}`);
			await page.getByText("This heading skips a level (H2 → H4).", { exact: false }).waitFor();
			await page.getByText("This image has no alt text.", { exact: false }).waitFor();
			// A problem shows under its Block, and in the list of what keeps the Draft from being published.
			await page.getByRole("button", { name: /^Body, block 10: This kind of Block is switched off/ }).waitFor();

			await expectAccessibleScreen(page, `block editor (${theme})`);
		});

		test("the Body field's settings: the Blocks people can add", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/post-types/${articlesId}`);
			await page.getByRole("button", { name: /^Body/ }).click();
			await page.getByRole("heading", { level: 2, name: "Body" }).waitFor();
			await page.getByRole("checkbox", { name: "Tables" }).waitFor();
			expect(await page.getByRole("checkbox", { name: "Code" }).isChecked()).toBe(false);

			await expectAccessibleScreen(page, `Body field settings (${theme})`);
		});
	});
}

describe("writing with the keyboard", () => {
	test("/ opens the Block menu in an empty paragraph; Markdown shortcuts turn paragraphs into Blocks", async () => {
		const page = await install.newPage("light");
		await open(page, owner, `/sites/${siteId}/entries/${articlesId}/${entryId}`);
		const last = page.getByRole("textbox", { name: "Paragraph, block 13" });
		await last.click();

		await page.keyboard.type("/");
		const filter = page.getByRole("combobox", { name: "Blocks" });
		await filter.waitFor();
		expect(await page.getByRole("option").allTextContents()).not.toContain("Code");
		await expectNoAxeViolations(page, "the / menu open");
		await page.keyboard.type("heading");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		const heading = page.getByRole("textbox", { name: "Heading 3, block 13" });
		await heading.waitFor();
		await page.keyboard.type("Pastries");
		await page.keyboard.press("Enter");
		await page.keyboard.type("- Croissant");
		await page.keyboard.press("Enter");
		await page.keyboard.type("Pain au chocolat");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");
		await page.keyboard.type("## Tarts");

		const blocks = await draftBlocks((saved) => JSON.stringify(saved.at(-1)).includes("Tarts"));
		expect(blocks.slice(12).map(({ id: _, ...block }) => block)).toEqual([
			{ type: "heading", level: 3, text: [{ text: "Pastries" }] },
			{
				type: "list",
				style: "bulleted",
				items: [{ text: [{ text: "Croissant" }] }, { text: [{ text: "Pain au chocolat" }] }],
			},
			{ type: "heading", level: 2, text: [{ text: "Tarts" }] },
		]);
	});

	test("a Block moves with the keyboard, the drag handle's alternative, and the move saves", async () => {
		const page = await install.newPage("light");
		await open(page, owner, `/sites/${siteId}/entries/${articlesId}/${entryId}`);
		const before = await draftBlocks(() => true);

		const trigger = page.getByRole("button", { name: "Quote, block 5: actions" });
		await trigger.focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Move up" }).focus();
		await page.keyboard.press("Enter");
		await page.getByText("Block moved to place 4 of", { exact: false }).waitFor({ state: "attached" });

		const after = await draftBlocks((saved) => saved[3]?.type === "quote");
		expect(after.map((block) => block.id)).toEqual([
			...before.slice(0, 3).map((block) => block.id),
			before[4]?.id,
			before[3]?.id,
			...before.slice(5).map((block) => block.id),
		]);
	});

	test("bold from the keyboard and a link from the toolbar save as marks and links", async () => {
		const { entry } = await admin.api.entries.create({
			siteId,
			postTypeId: articlesId,
			title: "Opening hours",
			fields: { body: [{ type: "paragraph", text: "Fresh bread daily" }] },
		});
		const page = await install.newPage("light");
		await open(page, owner, `/sites/${siteId}/entries/${articlesId}/${entry.id}`);
		const paragraph = page.getByRole("textbox", { name: "Paragraph, block 1" });
		const select = (word: string) =>
			paragraph.evaluate((element, wanted) => {
				const text = element.firstChild as Text;
				const start = (text.data ?? "").indexOf(wanted);
				const range = document.createRange();
				range.setStart(text, start);
				range.setEnd(text, start + wanted.length);
				element.focus();
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
			}, word);

		await select("bread");
		await page.keyboard.press("ControlOrMeta+b");
		await paragraph.locator("b, strong").waitFor();
		await paragraph.evaluate((element) => {
			const range = document.createRange();
			const text = element.lastChild as Text;
			range.setStart(text, text.data.indexOf("daily"));
			range.setEnd(text, text.data.length);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		});
		await page.getByRole("toolbar", { name: "Formatting and Blocks" }).getByRole("button", { name: "Link" }).click();
		await page.getByRole("dialog").getByLabel("Address").fill("/hours");
		await page.getByRole("dialog").getByRole("button", { name: "Add link" }).click();

		let text: unknown;
		for (let look = 0; look < 60; look++) {
			const { entry: saved } = await admin.api.entries.get({ siteId, entryId: entry.id });
			text = (saved.draft.fields.body as { text: unknown }[])[0]?.text;
			if (JSON.stringify(text).includes("/hours")) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(text).toEqual([
			{ text: "Fresh " },
			{ text: "bread", marks: ["bold"] },
			{ text: " " },
			{ text: "daily", link: "/hours" },
		]);
	});
});
