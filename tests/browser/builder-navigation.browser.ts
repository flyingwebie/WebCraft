import { afterEach, beforeEach, expect, test } from "bun:test";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

for (const theme of THEMES)
	test(`Builder Component script conflicts retain local edits and offer both recovery choices (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace();
		const { id: siteId } = await local.createSite(workspace.id);
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { component } = await api.components.create({ siteId, name: "Notice" });
		await api.components.saveScriptDraft({ siteId, componentId: component.id, code: "// Original" });
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
		const region = page.getByRole("region", { name: "JS", exact: true });
		const js = region.getByRole("textbox", { name: "JS: Notice · Component script" });
		await js.and(page.locator(":not([readonly])")).waitFor();
		await js.fill("// Mine before reload");
		await region.getByRole("combobox", { name: "Consent category" }).selectOption("analytics");
		await api.components.saveScriptDraft({
			siteId,
			componentId: component.id,
			code: "// Peer",
			consentCategory: "marketing",
		});
		await region.getByRole("button", { name: "Save", exact: true }).click();
		await region.getByRole("button", { name: "Reload theirs", exact: true }).waitFor();
		expect(await js.inputValue()).toBe("// Mine before reload");
		expect(await region.getByRole("combobox", { name: "Consent category" }).inputValue()).toBe("analytics");
		await region.getByRole("button", { name: "Reload theirs", exact: true }).click();
		await region.getByRole("button", { name: "Reload theirs", exact: true }).waitFor({ state: "hidden" });
		expect(await js.inputValue()).toBe("// Peer");
		expect(await region.getByRole("combobox", { name: "Consent category" }).inputValue()).toBe("marketing");
		await js.fill("// Mine after reload");
		await region.getByRole("combobox", { name: "Consent category" }).selectOption("media");
		await api.components.saveScriptDraft({ siteId, componentId: component.id, code: "// Peer again" });
		await region.getByRole("button", { name: "Save", exact: true }).click();
		await region.getByRole("button", { name: "Overwrite with mine", exact: true }).click();
		await region.getByRole("button", { name: "Overwrite with mine", exact: true }).waitFor({ state: "hidden" });
		expect((await api.components.getScript({ siteId, componentId: component.id })).script?.draft).toMatchObject({
			code: "// Mine after reload",
			consentCategory: "media",
		});
		await js.fill("// Temporary edit");
		await api.components.saveScriptDraft({ siteId, componentId: component.id, code: "// Peer again after overwrite" });
		await region.getByRole("button", { name: "Save", exact: true }).click();
		await region.getByRole("button", { name: "Overwrite with mine", exact: true }).waitFor();
		await js.fill("// Mine after reload");
		await region.getByRole("button", { name: "Overwrite with mine", exact: true }).click();
		await region.getByRole("button", { name: "Overwrite with mine", exact: true }).waitFor({ state: "hidden" });
		expect((await api.components.getScript({ siteId, componentId: component.id })).script?.draft).toMatchObject({
			code: "// Mine after reload",
			consentCategory: "media",
		});
		await page.getByRole("link", { name: "Components", exact: true }).click();
		await page.waitForURL((url) => url.pathname === `/sites/${siteId}/components`);
	});

for (const canvas of ["preview", "live"] as const)
	test(`CSS edited after a saved peer update can leave the ${canvas} canvas`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace();
		const { id: siteId } = await local.createSite(workspace.id);
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
		await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
		const made = await api.designSystem.createClass({ siteId, name: "note", styles: "color: rgb(1, 2, 3);" });
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<p data-wc-id="note" class="note">Hello</p>',
		});
		const page = await install.newPage(canvas === "preview" ? "light" : "dark");
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		const builderPath = `/builder/${siteId}/entry-template/${postType.id}`;
		await page.goto(install.adminUrl(builderPath));
		if (canvas === "live") {
			await page.getByRole("button", { name: "View on a page", exact: true }).click();
			await page.waitForURL((url) => url.pathname === "/stories/first");
		}
		await page.getByRole("tab", { name: ".note", exact: true }).click();
		const region = page.getByRole("region", { name: "CSS", exact: true });
		const css = region.getByRole("textbox", { name: "CSS: .note", exact: true });
		await css.fill("color: rgb(4, 5, 6);");
		await region.getByRole("button", { name: "Save", exact: true }).click();
		await region.getByRole("status").filter({ hasText: "Saved" }).waitFor();
		await api.designSystem.updateClass({ siteId, classId: made.class.id, styles: "color: rgb(7, 8, 9);" });
		for (let tries = 0; tries < 40 && !(await css.inputValue()).includes("rgb(7, 8, 9)"); tries++)
			await page.waitForTimeout(100);
		expect(await css.inputValue()).toBe("color: rgb(7, 8, 9);");
		await css.fill("color: rgb(10, 11, 12);");
		await page
			.getByRole("button", {
				name: canvas === "preview" ? "View on a page" : "Open in builder",
				exact: true,
			})
			.click();
		await page.waitForURL((url) => url.pathname === (canvas === "preview" ? "/stories/first" : builderPath));
		const saved = (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
			(each) => each.id === made.class.id,
		);
		expect(saved?.styles).toBe("color: rgb(10, 11, 12);");
	});

for (const theme of THEMES)
	test(`docked HTML, Entry picker and same-tab round trip preserve pending edits and selection (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace();
		const { id: siteId } = await local.createSite(workspace.id, { slug: `switch-${theme}` });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { postType } = await api.postTypes.create({
			siteId,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [],
		});
		const first = (await api.entries.create({ siteId, postTypeId: postType.id, title: "First" })).entry;
		await local.clock.advance(1000);
		await api.entries.create({ siteId, postTypeId: postType.id, title: "Newest" });
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup:
				'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><p data-wc-id="note">Before</p></article>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
		await page.getByRole("region", { name: "HTML", exact: true }).waitFor();
		expect(await page.getByRole("button", { name: "Visual", exact: true }).count()).toBe(0);
		expect(await page.getByRole("region", { name: "JS", exact: true }).count()).toBe(0);
		const canvas = page.frameLocator("iframe[title^='Canvas']");
		await canvas.getByText("Newest", { exact: true }).waitFor();
		await page.getByRole("combobox", { name: "Preview Entry" }).selectOption(first.id);
		await canvas.getByText("First", { exact: true }).waitFor();
		await page.getByRole("treeitem", { name: /^p(?: from .+)?$/ }).click();
		await page.locator("[data-selected-tag]").filter({ hasText: 'data-wc-id="note"' }).waitFor();
		await page.waitForLoadState("networkidle");
		await expectAccessibleScreen(page, `Builder dock (${theme})`, { exclude: ["iframe[title^='Canvas']"] });
		const html = page.getByRole("textbox", { name: "Template markup", exact: true });
		await html.fill((await html.inputValue()).replace("Before", "Flushed on departure"));
		const tabs = page.context().pages().length;
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.hostname.startsWith(`switch-${theme}`) && url.pathname === "/stories/first");
		await page.getByRole("textbox", { name: /HTML of Stories/ }).waitFor();
		await page.locator('[data-wc-code="content#note"]').filter({ hasText: "Flushed on departure" }).waitFor();
		expect(page.context().pages().length).toBe(tabs);
		await page.getByRole("button", { name: "Open in builder", exact: true }).click();
		await page.waitForURL((url) => url.pathname.includes("/builder/"));
		await page.locator("[data-selected-tag]").filter({ hasText: 'data-wc-id="note"' }).waitFor();
		expect(await page.getByRole("combobox", { name: "Preview Entry" }).inputValue()).toBe(first.id);
		await html.fill(`${await html.inputValue()}\n<`);
		await page.getByRole("button", { name: /Back to First/ }).click();
		await page.waitForTimeout(700);
		expect(new URL(page.url()).pathname).toContain("/builder/");
		await html.fill((await html.inputValue()).replace(/\n<$/, ""));
		await page.getByRole("button", { name: /Back to First/ }).click();
		await page.waitForURL((url) => url.pathname === "/stories/first");
	});

