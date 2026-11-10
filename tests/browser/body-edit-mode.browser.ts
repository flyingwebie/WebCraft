// The block editor in Edit mode (#79), in a real browser: a page's body edited Block by Block where it
// shows, the `/` menu offering the Blocks and the Components the Body field allows (a Component's
// Props filled in a form before it goes in), each Block's tools (Alt+F10 from its text), and on a
// phone Move up and Move down instead of dragging. Each passes axe and the keyboard checks, in light
// and dark, and what is changed reaches the Draft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let noteId: string;
const slug = "bakery";

type Block = { id: string; type: string; text?: { text: string }[]; component?: string; props?: unknown[] };

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Staff" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;

	const { component } = await api.components.create({
		siteId,
		name: "Note",
		props: [{ key: "text", label: "Note text", type: "text", required: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<aside><p>{{ props.text }}</p></aside>",
	});
	await api.components.publish({ siteId, componentId: component.id });
	noteId = component.id;

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Articles",
		urlPattern: "/articles/{slug}",
		fields: [{ key: "body", label: "Story", type: "body", components: [noteId] }],
	});
	postTypeId = postType.id;
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header><p><a href="/">Acme Bakery</a></p></header><main>{{@outlet}}</main><footer><p>Cork</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1><div>{{ body }}</div></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
});

afterAll(async () => {
	await install.close();
});

let articles = 0;

/** A published Article with a body of a few Blocks; answers its id and path. */
async function article(): Promise<{ entryId: string; path: string }> {
	const { api } = await install.install.superadmin();
	const articleSlug = `article-${++articles}`;
	const { entry } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Spring menu",
		slug: articleSlug,
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
	await api.entries.publish({ siteId, entryId: entry.id });
	return { entryId: entry.id, path: `/articles/${articleSlug}` };
}

/** Each person's edit cookie from the first time Edit mode opened (the link works once). */
let editCookies: Cookie[] | null = null;

/** A page in Edit mode as the Editor, with its body ready to edit; at a phone's size with `phone`. */
async function editModePage(theme: Theme, path: string, options: { phone?: boolean } = {}): Promise<Page> {
	const page = await install.newPage(theme);
	if (options.phone) await page.setViewportSize({ width: 390, height: 844 });
	if (editCookies) {
		await page.context().addCookies(editCookies);
	} else {
		await install.signIn(page, editor);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		editCookies = (await page.context().cookies()).filter((cookie) => cookie.name === "webcraft.edit");
	}
	await page.addInitScript(() => {
		try {
			window.localStorage.setItem("webcraft-edit-hint", "seen");
		} catch {
			// No storage: the hint shows.
		}
	});
	await page.goto(install.siteUrl(slug, path));
	await page.locator("webcraft-edit-bar").waitFor({ state: "attached" });
	// The body part has made the Blocks editable.
	await page.locator('[data-wc-type="body"] [data-wc-block-id]').first().waitFor();
	await page.locator('[data-wc-type="body"] aside').getByText("Closed on Mondays.").waitFor();
	return page;
}

async function bodyOf(entryId: string): Promise<Block[]> {
	const { api } = await install.install.superadmin();
	const { entry } = await api.entries.get({ siteId, entryId });
	return entry.draft.fields.body as Block[];
}

/** What `read` gives once `done` accepts it, waiting up to 8 seconds. */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 8000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(200);
		value = await read();
	}
	return value;
}

/** Whether focus (through the bar's shadow root) is inside the element `inside` finds. */
async function focusedText(page: Page): Promise<string> {
	return page.evaluate(() => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return active?.getAttribute("aria-label") ?? active?.textContent ?? "";
	});
}

