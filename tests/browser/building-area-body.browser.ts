// Writing a post in the building area (ADR 0037, BA-18; SPEC 13.5, `client-flows/01`), for a Member,
// in Chromium. The building area's version of every Edit mode case of `body-edit-mode.browser.ts`:
// - an Entry's body is edited Block by Block where it shows; the block editor is loaded into the page
//   only when a page shows a body, and its tools are drawn by the shell over the frame;
// - `/` on an empty line opens the Block list (tiles, then "Sections your agency made"); a
//   Component's Props are filled before it goes in, right after the line it was opened from;
// - at a phone's width a Block's tools move it up and down, with no dragging;
// - what is typed reaches the Draft; Alt+F10 reaches a Block's tools and Escape comes back; Markdown
//   shortcuts turn a line into a heading;
// - a Component save the server refuses is said and never shown as saved;
// - a paste keeps its place while it is converted, and pasted images aren't uploaded where the Body
//   field has images switched off;
// - the admin and the building area see each other's changes without a reload, during autosave too,
//   a focused Block keeping its caret;
// and client editing's own: the body is one marked area (dashed at rest, "Click to edit", "{label} ·
// Blocks" while written in), Tab reaches it, Enter starts writing, Escape finishes then closes the
// side panel, Preview takes every mark and the editing away, the bar says "Post details", and the
// Draft's state follows the saves. Each state passes axe and the keyboard checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let noteId: string;
let aboutPath: string;
const slug = "bakery";

type Block = { id: string; type: string; text?: { text: string }[]; component?: string; props?: unknown[] };

const BODY = '[data-wc-type="body"]';
const TOOLS = "[data-wc-body-tools]";

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

	// A Page, which shows no body: the block editor never loads there.
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page");
	const { entry: about } = await api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "About us",
		slug: "about",
	});
	await api.entries.publish({ siteId, entryId: about.id });
	aboutPath = "/about";
});