test("Component Builder edits real script code and Consent settings, and refuses to leave on invalid CSS", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	const { id: siteId } = await local.createSite(workspace.id);
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { component } = await api.components.create({ siteId, name: "Notice" });
	await api.components.saveMarkup({ siteId, componentId: component.id, markup: '<p data-wc-id="note">Notice</p>' });
	await api.components.saveScriptDraft({
		siteId,
		componentId: component.id,
		code: "export default function(root) { root.dataset.ran = 'yes'; }",
	});
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
	const js = page.getByRole("textbox", { name: "JS: Notice · Component script" });
	await js.waitFor();
	await page.getByRole("combobox", { name: "Consent category" }).selectOption("analytics");
	await js.fill("export default function(root) { root.dataset.edited = 'yes'; }");
	await page
		.getByRole("region", { name: "JS", exact: true })
		.getByRole("button", { name: "Save", exact: true })
		.click();
	await page.getByRole("status").filter({ hasText: "Saved to Draft" }).first().waitFor();
	expect((await api.components.getScript({ siteId, componentId: component.id })).script?.draft).toMatchObject({
		consentCategory: "analytics",
		code: "export default function(root) { root.dataset.edited = 'yes'; }",
	});
	expect(await page.frameLocator("iframe[title^='Canvas']").locator("[data-ran], [data-edited]").count()).toBe(0);
	await page.getByText("Not placed on any page", { exact: true }).waitFor();
	await page.getByRole("textbox", { name: "CSS: Site CSS", exact: true }).fill("a { color:");
	await page.getByRole("link", { name: "Components", exact: true }).click();
	await page.waitForTimeout(700);
	expect(new URL(page.url()).pathname).toContain("/builder/");
});