for (const theme of THEMES) {
	describe(`the block editor in Edit mode, ${theme}`, () => {
		test("a body's Blocks, edited where they show", async () => {
			const { path } = await article();
			const page = await editModePage(theme, path);

			await expectAccessibleScreen(page, `Edit mode › body (${theme})`);
		});

		test("the / menu offers the Blocks and the Components the body allows; a Component's Props are filled before it goes in", async () => {
			const { entryId, path } = await article();
			const page = await editModePage(theme, path);
			const paragraph = page.locator('[data-wc-type="body"] p[contenteditable]').first();
			await paragraph.click();
			await page.keyboard.press("End");
			await page.keyboard.press("Enter");
			await page.keyboard.press("/");

			const chooser = page.getByRole("dialog", { name: "Blocks" });
			await chooser.waitFor();
			await expectNoAxeViolations(page, `Edit mode › / menu (${theme})`, ["region"]);
			expect(await focusedText(page)).toBe("Blocks");
			await page.keyboard.type("note");
			await page.keyboard.press("Enter");

			const form = page.getByRole("dialog", { name: "Note: Props" });
			await form.waitFor();
			await expectNoAxeViolations(page, `Edit mode › a Component's Props (${theme})`, ["region"]);
			await page.keyboard.type("Ask about gluten-free.");
			await page.keyboard.press("Enter");
			await form.waitFor({ state: "hidden" });

			await page.locator('[data-wc-type="body"] aside').getByText("Ask about gluten-free.").waitFor();
			const blocks = await eventually(
				() => bodyOf(entryId),
				(body) => body.filter((block) => block.type === "component").length === 2,
			);
			expect(blocks.filter((block) => block.type === "component").map((block) => block.props)).toEqual([
				// Right after the paragraph it was typed under.
				[{ name: "text", value: "Ask about gluten-free." }],
				[{ name: "text", value: "Closed on Mondays." }],
			]);
		});

		test("a Block's tools on a phone move it up and down, with no dragging", async () => {
			const { entryId, path } = await article();
			const page = await editModePage(theme, path, { phone: true });
			await page.locator('[data-wc-type="body"] p[contenteditable]').first().click();
			await page.keyboard.press("Alt+F10");
			const tools = page.getByRole("toolbar", { name: /^Paragraph, block 2: tools$/ });
			await tools.waitFor();
			expect(await tools.getByRole("button", { name: /^Drag/ }).count()).toBe(0);
			await expectNoAxeViolations(page, `Edit mode on a phone › a Block's tools (${theme})`, ["region"]);
			const box = await tools.getByRole("button", { name: "Move down" }).boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

			await tools.getByRole("button", { name: "Move down" }).click();
			const blocks = await eventually(
				() => bodyOf(entryId),
				(body) => body[2]?.type === "paragraph",
			);
			expect(blocks.map((block) => block.type)).toEqual(["heading", "list", "paragraph", "callout", "component"]);
		});
	});
}

describe("typing in a body", () => {
	test("what is typed reaches the Draft, and the keyboard reaches each Block's tools and comes back", async () => {
		const { entryId, path } = await article();
		const page = await editModePage("light", path);
		const paragraph = page.locator('[data-wc-type="body"] p[contenteditable]').first();
		await paragraph.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Baked at dawn.");

		const blocks = await eventually(
			() => bodyOf(entryId),
			(body) => JSON.stringify(body[1]?.text).includes("Baked at dawn."),
		);
		expect(blocks[1]).toMatchObject({
			type: "paragraph",
			text: [{ text: "Fresh " }, { text: "every", marks: ["bold"] }, { text: " day. Baked at dawn." }],
		});

		await page.keyboard.press("Alt+F10");
		expect(await focusedText(page)).toMatch(/^Drag to move Paragraph, block 2$/);
		await page.keyboard.press("Escape");
		expect(await paragraph.evaluate((element) => element === document.activeElement)).toBe(true);

		// A Markdown shortcut turns a new paragraph into a heading.
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("### Rolls");
		const turned = await eventually(
			() => bodyOf(entryId),
			(body) => body.some((block) => block.type === "heading" && JSON.stringify(block.text).includes("Rolls")),
		);
		expect(turned[2]).toMatchObject({ type: "heading", level: 3, text: [{ text: "Rolls" }] });
	});
});

