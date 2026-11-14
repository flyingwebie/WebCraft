// Post Types and Fields in the building area's Content place (ADR 0037, BA-21; SPEC 8 and 10;
// `places-content/02` and `03`), in Chromium:
// - the Post Types list shows each Post Type with its key, URL pattern, Templates made or not and
//   Entries, the Page Post Type locked; the sidebar's "+" focuses the create row, and Enter there
//   makes a Post Type and opens its Fields;
// - Fields are added (a Group with its first Field too), renamed, made required, reordered with the
//   arrows on their grip and by dragging, and deleted with a second click; each change is saved;
// - Settings rename a Post Type; the dialog deleting one names its Entries and Templates, starts on
//   Cancel, and is refused while another Post Type's Relationship points at it;
// - a Member gets none of it;
// - the list, the Fields and the dialog pass the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let blogId: string;
let teamId: string;
let pagesId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Menu", "menu"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: entry.id });
	}
	const team = await api.postTypes.create({ siteId, name: "Team", key: "team", urlPattern: "/team/{slug}" });
	teamId = team.postType.id;
	for (const title of ["Ada", "Grace"]) await api.entries.create({ siteId, postTypeId: teamId, title });
	const blog = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "post",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "excerpt", label: "Excerpt", type: "text", translatable: true },
			{ key: "author", label: "Author", type: "relationship", postTypes: ["team"] },
			{
				key: "seo",
				label: "SEO",
				type: "group",
				fields: [{ key: "meta_title", label: "Meta title", type: "text" }],
			},
		],
	});
	blogId = blog.postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: blogId,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	for (const title of ["Rye", "Spelt", "Sourdough"]) await api.entries.create({ siteId, postTypeId: blogId, title });
});

afterAll(async () => {
	await install?.close();
});

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

/** The shell's address with a place open over the menu page. */
const placed = (place: string, view?: string) =>
	`/page/menu?wc-place=${encodeURIComponent(place)}${view ? `&wc-view=${encodeURIComponent(view)}` : ""}`;

/** The Fields of a Post Type, as the API reads them now: their paths, in order. */
async function fieldPaths(postTypeId: string): Promise<string[]> {
	const { postType } = await superadmin.api.postTypes.get({ siteId, postTypeId });
	const paths = (fields: readonly { key: string; type: string; fields?: unknown }[], prefix = ""): string[] =>
		fields.flatMap((field) => [
			`${prefix}${field.key}`,
			...(Array.isArray(field.fields) ? paths(field.fields as typeof fields, `${prefix}${field.key}.`) : []),
		]);
	return paths(postType.fields);
}

/** Waits until the API reads what the place saved. */
async function eventually(read: () => Promise<unknown>, expected: unknown): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (JSON.stringify(await read()) === JSON.stringify(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	expect(await read()).toEqual(expected);
}

/** The rows of the Fields list, by path, in order. */
const rowPaths = (page: Page) =>
	page.locator("[data-wc-field-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-wc-field-row")));