afterAll(async () => {
	await install?.close();
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

/**
 * The cookies of the building area, from the first time it was entered: `/_webcraft/edit/enter` takes
 * a few uses a minute from one address, so every page after the first opens the shell with them.
 */
let cookies: Cookie[] | null = null;

/**
 * The building area as the Editor, at a post (or any page): its body ready to write in. At a phone's
 * width with `phone` (the bar's Phone).
 */
async function writing(
	theme: Theme,
	path: string,
	options: { phone?: boolean } = {},
): Promise<{ page: Page; frame: Frame }> {
	const page = await install.newPage(theme);
	await page.setViewportSize({ width: 1440, height: 900 });
	let frame: Frame;
	if (cookies) {
		await page.context().addCookies(cookies);
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
		frame = await frameOf(page);
	} else {
		frame = await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${path}` });
		cookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("webcraft."));
	}
	if (options.phone) {
		await page.locator('[data-wc-segment="phone"]').click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-frame-box]")?.getBoundingClientRect().width === 390,
		);
	}
	if (path !== aboutPath) {
		// The block editor has made the Blocks editable, and the Component shows as rendered.
		await frame.locator(`${BODY} [data-wc-block-id]`).first().waitFor();
		await frame.locator(`${BODY} aside`).getByText("Closed on Mondays.").first().waitFor();
	}
	return { page, frame };
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

/** What has focus, across the shell and its frame: its accessible name, else its words. */
async function focusedText(page: Page): Promise<string> {
	return page.evaluate(() => {
		let active: Element | null = document.activeElement;
		while (active instanceof HTMLIFrameElement) active = active.contentDocument?.activeElement ?? null;
		return active?.getAttribute("aria-label") ?? active?.textContent ?? "";
	});
}

/** Waits until what has focus is named `name` (the editor moves focus a moment after it draws). */
async function focusOn(page: Page, name: string | RegExp): Promise<string> {
	const deadline = Date.now() + 3000;
	let found = await focusedText(page);
	while (!(typeof name === "string" ? found === name : name.test(found)) && Date.now() < deadline) {
		await page.waitForTimeout(25);
		found = await focusedText(page);
	}
	return found;
}

/** Whether focus is in the frame's page, on an element `test` accepts. */
async function focusedInPage(frame: Frame, test: string): Promise<boolean> {
	return frame.evaluate((selector) => document.hasFocus() && document.activeElement?.matches(selector) === true, test);
}

for (const theme of THEMES) {
	describe(`writing a post in the building area, ${theme}`, () => {
		test("a body's Blocks are edited where they show; the body is one marked area", async () => {
			const { path } = await article();
			const { page, frame } = await writing(theme, path);
			try {
				// Its Blocks are the page's own elements, editable; the body is a group named after its Field.
				expect(await frame.locator(`${BODY} h2[contenteditable="true"]`).textContent()).toBe("Breads");
				expect(await frame.locator(BODY).getAttribute("aria-label")).toBe("Body: Story");
				// Dashed at rest, with the title.
				expect(await page.locator('[data-wc-client-mark="rest"]').count()).toBe(2);
				// Under the pointer: its chip, "Story · Click to edit".
				const paragraph = frame.locator(`${BODY} p[contenteditable]`).first();
				await paragraph.hover();
				await page.locator('[data-wc-client-chip="hover"]').waitFor();
				expect(await page.locator('[data-wc-client-chip="hover"]').textContent()).toBe("StoryClick to edit");
				// Written in: solid, and the chip says it is written in Blocks; the Block's tools show under it.
				await paragraph.click();
				await page.locator('[data-wc-client-chip="editing"]').waitFor();
				expect(await page.locator('[data-wc-client-chip="editing"]').textContent()).toBe("StoryBlocks");
				const tools = page.getByRole("toolbar", { name: "Paragraph, block 2: tools" });
				await tools.waitFor();
				const block = await paragraph.boundingBox();
				const drawn = await tools.boundingBox();
				expect(block && drawn).toBeTruthy();
				if (block && drawn) {
					expect(drawn.y).toBeGreaterThanOrEqual(block.y + block.height);
					// Start-aligned with the Block, kept 4 px inside the page where the Block touches its edge.
					expect(drawn.x).toBeGreaterThanOrEqual(block.x - 1);
					expect(drawn.x - block.x).toBeLessThanOrEqual(4);
				}
				// The tools are the shell's, never the page's: the page holds none of them.
				expect(await page.locator(`${TOOLS} .body-toolbar`).count()).toBe(1);
				expect(await frame.locator(".body-toolbar").count()).toBe(0);
				// "Add a Block" is the indigo square of `client-flows/01`.
				expect(
					await tools
						.getByRole("button", { name: "Add a Block after this one" })
						.evaluate((element) => getComputedStyle(element).backgroundColor),
				).toBe("rgb(79, 70, 229)");
				// The bar names the side panel of an Entry "Post details".
				expect(await page.locator('[data-wc-bar="page-details"]').textContent()).toBe("Post details");

				await expectAccessibleScreen(page, `building area › writing a post (${theme})`);
			} finally {
				await page.context().close();
			}
		});

		test("/ opens the Block list: tiles, then the agency's sections; a Component's Props come before it goes in", async () => {
			const { entryId, path } = await article();
			const { page, frame } = await writing(theme, path);
			try {
				const paragraph = frame.locator(`${BODY} p[contenteditable]`).first();
				await paragraph.click();
				await page.keyboard.press("End");
				await page.keyboard.press("Enter");
				await page.keyboard.press("/");

				const chooser = page.getByRole("dialog", { name: "Blocks" });
				await chooser.waitFor();
				expect(await focusOn(page, "Blocks")).toBe("Blocks");
				// `client-flows/01`: 480 wide, "Type to filter", the Blocks as tiles, the Components as cards
				// under "Sections your agency made", saying what they ask for.
				expect((await chooser.boundingBox())?.width).toBe(480);
				expect(await chooser.getByRole("combobox", { name: "Blocks" }).getAttribute("placeholder")).toBe(
					"Type to filter",
				);
				const text = chooser.getByRole("option", { name: "Text", exact: true });
				expect(await text.boundingBox()).toMatchObject({ width: 84, height: 52 });
				expect(await text.locator("svg").count()).toBe(1);
				expect(await chooser.getByRole("option", { name: "Photo", exact: true }).count()).toBe(1);
				expect(await chooser.getByRole("group", { name: "Sections your agency made" }).count()).toBe(1);
				const card = chooser.getByRole("option", { name: "Note Asks for Note text" });
				expect((await card.boundingBox())?.width).toBe(222);
				// The list sits under the line it was opened from, inside the page.
				const line = await frame.locator(`${BODY} p[contenteditable]`).nth(1).boundingBox();
				const list = await chooser.boundingBox();
				if (line && list) expect(list.y).toBeGreaterThanOrEqual(line.y + line.height);
				await expectNoAxeViolations(page, `building area › Block list (${theme})`, ["region"]);

				await page.keyboard.type("note");
				await page.keyboard.press("Enter");
				const form = page.getByRole("dialog", { name: "Note: Props" });
				await form.waitFor();
				await expectNoAxeViolations(page, `building area › a Component's Props (${theme})`, ["region"]);
				await page.keyboard.type("Ask about gluten-free.");
				await page.keyboard.press("Enter");
				await form.waitFor({ state: "hidden" });

				await frame.locator(`${BODY} aside`).getByText("Ask about gluten-free.").waitFor();
				const blocks = await eventually(
					() => bodyOf(entryId),
					(body) => body.filter((block) => block.type === "component").length === 2,
				);
				expect(blocks.filter((block) => block.type === "component").map((block) => block.props)).toEqual([
					// Right after the paragraph it was typed under.
					[{ name: "text", value: "Ask about gluten-free." }],
					[{ name: "text", value: "Closed on Mondays." }],
				]);
			} finally {
				await page.context().close();
			}
		});

		test("at a phone's width a Block's tools move it up and down, with no dragging", async () => {
			const { entryId, path } = await article();
			const { page, frame } = await writing(theme, path, { phone: true });
			try {
				await frame.locator(`${BODY} p[contenteditable]`).first().click();
				await page.keyboard.press("Alt+F10");
				const tools = page.getByRole("toolbar", { name: /^Paragraph, block 2: tools$/ });
				await tools.waitFor();
				expect(await tools.getByRole("button", { name: /^Drag/ }).count()).toBe(0);
				await expectNoAxeViolations(page, `building area at a phone's width › a Block's tools (${theme})`, ["region"]);
				const box = await tools.getByRole("button", { name: "Move down" }).boundingBox();
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

				await tools.getByRole("button", { name: "Move down" }).click();
				const blocks = await eventually(
					() => bodyOf(entryId),
					(body) => body[2]?.type === "paragraph",
				);
				expect(blocks.map((block) => block.type)).toEqual(["heading", "list", "paragraph", "callout", "component"]);
			} finally {
				await page.context().close();
			}
		});
	});
}