for (const kind of ["archive", "search"] as const)
	test(`${kind} list and Builder navigate to the real source and return with saved HTML`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace();
		const { id: siteId } = await local.createSite(workspace.id);
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		let builderPath: string;
		let path: string;
		const markup = '<h1 data-wc-id="heading">Original</h1>';
		if (kind === "archive") {
			const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
			await api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: postType.id, markup });
			builderPath = `/builder/${siteId}/archive-template/${postType.id}`;
			path = "/stories";
		} else {
			const pages = (await api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page");
			if (!pages) throw new Error("Page Post Type missing");
			const { entry } = await api.entries.create({ siteId, postTypeId: pages.id, title: "Find" });
			await api.pages.setSearchPage({ siteId, pageId: entry.id });
			await api.templates.saveSearchTemplateMarkup({ siteId, markup });
			builderPath = `/builder/${siteId}/search-template`;
			path = "/find";
		}
		const page = await install.newPage("light");
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/templates`));
		const row = page.getByRole("row").filter({
			has: page.getByText(kind === "archive" ? "Stories · Archive template" : "Search results template", {
				exact: true,
			}),
		});
		await row.getByRole("button", { name: "Edit on site", exact: true }).click();
		await page.waitForURL((url) => url.pathname === path);
		const html = page.getByRole("textbox", {
			name: kind === "archive" ? "HTML of Stories · Archive template" : "HTML of Search template",
			exact: true,
		});
		await html.fill(markup.replace("Original", "Saved on page"));
		await page.getByRole("button", { name: "Open in builder", exact: true }).click();
		await page.waitForURL((url) => url.pathname === builderPath);
		await page.frameLocator("iframe[title^='Canvas']").getByText("Saved on page", { exact: true }).waitFor();
		await page.getByRole("treeitem", { name: /^h1(?: from .+)?$/ }).click();
		await page
			.getByRole("textbox", { name: "Template markup", exact: true })
			.fill(markup.replace("Original", "Saved in Builder"));
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === path);
		await page.locator('[data-wc-code="content#heading"]').filter({ hasText: "Saved in Builder" }).waitFor();
	});

test("nested repeated Component navigation retains a structural selection and peer Props beside unfinished HTML", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	const { id: siteId } = await local.createSite(workspace.id);
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
	const { component } = await api.components.create({
		siteId,
		name: "Note",
		props: [{ key: "words", label: "Words", type: "text", default: "Before" }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<p data-wc-id="note">{{ props.words }}</p>',
	});
	const { component: outer } = await api.components.create({ siteId, name: "Outer" });
	await api.components.saveMarkup({ siteId, componentId: outer.id, markup: '<Note data-wc-id="inside" />' });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<Outer data-wc-id="one" /><Outer data-wc-id="two" />',
	});
	const page = await install.newPage("dark");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
	const html = page.getByRole("textbox", { name: "Template markup", exact: true });
	await page.getByRole("treeitem", { name: /^\{\{ props.words \}\}/ }).click();
	await page.locator("[data-selected-tag]").filter({ hasText: "{{ props.words }}" }).waitFor();
	const original = await html.inputValue();
	await html.fill(`${original}\n<`);
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: original.replace('default="Before"', 'default="Peer words"'),
	});
	await page.frameLocator("iframe[title^='Canvas']").getByText("Peer words", { exact: true }).waitFor();
	expect(await html.inputValue()).toBe(`${original}\n<`);
	await page.getByRole("button", { name: "View on a page", exact: true }).click();
	expect(new URL(page.url()).pathname).toContain("/builder/");
	await html.fill(original);
	await page.getByRole("treeitem", { name: /^\{\{ props.words \}\}/ }).click();
	await page.getByRole("combobox", { name: "Placement" }).selectOption("content/two/inside");
	await page.getByRole("button", { name: "View on a page", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/stories/first");
	await page.getByRole("textbox", { name: "HTML of Note · Component", exact: true }).waitFor();
	await page.locator(".language-markup .line.marked").filter({ hasText: "{{ props.words }}" }).waitFor();
	await page.locator('[data-wc-code="content/two/inside#note"]').filter({ hasText: "Peer words" }).waitFor();
	await page.getByRole("button", { name: "Open in builder", exact: true }).click();
	await page.waitForURL((url) => url.pathname.includes(`/component/${component.id}`));
	await page.locator("[data-selected-tag]").filter({ hasText: "{{ props.words }}" }).waitFor();
	await page.getByRole("button", { name: /Back to First/ }).click();
	await page.waitForURL((url) => url.pathname === "/stories/first");
	expect(new URL(page.url()).hash).toContain("content%2Ftwo%2Finside%23%40");
	await page.getByRole("button", { name: "Open in builder", exact: true }).click();
	await page.waitForURL((url) => url.pathname.includes(`/component/${component.id}`));
	await page.getByRole("combobox", { name: "Placement on page" }).selectOption("content/one/inside");
	await page.getByRole("button", { name: "View on a page", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/stories/first");
	expect(new URL(page.url()).hash).toContain("content%2Fone%2Finside%23%40");
});

test("a delayed Entry preview cannot replace the current picker or its navigation destination", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	const { id: siteId } = await local.createSite(workspace.id);
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const first = (await api.entries.create({ siteId, postTypeId: postType.id, title: "First" })).entry;
	await local.clock.advance(1000);
	const newest = (await api.entries.create({ siteId, postTypeId: postType.id, title: "Newest" })).entry;
	const markup = '<h1 data-wc-id="heading">{{ title }}</h1>';
	await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup });
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
	const canvas = page.frameLocator("iframe[title^='Canvas']");
	await canvas.getByText("Newest", { exact: true }).waitFor();
	const captured = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	await page.route(/\/builder\/preview$/, async (route) => {
		if (route.request().postDataJSON().json.entryId !== first.id) return route.continue();
		const response = await route.fetch();
		captured.resolve();
		await release.promise;
		await route.fulfill({ response });
		delivered.resolve();
	});
	try {
		const picker = page.getByRole("combobox", { name: "Preview Entry" });
		await picker.selectOption(first.id);
		await captured.promise;
		await picker.selectOption(newest.id);
		await canvas.getByText("Newest", { exact: true }).waitFor();
		release.resolve();
		await delivered.promise;
		await page.waitForLoadState("networkidle");
		expect(await canvas.locator("body").textContent()).toContain("Newest");
		expect((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.draft).toBe(
			markup,
		);
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/stories/newest");
	} finally {
		release.resolve();
	}
});

test("navigation flushes one-off declarations on both canvases and refuses unfinished styles", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	const { id: siteId } = await local.createSite(workspace.id);
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<p data-wc-id="note">Hello</p>',
	});
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
	await page.getByRole("treeitem", { name: /^p(?: from .+)?$/ }).click();
	await page.getByRole("tab", { name: "Style", exact: true }).click();
	await page.getByRole("textbox", { name: "Declarations", exact: true }).fill("color: rgb(1, 2, 3)");
	await page.getByRole("button", { name: "View on a page", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/stories/first");
	expect(await page.locator('[data-wc-code="content#note"]').evaluate((node) => getComputedStyle(node).color)).toBe(
		"rgb(1, 2, 3)",
	);
	await page.getByRole("treeitem", { name: /^p(?: from .+)?$/ }).click();
	await page.getByRole("tab", { name: "Style", exact: true }).click();
	await page.getByRole("textbox", { name: "Declarations", exact: true }).fill("color: rgb(4, 5, 6)");
	await page.getByRole("button", { name: "Open in builder", exact: true }).click();
	await page.waitForURL((url) => url.pathname.includes("/builder/"));
	const canvas = page.frameLocator("iframe[title^='Canvas']");
	await canvas.getByText("Hello", { exact: true }).waitFor();
	expect(await canvas.locator("p").evaluate((node) => getComputedStyle(node).color)).toBe("rgb(4, 5, 6)");
	await page.getByRole("treeitem", { name: /^p(?: from .+)?$/ }).click();
	await page.getByRole("tab", { name: "Style", exact: true }).click();
	await page.getByRole("textbox", { name: "Declarations", exact: true }).fill("color:");
	await page.getByRole("button", { name: "View on a page", exact: true }).click();
	await page.waitForTimeout(500);
	expect(new URL(page.url()).pathname).toContain("/builder/");
});

test("CSS typed while Open in builder resolves stays on the page until it can be saved", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	const { id: siteId } = await local.createSite(workspace.id);
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<p data-wc-id="note">Hello</p>',
	});
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
	await page.getByRole("button", { name: "View on a page", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/stories/first");
	const open = page.getByRole("button", { name: "Open in builder", exact: true });
	await open.and(page.locator(":enabled")).waitFor();
	await page.waitForLoadState("networkidle");
	const captured = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/_webcraft/edit/api/code/editor", async (route) => {
		const response = await route.fetch();
		captured.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	try {
		await open.click();
		await captured.promise;
		const css = page.getByRole("textbox", { name: "CSS: Site CSS", exact: true });
		await css.fill("p { color:");
		release.resolve();
		await Promise.race([
			open.and(page.locator(":enabled")).waitFor(),
			page.waitForURL((url) => url.pathname.includes("/builder/")),
		]);
		expect(new URL(page.url()).pathname).toBe("/stories/first");
		expect(await css.inputValue()).toBe("p { color:");
		await css.fill("p { color: rgb(7, 8, 9); }");
		await open.click();
		await page.waitForURL((url) => url.pathname.includes("/builder/"));
		const canvas = page.frameLocator("iframe[title^='Canvas']");
		await canvas.getByText("Hello", { exact: true }).waitFor();
		expect(await canvas.locator("p").evaluate((node) => getComputedStyle(node).color)).toBe("rgb(7, 8, 9)");
	} finally {
		release.resolve();
	}
});

test("CSS typed during the final Builder flush keeps the unfinished input on the canvas", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	const { id: siteId } = await local.createSite(workspace.id);
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<p data-wc-id="note">Hello</p>',
	});
	const page = await install.newPage("dark");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	const path = `/builder/${siteId}/entry-template/${postType.id}`;
	await page.goto(install.adminUrl(path));
	const view = page.getByRole("button", { name: "View on a page", exact: true });
	await view.and(page.locator(":enabled")).waitFor();
	await page.waitForLoadState("networkidle");
	const css = page.getByRole("textbox", { name: "CSS: Site CSS", exact: true });
	await css.fill("p { color: rgb(1, 2, 3); }");
	const captured = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/api/rpc/builder/saveCss", async (route) => {
		const response = await route.fetch();
		captured.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	try {
		await view.click();
		await captured.promise;
		await css.fill("p { color:");
		release.resolve();
		await Promise.race([
			view.and(page.locator(":enabled")).waitFor(),
			page.waitForURL((url) => url.pathname === "/stories/first"),
		]);
		expect(new URL(page.url()).pathname).toBe(path);
		expect(await css.inputValue()).toBe("p { color:");
		await css.fill("p { color: rgb(7, 8, 9); }");
		await view.click();
		await page.waitForURL((url) => url.pathname === "/stories/first");
		expect(await page.locator('[data-wc-code="content#note"]').evaluate((node) => getComputedStyle(node).color)).toBe(
			"rgb(7, 8, 9)",
		);
	} finally {
		release.resolve();
	}
});

for (const [part, canvas] of [
	["existing part", "preview"],
	["existing part", "live"],
	["new breakpoint", "preview"],
	["new breakpoint", "live"],
] as const)
	test(`a CSS layout action during departure stays on the ${canvas} canvas until saved (${part})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace();
		const { id: siteId } = await local.createSite(workspace.id);
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
		await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
		await api.designSystem.createClass({ siteId, name: "note", styles: "color: rgb(7, 8, 9);" });
		const { designSystem } = await api.designSystem.get({ siteId });
		const breakpoint = [...designSystem.draft.tokens.breakpoints].sort((a, b) => a.width - b.width)[0];
		if (!breakpoint) throw new Error("Default breakpoint missing");
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<p data-wc-id="note" class="note">Hello</p>',
		});
		const page = await install.newPage(canvas === "preview" ? "light" : "dark");
		page.setDefaultTimeout(10000);
		if (part === "new breakpoint") await page.setViewportSize({ width: 1920, height: 1080 });
		await install.signIn(page, staff);
		const builderPath = `/builder/${siteId}/entry-template/${postType.id}`;
		await page.goto(install.adminUrl(builderPath));
		if (canvas === "live") {
			await page.getByRole("button", { name: "View on a page", exact: true }).click();
			await page.waitForURL((url) => url.pathname === "/stories/first");
		}
		const action = page.getByRole("button", {
			name: canvas === "preview" ? "View on a page" : "Open in builder",
			exact: true,
		});
		await action.and(page.locator(":enabled")).waitFor();
		await page.getByRole("tab", { name: ".note", exact: true }).click();
		await page.waitForLoadState("networkidle");
		await page.getByRole("textbox", { name: "CSS: .note", exact: true }).fill("color: rgb(10, 11, 12);");
		await page.getByRole("button", { name: "Own CSS", exact: true }).click();
		await page.getByRole("textbox", { name: "CSS: .note, own CSS", exact: true }).fill("&:hover { opacity: 0.5; }");
		const before = new URL(page.url()).pathname;
		const after = canvas === "preview" ? "/stories/first" : builderPath;
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const releaseReads = Promise.withResolvers<void>();
		if (part === "new breakpoint")
			await page.route(
				canvas === "preview" ? "**/api/rpc/builder/css" : "**/_webcraft/edit/api/code/css",
				async (route) => {
					const response = await route.fetch();
					await releaseReads.promise;
					await route.fulfill({ response });
				},
			);
		await page.route(
			canvas === "preview" ? "**/api/rpc/builder/saveCss" : "**/_webcraft/edit/api/code/saveCss",
			async (route) => {
				const input = route.request().postDataJSON();
				if ((canvas === "preview" ? input.json.target : input.target).part !== "css") return route.continue();
				const response = await route.fetch();
				captured.resolve();
				await release.promise;
				await route.fulfill({ response });
			},
		);
		try {
			await action.click();
			await captured.promise;
			await page
				.getByRole("button", {
					name: part === "existing part" ? "All widths" : `${breakpoint.name} (${breakpoint.width}px)`,
					exact: true,
				})
				.click();
			await page.getByRole("button", { name: "Display: grid", exact: true }).click();
			release.resolve();
			releaseReads.resolve();
			await Promise.race([
				action.and(page.locator(":enabled")).waitFor(),
				page.waitForURL((url) => url.pathname === after),
			]);
			expect(new URL(page.url()).pathname).toBe(before);
			expect(await page.getByRole("textbox", { name: /^CSS: \.note/ }).inputValue()).toContain("display: grid;");
			await action.click();
			await page.waitForURL((url) => url.pathname === after);
			const paragraph =
				canvas === "preview"
					? page.locator('[data-wc-code="content#note"]')
					: page.frameLocator("iframe[title^='Canvas']").locator("p.note");
			await paragraph.waitFor();
			expect(await paragraph.evaluate((node) => getComputedStyle(node).display)).toBe("grid");
			const saved = (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
				(each) => each.name === "note",
			);
			expect(saved?.css).toBe("&:hover { opacity: 0.5; }");
		} finally {
			release.resolve();
			releaseReads.resolve();
		}
	});