describe("Post Types and Fields, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the list shows each Post Type; the sidebar's + focuses the create row, and Enter makes one and opens its Fields", async () => {
		await go(page, placed("content/pages"));
		await page.locator("[data-wc-content-lists]").waitFor();
		await page.locator("[data-wc-new-post-type]").click();
		await page.locator("[data-wc-post-types-grid]").waitFor();
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("content/post-types");
		await page.waitForFunction(() => document.activeElement?.hasAttribute("data-wc-new-post-type-name"));
		expect(await page.locator('[data-wc-content-row="post-types"]').getAttribute("aria-current")).toBe("page");

		// Pages first, locked and without a bin; each row's key, URL pattern, Templates and Entries.
		const rows = page.locator("[data-wc-post-type]");
		expect(await rows.evaluateAll((all) => all.map((row) => row.getAttribute("data-wc-post-type")))).toEqual([
			"page",
			"post",
			"team",
		]);
		await page.locator('[data-wc-post-type="post"] td:nth-child(4)', { hasText: "Made" }).waitFor();
		const cells = async (key: string) =>
			(await page.locator(`[data-wc-post-type="${key}"] td`).allTextContents()).slice(0, 6);
		expect(await cells("post")).toEqual(["Blog posts", "post", "/blog/{slug}", "Made", "Not made yet", "3"]);
		expect(await cells("team")).toEqual(["Team", "team", "/team/{slug}", "Not made yet", "Not made yet", "2"]);
		expect(await page.locator('[data-wc-post-type="page"] [data-wc-post-type-delete]').count()).toBe(0);
		expect(await page.locator('[data-wc-post-type="page"]').textContent()).toContain("every Site has Pages");
		expect(await page.locator("[data-wc-post-types-count]").textContent()).toBe("3 Post Types");
		// Sizes of the grid (SPEC 4): its header 35 and rows 46, the create row 50.
		expect((await page.locator("[data-wc-post-types-grid] thead tr").boundingBox())?.height).toBe(35);
		expect((await rows.first().boundingBox())?.height).toBe(46);
		expect((await page.locator("[data-wc-post-type-create]").boundingBox())?.height).toBe(50);

		// The key and URL pattern follow the name unless given.
		await page.locator("[data-wc-new-post-type-name]").fill("Open days");
		expect(await page.locator("[data-wc-new-post-type-key]").getAttribute("placeholder")).toBe("open-days");
		expect(await page.locator("[data-wc-new-post-type-pattern]").getAttribute("placeholder")).toBe("/open-days/{slug}");
		await page.locator("[data-wc-new-post-type-name]").press("Enter");

		await page.waitForURL((url) => /^content\/[0-9a-f-]{36}\/fields$/.test(url.searchParams.get("wc-place") ?? ""));
		const made = (await superadmin.api.postTypes.list({ siteId })).postTypes.find((type) => type.key === "open-days");
		expect(made).toMatchObject({ name: "Open days", urlPattern: "/open-days/{slug}", fields: [] });
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe(`content/${made?.id}/fields`);
		await page.locator('[data-wc-fields="open-days"]').waitFor();
		// Its row in the sidebar, the open one.
		expect(await page.locator(`[data-wc-content-row="${made?.id}"]`).getAttribute("aria-current")).toBe("page");
		expect(await page.locator(`[data-wc-content-row="${made?.id}"]`).textContent()).toBe("Open days0");
	});

	test("a refused Post Type says why at the create row, and nothing is made", async () => {
		await go(page, placed("content/post-types"));
		await page.locator("[data-wc-post-types-grid]").waitFor();
		await page.locator("[data-wc-new-post-type-name]").fill("Bakers");
		await page.locator("[data-wc-new-post-type-key]").fill("team");
		await page.locator("[data-wc-new-post-type-create]").click();

		await page.locator("[data-wc-post-type-problem]").waitFor();
		expect(await page.locator("[data-wc-post-type-problem]").textContent()).toContain("another Post Type");
		expect((await superadmin.api.postTypes.list({ siteId })).postTypes.map((type) => type.name)).not.toContain(
			"Bakers",
		);
	});

	test("Fields: added, renamed, required, reordered with the arrows and by dragging, and deleted with a second click", async () => {
		await go(page, placed(`content/${blogId}/fields`));
		await page.locator('[data-wc-fields="post"]').waitFor();
		// The tabs: Fields is the open one; the Blog posts row is the sidebar's.
		expect(await page.locator('[data-wc-post-type-tab-button="fields"]').getAttribute("aria-current")).toBe("page");
		expect(await page.locator(`[data-wc-content-row="${blogId}"]`).getAttribute("aria-current")).toBe("page");
		expect(await rowPaths(page)).toEqual(["excerpt", "author", "seo", "seo.meta_title"]);
		// A Field inside a Group is 22 px further in; rows are 36 high, the details panel 320 wide.
		const outer = await page.locator('[data-wc-field-row="seo"] [data-wc-field-grip]').boundingBox();
		const inner = await page.locator('[data-wc-field-row="seo.meta_title"] [data-wc-field-grip]').boundingBox();
		expect((inner?.x ?? 0) - (outer?.x ?? 0)).toBe(22);
		expect((await page.locator('[data-wc-field-row="excerpt"] > div').boundingBox())?.height).toBe(36);
		expect((await page.locator("[data-wc-field-panel]").boundingBox())?.width).toBe(320);
		expect(await page.locator('[data-wc-field-row="excerpt"]').textContent()).toContain("Translatable");

		// Choosing a Field shows its details and puts it in the address.
		await page.locator('[data-wc-field-choose="author"]').click();
		await page.locator('[data-wc-field-details="author"]').waitFor();
		expect(new URL(page.url()).searchParams.get("wc-view")).toBe("field=author");
		const details = (await page.locator('[data-wc-field-details="author"]').textContent()) ?? "";
		expect(details).toContain("Relationship Field");
		expect(details).toContain("Keyauthor");
		expect(await page.locator('[data-wc-field-points-at] input[type="checkbox"]:checked').count()).toBe(1);

		// A new Field at the end: Number.
		await page.locator("[data-wc-field-new]").click();
		await page.locator("[data-wc-new-field-label]").fill("Price");
		expect(await page.locator("[data-wc-new-field-key]").getAttribute("placeholder")).toBe("price");
		await page.locator("[data-wc-new-field-kind]").selectOption("number");
		await page.locator("[data-wc-new-field-add]").click();
		await page.locator('[data-wc-field-details="price"]').waitFor();
		await eventually(() => fieldPaths(blogId), ["excerpt", "author", "seo", "seo.meta_title", "price"]);

		// Renamed (saved when the label is left) and made required (at once).
		await page.locator('[data-wc-field-details="price"] [data-wc-field-setting="label"]').fill("Price in euro");
		await page.locator('[data-wc-field-details="price"] [data-wc-field-setting="label"]').press("Tab");
		await page.locator('[data-wc-field-details="price"] [role="switch"]').first().click();
		const read = async () => {
			const { postType } = await superadmin.api.postTypes.get({ siteId, postTypeId: blogId });
			const price = postType.fields.find((field) => field.key === "price");
			return { label: price?.label, required: price?.required };
		};
		await eventually(read, { label: "Price in euro", required: true });
		expect(await page.locator('[data-wc-field-row="price"]').textContent()).toContain("required");

		// Up twice with the arrows on its grip; focus stays on the grip.
		await page.locator('[data-wc-field-grip="price"]').focus();
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await eventually(() => fieldPaths(blogId), ["excerpt", "price", "author", "seo", "seo.meta_title"]);
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-field-grip"))).toBe("price");
		expect(await announced(page)).toContain("Price in euro moved to place 2 of 4");

		// Dragged to the top by its grip.
		await page.locator('[data-wc-field-grip="price"]').dragTo(page.locator('[data-wc-field-row="excerpt"]'), {
			targetPosition: { x: 40, y: 4 },
		});
		await eventually(() => fieldPaths(blogId), ["price", "excerpt", "author", "seo", "seo.meta_title"]);
		expect(await rowPaths(page)).toEqual(["price", "excerpt", "author", "seo", "seo.meta_title"]);

		// A Group starts with its first Field.
		await page.locator("[data-wc-field-new]").click();
		await page.locator("[data-wc-new-field-label]").fill("Credits");
		await page.locator("[data-wc-new-field-kind]").selectOption("group");
		await page.locator("[data-wc-new-field-add]").click();
		expect(await page.locator("[data-wc-new-field]").textContent()).toContain(
			"A Group or Repeater holds at least one Field",
		);
		await page.locator("[data-wc-new-field-inner]").fill("Photographer");
		await page.locator("[data-wc-new-field-add]").click();
		await page.locator('[data-wc-field-details="credits"]').waitFor();
		await eventually(
			() => fieldPaths(blogId),
			["price", "excerpt", "author", "seo", "seo.meta_title", "credits", "credits.photographer"],
		);

		// Delete Field asks for a second click.
		await page.locator('[data-wc-field-choose="price"]').click();
		await page.locator("[data-wc-field-delete]").click();
		expect(await page.locator("[data-wc-field-delete]").textContent()).toBe("Delete Price in euro? Click again");
		expect(await fieldPaths(blogId)).toContain("price");
		await page.locator("[data-wc-field-delete]").click();
		await eventually(
			() => fieldPaths(blogId),
			["excerpt", "author", "seo", "seo.meta_title", "credits", "credits.photographer"],
		);
		expect(await page.locator('[data-wc-field-row="price"]').count()).toBe(0);
		expect(new URL(page.url()).searchParams.get("wc-view")).toBeNull();
	});

	test("a refused change shows its problem at the setting, and keeps it on screen", async () => {
		await go(page, placed(`content/${blogId}/fields`, "field=excerpt"));
		await page.locator('[data-wc-field-details="excerpt"]').waitFor();
		const label = page.locator('[data-wc-field-details="excerpt"] [data-wc-field-setting="label"]');
		await label.fill("");
		await label.press("Enter");

		await page.locator('[data-wc-field-details="excerpt"] [role="alert"]').waitFor();
		expect(await page.locator('[data-wc-field-details="excerpt"] [role="alert"]').textContent()).toBe(
			"A label has 1 to 100 characters.",
		);
		expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("Could not save");
		const { postType } = await superadmin.api.postTypes.get({ siteId, postTypeId: blogId });
		expect(postType.fields.find((field) => field.key === "excerpt")?.label).toBe("Excerpt");

		await label.fill("Summary");
		await label.press("Enter");
		await page.locator('[data-wc-field-details="excerpt"] [role="alert"]').waitFor({ state: "detached" });
	});

	test("Settings rename a Post Type, and the tabs go between its Entries, Fields and Settings", async () => {
		await go(page, placed(`content/${teamId}/settings`));
		await page.locator('[data-wc-post-type-settings="team"]').waitFor();
		await page.locator('[data-wc-post-type-setting="name"]').fill("Our team");
		await page.locator('[data-wc-post-type-setting="name"]').press("Enter");
		await eventually(
			async () => (await superadmin.api.postTypes.get({ siteId, postTypeId: teamId })).postType.name,
			"Our team",
		);
		await page.locator(`[data-wc-content-row="${teamId}"]`, { hasText: "Our team" }).waitFor();

		await page.locator('[data-wc-post-type-tab-button="entries"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === `content/${teamId}`);
		await page.locator(`[data-wc-entries="${teamId}"]`).waitFor();
		await page.goBack();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === `content/${teamId}/settings`);
		await page.locator('[data-wc-post-type-settings="team"]').waitFor();
	});

	test("deleting: the dialog names what goes and starts on Cancel; it is refused while a Relationship points at it", async () => {
		await go(page, placed("content/post-types"));
		await page.locator("[data-wc-post-types-grid]").waitFor();

		// Team: Blog posts' Author points at it.
		await page.locator('[data-wc-post-type-delete="team"]').click();
		const dialog = page.locator("[data-wc-delete-post-type]");
		await dialog.locator("[data-wc-used-in]").waitFor();
		expect(await dialog.textContent()).toContain("Our team can't be deleted yet");
		expect(await dialog.locator("[data-wc-used-in]").textContent()).toBe("Blog posts › author: a Relationship Field");
		expect(await dialog.locator("[data-wc-dialog-delete]").count()).toBe(0);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-post-type-delete"))).toBe("team");
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("content/post-types");

		// Blog posts: its Entries and Templates go with it.
		await page.locator('[data-wc-post-type-delete="post"]').click();
		await dialog.locator("[data-wc-dialog-delete]:not([disabled])").waitFor();
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-dialog-cancel"))).toBe(true);
		expect(await dialog.textContent()).toContain(
			"Blog posts has 3 Entries and 1 Template. Deleting this Post Type removes them too, and cannot be undone.",
		);
		await expectNoAxeViolations(page, "building area, deleting a Post Type");
		await dialog.locator("[data-wc-dialog-cancel]").click();
		await dialog.waitFor({ state: "detached" });
		expect((await superadmin.api.postTypes.list({ siteId })).postTypes.map((type) => type.key)).toContain("post");

		await page.locator('[data-wc-post-type-delete="post"]').click();
		await dialog.locator("[data-wc-dialog-delete]:not([disabled])").click();
		await dialog.waitFor({ state: "detached" });
		await page.locator('[data-wc-post-type="post"]').waitFor({ state: "detached" });
		expect(await announced(page)).toBe("Blog posts deleted, with its Entries and Templates");
		expect(await page.locator(`[data-wc-content-row="${blogId}"]`).count()).toBe(0);
		await expect(superadmin.api.postTypes.get({ siteId, postTypeId: blogId })).rejects.toMatchObject({
			code: "POST_TYPE_NOT_FOUND",
		});
	});

	for (const theme of THEMES) {
		test(`the Post Types list and the Fields pass the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, placed("content/post-types"));
			await page.locator("[data-wc-post-type]").first().waitFor();
			await expectAccessibleScreen(page, `building area, Post Types (${theme})`);
			await go(page, placed(`content/${pagesId}/fields`));
			await page.locator('[data-wc-fields="page"]').waitFor();
			await go(page, placed(`content/${teamId}/fields`));
			await page.locator('[data-wc-fields="team"]').waitFor();
			await page.locator("[data-wc-field-new]").click();
			await page.locator("[data-wc-new-field-label]").fill("Role");
			await page.locator("[data-wc-new-field-add]").click();
			await page.locator('[data-wc-field-details="role"]').waitFor();
			await expectAccessibleScreen(page, `building area, a Post Type's Fields (${theme})`);
			await page.emulateMedia({ colorScheme: "light" });
		});
	}
});

describe("Post Types and Fields, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("a Member gets no Post Types list and no Fields, even at their addresses", async () => {
		await go(page, placed("content/post-types"));
		await page.locator("[data-wc-content-lists]").waitFor();
		expect(await page.locator("[data-wc-post-types-grid]").count()).toBe(0);
		expect(await page.locator("[data-wc-new-post-type]").count()).toBe(0);

		await go(page, placed(`content/${teamId}/fields`));
		await page.locator("[data-wc-content-lists]").waitFor();
		expect(await page.locator("[data-wc-fields]").count()).toBe(0);
		expect(await page.locator("[data-wc-place-pane]").textContent()).toContain("There is no such Post Type here.");
	});
});