describe("typing in a body in the building area", () => {
	test("what is typed reaches the Draft, and the keyboard reaches each Block's tools and comes back", async () => {
		const { entryId, path } = await article();
		const { page, frame } = await writing("light", path);
		try {
			expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("No changes yet");
			const paragraph = frame.locator(`${BODY} p[contenteditable]`).first();
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
			// The Draft's state follows: saved, then what is left to publish.
			await page.locator('[data-wc-draft-state="changes"]').waitFor({ timeout: 8000 });
			expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("1 change not published");

			await page.keyboard.press("Alt+F10");
			expect(await focusOn(page, /^Drag to move Paragraph, block 2$/)).toMatch(/^Drag to move Paragraph, block 2$/);
			await page.keyboard.press("Escape");
			expect(await focusedInPage(frame, `${BODY} p[contenteditable]`)).toBe(true);
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
		} finally {
			await page.context().close();
		}
	});

	test("Tab reaches the body, Enter starts writing, Escape finishes then closes the side panel; Preview takes it all away", async () => {
		const { path } = await article();
		const { page, frame } = await writing("light", path);
		try {
			// From the title, Tab goes to the body as a whole: it waits for Enter.
			await frame.locator("h1[contenteditable]").click();
			await page.keyboard.press("Escape");
			await page.keyboard.press("Tab");
			await page.locator('[data-wc-client-chip="focus"]').waitFor();
			expect(await page.locator('[data-wc-client-chip="focus"]').textContent()).toBe("StoryPress Enter to edit");
			expect(await focusedInPage(frame, BODY)).toBe(true);
			// Enter puts the caret in its first Block.
			await page.keyboard.press("Enter");
			expect(await focusedInPage(frame, `${BODY} h2[contenteditable]`)).toBe(true);
			await page.locator('[data-wc-client-chip="editing"]').waitFor();
			await page.keyboard.type("Fresh ");
			expect(await frame.locator(`${BODY} h2`).textContent()).toBe("Fresh Breads");

			// With Post details open, Escape first finishes writing (focus stays on the body), then closes it.
			await page.locator('[data-wc-bar="page-details"]').click();
			await page.getByRole("heading", { name: "Post details" }).waitFor();
			await frame.locator(`${BODY} p[contenteditable]`).first().click();
			await page.getByRole("toolbar", { name: "Paragraph, block 2: tools" }).waitFor();
			await page.keyboard.press("Escape");
			expect(await focusedInPage(frame, BODY)).toBe(true);
			await page.getByRole("toolbar", { name: "Paragraph, block 2: tools" }).waitFor({ state: "hidden" });
			await page.waitForFunction(() =>
				document.querySelector("[data-wc-messages]")?.textContent?.includes("Finished editing Story"),
			);
			await page.keyboard.press("Escape");
			await page.getByRole("heading", { name: "Post details" }).waitFor({ state: "hidden" });
			expect(await focusedInPage(frame, BODY)).toBe(true);

			// Tab from inside a Block goes on past the body (nothing else is marked after it).
			await frame.locator(`${BODY} p[contenteditable]`).first().click();
			await page.keyboard.press("Shift+Tab");
			expect(await focusedInPage(frame, "h1")).toBe(true);

			// Preview: no mark, nothing editable, no tools.
			await page.locator('[data-wc-segment="preview"]').click();
			await settled(page);
			expect(await page.locator("[data-wc-client-mark], [data-wc-client-chip]").count()).toBe(0);
			expect(await frame.locator(`${BODY} [contenteditable="true"]`).count()).toBe(0);
			expect(await page.locator(`${TOOLS} .body-toolbar:not([hidden])`).count()).toBe(0);
			await page.locator('[data-wc-segment="edit"]').click();
			await frame.locator(`${BODY} p[contenteditable="true"]`).first().waitFor();
		} finally {
			await page.context().close();
		}
	});

	test("the block editor is fetched only for a page that shows a body", async () => {
		const { page, frame } = await writing("light", aboutPath);
		const fetched: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith("/_webcraft/edit/assets/body-")) fetched.push(request.url());
		});
		try {
			await frame.locator("main").waitFor({ state: "attached" });
			await page.waitForTimeout(500);
			expect(fetched).toEqual([]);
			const { path } = await article();
			await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
			const framed = await frameOf(page);
			await framed.locator(`${BODY} [data-wc-block-id]`).first().waitFor();
			expect(fetched.length).toBe(1);
		} finally {
			await page.context().close();
		}
	});
});