test("a refused Component save is announced and is not refreshed as a saved insertion", async () => {
	const { entryId, path } = await article();
	const page = await editModePage("light", path);
	const { api } = await install.install.superadmin();
	// Staff change the allow-list after this editor opened its chooser's catalogue.
	try {
		const paragraph = page.locator('[data-wc-type="body"] p[contenteditable]').first();
		await paragraph.click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.press("/");
		await page.getByRole("dialog", { name: "Blocks" }).waitFor();
		await page.getByRole("combobox", { name: "Blocks" }).fill("note");
		await page.getByRole("combobox", { name: "Blocks" }).press("Enter");
		await page.getByRole("dialog", { name: "Note: Props" }).waitFor();
		await api.postTypes.update({
			siteId,
			postTypeId,
			fields: [{ key: "body", label: "Story", type: "body", components: [] }],
		});
		await page
			.getByRole("dialog", { name: "Note: Props" })
			.getByLabel("Note text", { exact: false })
			.fill("Must not be saved.");
		await page
			.getByRole("dialog", { name: "Note: Props" })
			.getByRole("button", { name: "Insert", exact: true })
			.click();
		await page
			.locator('webcraft-edit-bar [role="status"]')
			.filter({ hasText: /Not saved:/ })
			.waitFor();
		expect(JSON.stringify(await bodyOf(entryId))).not.toContain("Must not be saved.");
		expect(await page.locator('[data-wc-type="body"] aside').getByText("Must not be saved.").count()).toBe(0);
	} finally {
		await api.postTypes.update({
			siteId,
			postTypeId,
			fields: [{ key: "body", label: "Story", type: "body", components: [noteId] }],
		});
		await page.close();
	}
});

for (const theme of THEMES) {
	test(`the admin offers allowed Components and their Props from the same / menu, ${theme}`, async () => {
		const { entryId } = await article();
		const page = await install.newPage(theme);
		await install.signIn(page, editor);
		await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		await page.getByRole("textbox", { name: "Paragraph, block 2" }).click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.press("/");
		await page.getByRole("combobox", { name: "Blocks" }).fill("Note");
		await page.getByRole("option", { name: "Note", exact: true }).waitFor();
		await expectNoAxeViolations(page, `admin Component chooser (${theme})`);
		await page.keyboard.press("Enter");
		const form = page.getByRole("dialog", { name: "Note: Props" });
		await form.waitFor();
		await expectNoAxeViolations(page, `admin Component Props (${theme})`);
		await form.getByLabel("Note text", { exact: false }).fill("From the admin.");
		await form.getByRole("button", { name: "Insert", exact: true }).click();
		const blocks = await eventually(
			() => bodyOf(entryId),
			(body) => JSON.stringify(body).includes("From the admin."),
		);
		expect(blocks[2]).toMatchObject({
			type: "component",
			component: noteId,
			props: [{ name: "text", value: "From the admin." }],
		});
		await page.close();
	});
}

test("pasting a document and an image file in the admin converts Blocks and uploads Media", async () => {
	const { entryId } = await article();
	const page = await install.newPage("light");
	await install.signIn(page, editor);
	await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
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
	const blocks = await eventually(
		() => bodyOf(entryId),
		(body) => body.length === 8,
	);
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
	const withImage = await eventually(
		() => bodyOf(entryId),
		(body) => body.length === 9,
	);
	expect(withImage[2]).toMatchObject({ type: "image", media: expect.any(String) });
	await page.close();
});

