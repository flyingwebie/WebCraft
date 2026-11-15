// The block editor of a Body field in a browser: axe and keyboard checks in light and dark with every
// Block, its problems and Checks showing; the `/` menu and Markdown shortcuts from the keyboard; and
// moving a Block without dragging. What is typed autosaves to the Draft. Also the admin's own cases of
// Components and pasting: the `/` menu offering the Components a Body field allows (their Props filled
// before one goes in), a pasted document and image file turned into Blocks and Media, and Staff choosing
// the Components a Body field allows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let workspaceId: string;
let siteId: string;
let articlesId: string;
let entryId: string;

type Admin = Awaited<ReturnType<BrowserInstall["install"]["superadmin"]>>;
let admin: Admin;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
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
				{
					type: "paragraph",
					text: [
						{ text: "Spring arrives with " },
						{ text: "three new loaves", marks: ["bold"] },
						{ text: ". " },
						{ text: "Click here", link: "/menu" },
						{ text: " for the menu." },
					],
				},
				{ type: "heading", level: 2, text: "Breads" },
				{ type: "heading", level: 4, text: "Rye" },
				{ type: "list", style: "bulleted", items: ["Spelt", { text: "Rye", items: ["Dark rye"] }] },
				{ type: "quote", text: "The best loaf in Cork." },
				{ type: "image", media: media.id },
				{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
				{
					type: "table",
					headerRow: false,
					rows: [
						["Loaf", "Price"],
						["Rye", "€4"],
					],
				},
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
	// Up to 20 s: the editor saves typing a moment after it stops, and a CI runner is slower than a laptop.
	for (let look = 0; look < 200; look++) {
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
		await page.keyboard.type("## ");
		// The shortcut swaps the paragraph for a heading and moves the caret into it; keys sent before a
		// slow machine has done so are typed faster than any person types, and were lost on CI runners.
		const inHeading = () =>
			page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Heading 2") ?? false);
		for (let look = 0; look < 100 && !(await inHeading()); look++) await page.waitForTimeout(100);
		if (!(await inHeading())) {
			// Says where the caret went instead, with every Block's name: this has only failed on CI runners.
			const seen = await page.evaluate(() => ({
				active: [document.activeElement?.tagName, document.activeElement?.getAttribute("aria-label")],
				textboxes: [...document.querySelectorAll('[role="textbox"]')].map((box) => box.getAttribute("aria-label")),
			}));
			throw new Error(`The caret isn't in the new heading: ${JSON.stringify(seen)}`);
		}
		await page.keyboard.type("Tarts");

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
		for (let look = 0; look < 200; look++) {
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

describe("Components and pasting in the admin", () => {
	let editor: TestAccount;
	let storiesId: string;
	let noteId: string;
	let stories = 0;

	beforeAll(async () => {
		editor = (await install.install.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;
		const { component } = await admin.api.components.create({
			siteId,
			name: "Note",
			props: [{ key: "text", label: "Note text", type: "text", required: true }],
		});
		await admin.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<aside><p>{{ props.text }}</p></aside>",
		});
		await admin.api.components.publish({ siteId, componentId: component.id });
		noteId = component.id;
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "body", label: "Story", type: "body", components: [noteId] }],
		});
		storiesId = postType.id;
	});

	/** A published Story with a body of a few Blocks; answers its id. */
	async function story(): Promise<string> {
		const { entry } = await admin.api.entries.create({
			siteId,
			postTypeId: storiesId,
			title: "Spring menu",
			slug: `story-${++stories}`,
			fields: {
				body: [
					{ type: "heading", level: 2, text: "Breads" },
					{ type: "paragraph", text: [{ text: "Fresh " }, { text: "every", marks: ["bold"] }, { text: " day." }] },
					{ type: "list", style: "bulleted", items: ["Sourdough", "Rye"] },
					{ type: "callout", tone: "info", text: "Order by noon." },
					{ type: "component", component: noteId, props: [{ name: "text", value: "Closed on Mondays." }] },
				],
			},
		});
		await admin.api.entries.publish({ siteId, entryId: entry.id });
		return entry.id;
	}

	type Block = { id: string; type: string; text?: { text: string }[]; component?: string; props?: unknown[] };

	/** A Story's body once `done` accepts it, waiting up to 8 seconds. */
	async function bodyWhen(storyId: string, done: (body: Block[]) => boolean): Promise<Block[]> {
		const read = async () =>
			(await admin.api.entries.get({ siteId, entryId: storyId })).entry.draft.fields.body as Block[];
		const deadline = Date.now() + 8000;
		let body = await read();
		while (!done(body) && Date.now() < deadline) {
			await Bun.sleep(200);
			body = await read();
		}
		return body;
	}

	for (const theme of THEMES) {
		test(`the admin offers allowed Components and their Props from the same / menu, ${theme}`, async () => {
			const storyId = await story();
			const page = await install.newPage(theme);
			await install.signIn(page, editor);
			await page.goto(install.adminUrl(`/sites/${siteId}/entries/${storiesId}/${storyId}`));
			await page.getByRole("textbox", { name: "Paragraph, block 2" }).click();
			await page.keyboard.press("End");
			await page.keyboard.press("Enter");
			await page.keyboard.press("/");
			await page.getByRole("combobox", { name: "Blocks" }).fill("Note");
			await page.getByRole("option", { name: "Note", exact: true }).waitFor();
			// The list's items, one under the other, are each a target of at least 24 px (WCAG 2.5.8): axe
			// judges them only when it finds them beside the chooser, so their size is read here too.
			const items = await page
				.getByRole("textbox", { name: /^Item \d+$/ })
				.evaluateAll((all) => all.map((each) => Math.round(each.getBoundingClientRect().height)));
			expect(items.length).toBe(2);
			expect(items.filter((height) => height < 24)).toEqual([]);
			await expectNoAxeViolations(page, `admin Component chooser (${theme})`);
			await page.keyboard.press("Enter");
			const form = page.getByRole("dialog", { name: "Note: Props" });
			await form.waitFor();
			await expectNoAxeViolations(page, `admin Component Props (${theme})`);
			await form.getByLabel("Note text", { exact: false }).fill("From the admin.");
			await form.getByRole("button", { name: "Insert", exact: true }).click();
			const blocks = await bodyWhen(storyId, (body) => JSON.stringify(body).includes("From the admin."));
			expect(blocks[2]).toMatchObject({
				type: "component",
				component: noteId,
				props: [{ name: "text", value: "From the admin." }],
			});
			await page.close();
		});
	}

	test("pasting a document and an image file in the admin converts Blocks and uploads Media", async () => {
		const storyId = await story();
		const page = await install.newPage("light");
		await install.signIn(page, editor);
		await page.goto(install.adminUrl(`/sites/${siteId}/entries/${storiesId}/${storyId}`));
		const paragraph = page.getByRole("textbox", { name: "Paragraph, block 2" });
		await paragraph.click();
		await paragraph.evaluate((element) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData(
				"text/html",
				'<h1>Pasted heading</h1><p>A <strong>fresh</strong> loaf.</p><img src="https://example.com/loaf.jpg">',
			);
			clipboardData.setData("text/plain", "Pasted heading\nA fresh loaf.");
			element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
		});
		await page.getByRole("textbox", { name: "Heading 2, block 3" }).waitFor();
		const blocks = await bodyWhen(storyId, (body) => body.length === 8);
		expect(blocks.slice(2, 5)).toMatchObject([
			{ type: "heading", level: 2, text: [{ text: "Pasted heading" }] },
			{ type: "paragraph", text: [{ text: "A " }, { text: "fresh", marks: ["bold"] }, { text: " loaf." }] },
			{ type: "image", media: null },
		]);
		await paragraph.click();
		await paragraph.evaluate((element) => {
			const clipboardData = new DataTransfer();
			clipboardData.items.add(
				new File(
					[
						'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
					],
					"clipboard.svg",
					{ type: "image/svg+xml" },
				),
			);
			element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
		});
		const withImage = await bodyWhen(storyId, (body) => body.length === 9);
		expect(withImage[2]).toMatchObject({ type: "image", media: expect.any(String) });
		await page.close();
	});

	for (const theme of THEMES) {
		test(`Staff choose the Components allowed in a Body field, ${theme}`, async () => {
			const { postType } = await admin.api.postTypes.create({
				siteId,
				name: `Notes ${theme}`,
				urlPattern: `/notes-${theme}/{slug}`,
				fields: [{ key: "body", label: "Story", type: "body" }],
			});
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/post-types/${postType.id}`));
			await page.getByRole("button", { name: /^Story/ }).click();
			const allowed = page.getByRole("group", { name: "Allowed Components" });
			await allowed.getByRole("checkbox", { name: "Note", exact: true }).check();
			await expectNoAxeViolations(page, `allowed Body Components (${theme})`);
			await page.getByRole("button", { name: "Save changes", exact: true }).click();
			let fields: unknown;
			for (let look = 0; look < 40; look++) {
				fields = (await admin.api.postTypes.get({ siteId, postTypeId: postType.id })).postType.fields;
				if (JSON.stringify(fields).includes(noteId)) break;
				await Bun.sleep(200);
			}
			expect((fields as unknown[])[0]).toMatchObject({ components: [noteId] });
			await page.close();
		});
	}
});
