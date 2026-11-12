// Edit mode in a real browser: "Edit on site" in the admin opens the Site on its own address with
// the dark editing bar on top. The page and the bar pass the accessibility checks in light and dark,
// text is edited in place from the keyboard (the floating toolbar for rich text too), saves are
// announced in a live region, the menus open and close from the keyboard, and the bar never covers
// what has focus.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let siteId: string;
let entryId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;

	await api.languages.add({ siteId, code: "fr" });
	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Open every day from seven." } });
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p>Welcome to <a href="/">Acme Bakery</a>.</p><nav aria-label="Main">',
			'<p>Read about <a href="/blog/fresh-bread">fresh bread</a>.</p>',
			"</nav></header>",
			"<main>{{@outlet}}</main>",
			"<footer><p>{{ site.tagline }}</p></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
		],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven", intro: "<p>Sourdough, rye and spelt, baked by hand.</p>" },
	});
	entryId = post.id;
	await api.entries.publish({ siteId, entryId });
});

afterAll(async () => {
	await install.close();
});

/** The edit cookie from the first time Edit mode opened, handed to later pages (the link works once). */
let editCookies: Cookie[] | undefined;

/** A page in Edit mode at `pagePath`: the first time through "Edit on site" in the admin. */
async function editModePage(theme: Theme, pagePath = path): Promise<Page> {
	const page = await install.newPage(theme);
	if (editCookies) {
		await page.context().addCookies(editCookies);
	} else {
		await install.signIn(page, editor);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		editCookies = (await page.context().cookies()).filter((cookie) => cookie.name === "webcraft.edit");
	}
	await page.goto(install.siteUrl(slug, pagePath));
	await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
	return page;
}

/** What `read` gives once `done` accepts it, waiting up to 5 seconds (autosave waits for typing to pause). */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 5000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(200);
		value = await read();
	}
	return value;
}

/** What the person's admin sees of the Entry's Draft now. */
async function draft() {
	const { api } = await install.install.superadmin();
	return (await api.entries.get({ siteId, entryId })).entry.draft;
}

for (const theme of THEMES) {
	describe(`Edit mode, ${theme}`, () => {
		test("the page with the editing bar", async () => {
			const page = await editModePage(theme);

			await expectAccessibleScreen(page, `Edit mode (${theme})`);
		});

		test("the Publish menu", async () => {
			const page = await editModePage(theme);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Publish", exact: true }),
				"dialog",
				`Edit mode › Publish menu (${theme})`,
			);
		});

		test("the page switcher and the person's menu", async () => {
			const page = await editModePage(theme);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /^Page: / }),
				"menu",
				`Edit mode › Pages (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /Edit mode menu$/ }),
				"menu",
				`Edit mode › Account menu (${theme})`,
			);
		});

		test("the language menu", async () => {
			const page = await editModePage(theme);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /^Language: EN \(English\)/ }),
				"menu",
				`Edit mode › Languages (${theme})`,
			);
		});
	});
}

describe("editing in place", () => {
	test("text is typed over from the keyboard and autosaved to the Draft without speech", async () => {
		const page = await editModePage("light");
		const title = page.locator('h1[data-wc-field="title"]');

		await title.focus();
		await page.keyboard.press("End");
		await page.keyboard.type(" and rolls");
		await page.keyboard.press("Enter");

		await page.getByText("Saved to Draft · just now", { exact: true }).waitFor();
		expect(await page.locator("[data-editor-messages]").textContent()).not.toContain("Saved to Draft");
		expect(
			await eventually(
				async () => (await draft()).title,
				(title) => title !== "Fresh bread",
			),
		).toBe("Fresh bread and rolls");
		expect(await title.textContent()).toBe("Fresh bread and rolls");
	});

	test("rich text gets the floating toolbar: Alt+F10 reaches it and its tools act on the text", async () => {
		const page = await editModePage("light");
		const intro = page.locator('div[data-wc-field="intro"]');

		await intro.focus();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.press("Alt+F10");
		const bold = page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Bold" });
		expect(await bold.evaluate((element) => element === (element.getRootNode() as ShadowRoot).activeElement)).toBe(
			true,
		);
		await page.keyboard.press("Enter");

		const bolded = "<p><b>Sourdough, rye and spelt, baked by hand.</b></p>";
		expect(
			await eventually(
				async () => (await draft()).fields.intro,
				(intro) => intro === bolded,
			),
		).toBe(bolded);
		// Back in the text, so typing goes on where it was.
		expect(await intro.evaluate((element) => element === document.activeElement)).toBe(true);
	});

	test("the editing bar never covers the element that has focus", async () => {
		const page = await editModePage("light");
		const subtitle = page.locator('p[data-wc-field="subtitle"]');
		// Scroll so the subtitle sits right under the bar, then move focus onto it.
		await page.evaluate(() => {
			document.documentElement.style.minHeight = "300vh";
			const element = document.querySelector('p[data-wc-field="subtitle"]');
			if (element) window.scrollBy(0, element.getBoundingClientRect().top - 10);
		});

		await subtitle.focus();

		const covered = await page.evaluate(() => {
			const bar = document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector(".bar");
			const element = document.querySelector('p[data-wc-field="subtitle"]');
			return (element?.getBoundingClientRect().top ?? 0) < (bar?.getBoundingClientRect().bottom ?? 0);
		});
		expect(covered).toBe(false);
	});

	test("Preview turns the editing tools off", async () => {
		const page = await editModePage("light");

		await page.getByRole("button", { name: "Preview" }).click();

		expect(await page.locator("[contenteditable]").count()).toBe(0);
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		expect(await page.locator("[contenteditable]").count()).toBe(4);
	});
});