for (const theme of THEMES) {
	test(`Staff choose the Components allowed in a Body field, ${theme}`, async () => {
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.create({
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
		const result = await eventually(
			() => api.postTypes.get({ siteId, postTypeId: postType.id }),
			(value) => JSON.stringify(value.postType.fields).includes(noteId),
		);
		expect(result.postType.fields[0]).toMatchObject({ components: [noteId] });
		await page.close();
	});
}

test("the admin and Edit mode see each other's Body changes without reloading", async () => {
	const { entryId, path } = await article();
	const onSite = await editModePage("light", path);
	const admin = await install.newPage("light");
	await install.signIn(admin, staff);
	await admin.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
	const paragraph = admin.getByRole("textbox", { name: "Paragraph, block 2" });
	await paragraph.fill("Baked by the admin.");
	await onSite.locator('[data-wc-type="body"] p[contenteditable]').filter({ hasText: "Baked by the admin." }).waitFor();
	const heading = onSite.locator('[data-wc-type="body"] h2[contenteditable]');
	await heading.fill("Breads from Edit mode");
	await admin
		.getByRole("textbox", { name: "Heading 2, block 1" })
		.filter({ hasText: "Breads from Edit mode" })
		.waitFor();
	expect((await bodyOf(entryId)).slice(0, 2)).toMatchObject([
		{ text: [{ text: "Breads from Edit mode" }] },
		{ text: [{ text: "Baked by the admin." }] },
	]);
	await admin.close();
	await onSite.close();
});

test("a Component added by another editor renders without writing an older body back", async () => {
	const { entryId, path } = await article();
	const page = await editModePage("light", path);
	const { api } = await install.install.superadmin();
	const before = await bodyOf(entryId);
	await api.entries.saveDraft({
		siteId,
		entryId,
		fields: {
			body: [
				...before,
				{ type: "component", component: noteId, props: [{ name: "text", value: "Added by another editor." }] },
			],
		},
	});
	await page.locator('[data-wc-type="body"] aside').getByText("Added by another editor.").waitFor();
	expect(JSON.stringify(await bodyOf(entryId))).toContain("Added by another editor.");
	await page.close();
});

test("typing in Edit mode keeps another editor's changes during autosave", async () => {
	const { entryId, path } = await article();
	const onSite = await editModePage("light", path);
	const admin = await install.newPage("light");
	await install.signIn(admin, staff);
	await admin.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
	const heading = onSite.locator('[data-wc-type="body"] h2[contenteditable]');
	await heading.fill("Breads");
	await heading.press("End");
	await Promise.all([
		heading.pressSequentially(" for our spring menu", { delay: 80 }),
		admin.getByRole("textbox", { name: "Paragraph, block 2" }).fill("Baked by the other editor."),
	]);
	const body = await eventually(bodyOf.bind(null, entryId), (blocks) =>
		JSON.stringify(blocks).includes("Breads for our spring menu"),
	);
	expect(body.slice(0, 2)).toMatchObject([
		{ text: [{ text: "Breads for our spring menu" }] },
		{ text: [{ text: "Baked by the other editor." }] },
	]);
	await onSite
		.locator('[data-wc-type="body"] p[contenteditable]')
		.filter({ hasText: "Baked by the other editor." })
		.waitFor();
	await admin.close();
	await onSite.close();
});

test("a focused Block shows remote changes before the next keystroke", async () => {
	const { entryId, path } = await article();
	const page = await editModePage("light", path);
	const heading = page.locator('[data-wc-type="body"] h2[contenteditable]');
	await heading.focus();
	const { api } = await install.install.superadmin();
	const before = await bodyOf(entryId);
	await api.entries.saveDraft({
		siteId,
		entryId,
		fields: { body: before.map((block, index) => (index === 0 ? { ...block, text: "Today's breads" } : block)) },
	});
	await heading.filter({ hasText: "Today's breads" }).waitFor();
	expect(await heading.evaluate((element) => document.activeElement === element)).toBe(true);
	await heading.press("End");
	await heading.pressSequentially(" and pastries");
	const body = await eventually(bodyOf.bind(null, entryId), (blocks) =>
		JSON.stringify(blocks).includes("Today's breads and pastries"),
	);
	expect(body[0]?.text).toEqual([{ text: "Today's breads and pastries" }]);
	await page.close();
});