test("a refused Component save is announced and is not refreshed as a saved insertion", async () => {
	const { entryId, path } = await article();
	const { page, frame } = await writing("light", path);
	const { api } = await install.install.superadmin();
	// Staff change the allow-list after this editor opened its chooser's catalogue.
	try {
		const paragraph = frame.locator(`${BODY} p[contenteditable]`).first();
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
			.locator('[data-wc-messages] [role="alert"]')
			.filter({ hasText: /Not saved:/ })
			.waitFor();
		await page.locator('[data-wc-draft-state="failed"]').waitFor();
		expect(JSON.stringify(await bodyOf(entryId))).not.toContain("Must not be saved.");
		expect(await frame.locator(`${BODY} aside`).getByText("Must not be saved.").count()).toBe(0);
	} finally {
		await api.postTypes.update({
			siteId,
			postTypeId,
			fields: [{ key: "body", label: "Story", type: "body", components: [noteId] }],
		});
		await page.context().close();
	}
});

test("a paste keeps its place while it is converted", async () => {
	const { entryId, path } = await article();
	const { api } = await install.install.superadmin();
	await api.entries.saveDraft({
		siteId,
		entryId,
		fields: {
			body: [
				{ type: "paragraph", text: "FIRST" },
				{ type: "paragraph", text: "SECOND" },
				{ type: "component", component: noteId, props: [{ name: "text", value: "Closed on Mondays." }] },
			],
		},
	});
	const { page, frame } = await writing("light", path);
	let releasePaste = () => {};
	const held = new Promise<void>((resolve) => {
		releasePaste = resolve;
	});
	await page.route("**/body/paste", async (route) => {
		await held;
		await route.continue();
	});
	try {
		const paragraphs = frame.locator(`${BODY} p[contenteditable]`);
		const pending = page.waitForRequest("**/body/paste");
		await paragraphs.first().evaluate((element) => {
			(element as HTMLElement).focus();
			const range = document.createRange();
			range.selectNodeContents(element);
			range.collapse(false);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
			const clipboardData = new DataTransfer();
			clipboardData.setData("text/plain", "PASTED");
			element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
		});
		await pending;
		await paragraphs.nth(1).evaluate((element) => {
			(element as HTMLElement).focus();
			const range = document.createRange();
			range.selectNodeContents(element);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
		});
		releasePaste();
		const saved = await eventually(
			() => bodyOf(entryId),
			(body) => JSON.stringify(body).includes("PASTED"),
		);
		expect(saved.slice(0, 2)).toMatchObject([
			{ type: "paragraph", text: [{ text: "FIRSTPASTED" }] },
			{ type: "paragraph", text: [{ text: "SECOND" }] },
		]);
		await expect(paragraphs.allTextContents()).resolves.toEqual(["FIRSTPASTED", "SECOND"]);
	} finally {
		releasePaste();
		await page.context().close();
	}
});

