// The Post Types & Fields screen, the Entries list, the Entry editor and the Globals editor in a
// browser: axe and keyboard checks in light and dark, with a Field's settings open, problems showing,
// dialogs and menus opened from the keyboard, and the keyboard way to move what can be dragged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let author: TestAccount;
let siteId: string;
let blogId: string;
let pagesId: string;
let entryId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	owner = (await local.createMember({ workspaceId, role: "owner", name: "Sarah Murphy" })).account;
	author = (await local.createMember({ workspaceId, role: "author", name: "Aoife Kelly" })).account;
	const admin = await local.superadmin();

	const { postType: team } = await admin.api.postTypes.create({ siteId, name: "Team", urlPattern: "/team/{slug}" });
	const { entry: aoife } = await admin.api.entries.create({ siteId, postTypeId: team.id, title: "Aoife Kelly" });
	await admin.api.entries.create({ siteId, postTypeId: team.id, title: "Mark O'Brien" });
	const { postType: blog } = await admin.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "excerpt", label: "Excerpt", type: "text", maxLength: 160, help: "One or two sentences for lists." },
			{ key: "body", label: "Body", type: "richText", required: true },
			{ key: "cover", label: "Cover image", type: "media", required: true },
			{ key: "written_by", label: "Written by", type: "relationship", postTypes: ["team"], required: true },
			{ key: "credits", label: "Credits", type: "relationship", postTypes: ["team"], multiple: true },
			{
				key: "recipe",
				label: "Recipe",
				type: "group",
				fields: [
					{ key: "prep_minutes", label: "Prep time", type: "number", integer: true, min: 1 },
					{
						key: "difficulty",
						label: "Difficulty",
						type: "select",
						options: [
							{ value: "easy", label: "Easy" },
							{ value: "hard", label: "Hard" },
						],
					},
				],
			},
			{
				key: "steps",
				label: "Steps",
				type: "repeater",
				fields: [
					{ key: "text", label: "Step text", type: "text" },
					{ key: "photo", label: "Step photo", type: "media" },
				],
			},
			{ key: "featured", label: "Featured", type: "boolean" },
			{ key: "event", label: "Tasting day", type: "date", mode: "dateTime" },
			{
				key: "tags",
				label: "Tags",
				type: "select",
				multiple: true,
				options: [
					{ value: "bread", label: "Bread" },
					{ value: "cakes", label: "Cakes" },
				],
			},
			{ key: "more", label: "Read more", type: "link" },
			{ key: "contact", label: "Contact", type: "email" },
		],
	});
	blogId = blog.id;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 640, height: 480 }), "spring-loaves.jpg"),
	});
	await local.drainJobs();
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: blog.id,
		title: "Spring menu 2027",
		fields: {
			excerpt: "Three new loaves and a lemon tart.",
			cover: media.id,
			written_by: aoife.id,
			recipe: { prep_minutes: 0, difficulty: "easy" },
			steps: [{ text: "Feed the starter the night before" }, { text: "Mix with spelt flour" }],
			tags: ["bread"],
		},
	});
	entryId = entry.id;
	await admin.api.entries.create({ siteId, postTypeId: blog.id, title: "Gluten-free range" });

	pagesId = (await admin.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id ?? "";
	const { entry: about } = await admin.api.entries.create({ siteId, postTypeId: pagesId, title: "About us" });
	await admin.api.entries.create({ siteId, postTypeId: pagesId, title: "Our team", parentId: about.id });

	await admin.api.globals.setFields({
		siteId,
		fields: [
			{ key: "phone", label: "Phone", type: "text", required: true },
			{ key: "footer", label: "Footer text", type: "richText" },
			{
				key: "address",
				label: "Address",
				type: "group",
				fields: [
					{ key: "street", label: "Street", type: "text" },
					{ key: "city", label: "City", type: "text" },
				],
			},
		],
	});
});

afterAll(async () => {
	await install.close();
});

async function open(page: Page, account: TestAccount, path: string): Promise<void> {
	await install.signIn(page, account);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

for (const theme of THEMES) {
	describe(`Post Types & Fields, ${theme}`, () => {
		test("the Field list, with a Field's settings open in the side panel", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/post-types/${blogId}`);
			await expectAccessibleScreen(page, `Post Types & Fields (${theme})`);

			await page.getByRole("button", { name: /^Written by/ }).click();
			await page.getByRole("heading", { level: 2, name: "Written by" }).waitFor();
			await expectAccessibleScreen(page, `Post Types & Fields, a Relationship's settings (${theme})`);

			await page.getByRole("button", { name: /^Difficulty/ }).click();
			await page.getByRole("heading", { level: 2, name: "Difficulty" }).waitFor();
			await expectAccessibleScreen(page, `Post Types & Fields, a select Field inside a Group (${theme})`);
		});

		test("a Field moves with the keyboard, the drag handle's alternative", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/post-types/${blogId}`);
			const trigger = page.getByRole("button", { name: "Actions for Excerpt" });
			await expectOverlayUsable(page, trigger, "menu", `a Field's menu (${theme})`);

			await trigger.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Move down" }).waitFor();
			await page.getByRole("menuitem", { name: "Move down" }).focus();
			await page.keyboard.press("Enter");

			await page.getByText("Excerpt moved to place 2 of 12.").waitFor({ state: "attached" });
			const [first, second] = await page.locator("button[id^=field-row-]").allTextContents();
			expect([first?.startsWith("Body"), second?.startsWith("Excerpt")]).toEqual([true, true]);
		});

		test("the Add Field menu and the New Post Type dialog open from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/post-types/${blogId}`);

			await expectOverlayUsable(page, page.getByRole("button", { name: /^Add Field/ }), "menu", `Add Field (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "New Post Type" }),
				"dialog",
				`New Post Type (${theme})`,
			);
		});

		test("a setting the server refuses shows where it belongs, and in the list above the Fields", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/post-types/${blogId}`);
			await page.getByRole("button", { name: /^Add Field/ }).click();
			await page.getByRole("menuitem", { name: "Select" }).click();
			await page.getByRole("heading", { level: 2, name: "Select" }).waitFor();

			await page.getByRole("button", { name: "Save changes" }).click();

			await page.getByText("Nothing was saved.", { exact: false }).waitFor();
			await page.locator("#setting-options-problems").waitFor();
			await expectAccessibleScreen(page, `Post Types & Fields, a refused setting (${theme})`);
		});

		test("the Globals' Fields", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/post-types/globals`);
			await page.getByRole("button", { name: /^Address/ }).click();
			await page.getByRole("heading", { level: 2, name: "Address" }).waitFor();

			await expectAccessibleScreen(page, `Post Types & Fields, the Globals (${theme})`);
		});
	});

	describe(`Entries, ${theme}`, () => {
		test("a Post Type's Entries, searched and filtered", async () => {
			const page = await install.newPage(theme);
			await open(page, owner, `/sites/${siteId}/entries/${blogId}`);
			await expectAccessibleScreen(page, `Entries (${theme})`);

			await page.getByRole("button", { name: /^Drafts/ }).click();
			await page.getByLabel("Search Blog posts").fill("spring");
			await page.waitForURL((url) => url.searchParams.get("q") === "spring");
			await page.getByRole("link", { name: "Gluten-free range" }).waitFor({ state: "detached" });
			await page.getByRole("link", { name: "Spring menu 2027" }).waitFor();
			await expectAccessibleScreen(page, `Entries, searched and filtered (${theme})`);
		});

		test("Pages as a tree, and the New dialog from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/entries/${pagesId}`);
			await page.getByText("/about-us/our-team").waitFor();
			await expectAccessibleScreen(page, `Pages (${theme})`);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "New in Pages" }),
				"dialog",
				`New Page (${theme})`,
			);
		});

		test("the Entry editor with every Field type, problems showing next to their values", async () => {
			const page = await install.newPage(theme);
			await open(page, owner, `/sites/${siteId}/entries/${blogId}/${entryId}`);
			await page.locator("#entry-fields-body-problems").waitFor();
			await page.getByText("Use 1 or more.").first().waitFor();

			await expectAccessibleScreen(page, `Entry editor (${theme})`);
		});

		test("the Entry editor's dialogs and menus open from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, owner, `/sites/${siteId}/entries/${blogId}/${entryId}`);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /^Change Cover image/ }),
				"dialog",
				`Media chooser (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add a link" }),
				"dialog",
				`Add a link (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for row 1" }),
				"menu",
				`a row's menu (${theme})`,
			);
		});

		test("a Repeater row moves with the keyboard, and the move saves to the Draft", async () => {
			const admin = await install.install.superadmin();
			const steps = async () => {
				const { entry } = await admin.api.entries.get({ siteId, entryId });
				return (entry.draft.fields.steps as { text: string }[]).map((row) => row.text);
			};
			const before = await steps();
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/entries/${blogId}/${entryId}`);
			const trigger = page.getByRole("button", { name: "Actions for row 1" });
			await trigger.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Move down" }).focus();
			await page.keyboard.press("Enter");

			await page.getByText("Row 1 moved to place 2 of 2.").waitFor({ state: "attached" });
			let after = before;
			for (let look = 0; look < 50 && after[0] === before[0]; look++) {
				await page.waitForTimeout(100);
				after = await steps();
			}
			expect(after).toEqual([before[1] ?? "", before[0] ?? ""]);
		});

		test("Authors see no Publish button: they save Drafts", async () => {
			const page = await install.newPage(theme);
			await open(page, author, `/sites/${siteId}/entries/${blogId}/${entryId}`);
			await page.getByText("An Editor or Owner publishes them.", { exact: false }).waitFor();

			expect(await page.getByRole("button", { name: "Publish", exact: true }).count()).toBe(0);
			await expectAccessibleScreen(page, `Entry editor as an Author (${theme})`);
		});
	});

	describe(`Globals, ${theme}`, () => {
		test("the Globals editor", async () => {
			const page = await install.newPage(theme);
			await open(page, owner, `/sites/${siteId}/globals`);
			await page.getByLabel("Phone", { exact: false }).waitFor();

			await expectAccessibleScreen(page, `Globals (${theme})`);
		});
	});
}

describe("Members see Content only", () => {
	test("an Owner's sidebar has no Structure group, and Post Types & Fields says they can't open it", async () => {
		const page = await install.newPage("light");
		await open(page, owner, `/sites/${siteId}`);
		const navigation = page.getByRole("navigation", { name: "Admin" });
		await navigation.getByRole("link", { name: "Blog posts" }).waitFor();

		expect(await navigation.getByText("Structure").count()).toBe(0);
		expect(await navigation.getByRole("link", { name: "Post Types & Fields" }).count()).toBe(0);

		await page.goto(install.adminUrl(`/sites/${siteId}/post-types/${blogId}`));
		await page.getByRole("heading", { level: 1, name: "You can't open this page" }).waitFor();
		await expectNoAxeViolations(page, "Post Types & Fields as an Owner");
	});

	test("Staff see the Structure group", async () => {
		const page = await install.newPage("light");
		await open(page, staff, `/sites/${siteId}`);
		const navigation = page.getByRole("navigation", { name: "Admin" });

		await navigation.getByRole("link", { name: "Post Types & Fields" }).waitFor();
	});
});