test("pasted image files aren't uploaded where the Body field switches images off", async () => {
	const { api } = await install.install.superadmin();
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Text articles",
		urlPattern: "/text-articles/{slug}",
		fields: [{ key: "body", label: "Story", type: "body", components: [noteId], blocksOff: ["image"] }],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><div>{{ body }}</div></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Text only",
		slug: "text-only",
		fields: {
			body: [
				{ type: "paragraph", text: "Text only." },
				{ type: "component", component: noteId, props: [{ name: "text", value: "Closed on Mondays." }] },
			],
		},
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	const before = await bodyOf(entry.id);
	const { page, frame } = await writing("light", "/text-articles/text-only");
	try {
		const uploaded = page
			.waitForRequest((request) => request.url().endsWith("/upload"), { timeout: 1000 })
			.then(
				() => true,
				() => false,
			);
		await frame
			.locator(`${BODY} p[contenteditable]`)
			.first()
			.evaluate((element) => {
				(element as HTMLElement).focus();
				const clipboardData = new DataTransfer();
				clipboardData.items.add(
					new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>'], "clipboard.svg", {
						type: "image/svg+xml",
					}),
				);
				element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
			});
		expect(await uploaded).toBe(false);
		expect(await bodyOf(entry.id)).toEqual(before);
		// Nor does the Block list offer a photo there.
		await frame.locator(`${BODY} p[contenteditable]`).first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.press("/");
		await page.getByRole("dialog", { name: "Blocks" }).waitFor();
		expect(await page.getByRole("option", { name: "Photo", exact: true }).count()).toBe(0);
		await page.keyboard.press("Escape");
	} finally {
		await page.context().close();
	}
});

test("the admin and the building area see each other's Body changes without reloading", async () => {
	const { entryId, path } = await article();
	const { page: onSite, frame } = await writing("light", path);
	const admin = await install.newPage("light");
	try {
		await install.signIn(admin, staff);
		await admin.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		const paragraph = admin.getByRole("textbox", { name: "Paragraph, block 2" });
		await paragraph.fill("Baked by the admin.");
		await frame.locator(`${BODY} p[contenteditable]`).filter({ hasText: "Baked by the admin." }).waitFor();
		const heading = frame.locator(`${BODY} h2[contenteditable]`);
		await heading.fill("Breads from the building area");
		await admin
			.getByRole("textbox", { name: "Heading 2, block 1" })
			.filter({ hasText: "Breads from the building area" })
			.waitFor();
		expect((await bodyOf(entryId)).slice(0, 2)).toMatchObject([
			{ text: [{ text: "Breads from the building area" }] },
			{ text: [{ text: "Baked by the admin." }] },
		]);
	} finally {
		await admin.context().close();
		await onSite.context().close();
	}
});

test("a Component added by another editor renders without writing an older body back", async () => {
	const { entryId, path } = await article();
	const { page, frame } = await writing("light", path);
	const { api } = await install.install.superadmin();
	try {
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
		await frame.locator(`${BODY} aside`).getByText("Added by another editor.").waitFor();
		expect(JSON.stringify(await bodyOf(entryId))).toContain("Added by another editor.");
	} finally {
		await page.context().close();
	}
});

test("typing in the building area keeps another editor's changes during autosave", async () => {
	const { entryId, path } = await article();
	const { page: onSite, frame } = await writing("light", path);
	const admin = await install.newPage("light");
	try {
		await install.signIn(admin, staff);
		await admin.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		const heading = frame.locator(`${BODY} h2[contenteditable]`);
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
		await frame.locator(`${BODY} p[contenteditable]`).filter({ hasText: "Baked by the other editor." }).waitFor();
	} finally {
		await admin.context().close();
		await onSite.context().close();
	}
});

test("a focused Block shows others' changes before the next keystroke", async () => {
	const { entryId, path } = await article();
	const { page, frame } = await writing("light", path);
	try {
		const heading = frame.locator(`${BODY} h2[contenteditable]`);
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
	} finally {
		await page.context().close();
	}
});
