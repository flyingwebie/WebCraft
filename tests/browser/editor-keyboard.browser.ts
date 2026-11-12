import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import { expectNoAxeViolations } from "./checks.ts";
import {
	type BrowserInstall,
	forgetPageErrors,
	pageErrors,
	startBrowserInstall,
	THEMES,
	type Theme,
} from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

async function openEditor(theme: Theme, canvas: "builder" | "live") {
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
		markup:
			'<article data-wc-id="main" data-wc-label="Main">\n<h1>Keyboard editor</h1><section data-wc-id="alpha" data-wc-label="Alpha"><p data-wc-id="apple" data-wc-label="Apple">One</p></section>\n<section data-wc-id="beta" data-wc-label="Beta"><a href="/stories/first" data-wc-id="berry" data-wc-label="Berry">Two</a></section>\n<section data-wc-id="bravo" data-wc-label="Bravo"><p>Three</p></section>\n</article>',
	});
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
	if (canvas === "live") {
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/stories/first");
	}
	const tree = page.getByRole("tree", { name: "Layers" });
	await tree.getByRole("treeitem", { name: /^Alpha/ }).waitFor();
	await page
		.getByRole("textbox", { name: "CSS: Site CSS", exact: true })
		.and(page.locator(":not([readonly])"))
		.waitFor();
	return { page, tree, api, siteId, postType };
}
async function focused(locator: Locator) {
	return locator.evaluate((element) => (element.getRootNode() as Document | ShadowRoot).activeElement === element);
}

async function waitForFocusRegion(page: Page, region: string) {
	await page.waitForFunction((region) => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return active?.closest<HTMLElement>("[data-editor-region]")?.dataset.editorRegion === region;
	}, region);
}

async function cycleBranchInspector(page: Page, branch: Locator) {
	await branch.press("F6");
	await waitForFocusRegion(page, "inspector");
	await page.keyboard.press("F6");
	await waitForFocusRegion(page, "html");
	await page.keyboard.press("Shift+F6");
	await waitForFocusRegion(page, "inspector");
	await page.keyboard.press("Shift+F6");
	expect(await focused(branch)).toBe(true);
}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`Command menu shares speech, focus and keyboard help on ${canvas} (${theme})`, async () => {
			const { page, tree } = await openEditor(theme, canvas);
			const alpha = tree.getByRole("treeitem", { name: /^Alpha/ });
			await alpha.click();
			await alpha.press("ControlOrMeta+k");
			const menu = page.getByRole("dialog", { name: "Command menu" });
			const search = menu.getByRole("combobox");
			await search.fill("Duplicate");
			await page.locator("[data-editor-messages]").getByRole("status").filter({ hasText: "1 result" }).waitFor();
			await search.press("F6");
			expect(await focused(search)).toBe(true);
			await search.press("Escape");
			await menu.waitFor({ state: "hidden" });
			await waitForFocusRegion(page, "tree");
			expect(await focused(alpha)).toBe(true);
			await alpha.press("ArrowLeft");
			await alpha.press("ControlOrMeta+p");
			await search.fill("Apple");
			await menu.getByRole("option", { name: /^Apple/ }).waitFor();
			await search.press("Enter");
			await menu.waitFor({ state: "hidden" });
			const apple = tree.getByRole("treeitem", { name: /^Apple/ });
			await apple.waitFor();
			await waitForFocusRegion(page, "tree");
			expect(await focused(apple)).toBe(true);
			expect(await alpha.getAttribute("aria-expanded")).toBe("true");
			const html = page.getByRole("textbox", { name: canvas === "builder" ? "Template markup" : /^HTML of / });
			await html.focus();
			await html.press("ControlOrMeta+k");
			await search.waitFor();
			await search.press("Escape");
			await menu.waitFor({ state: "hidden" });
			expect(await focused(html)).toBe(true);
			await html.press("ControlOrMeta+/");
			const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
			await help.waitFor();
			// Opening the dialog transfers focus after render; exercise F6 once that transfer finishes.
			await page.waitForFunction(
				(element) => element?.contains((element.getRootNode() as Document | ShadowRoot).activeElement),
				await help.elementHandle(),
			);
			for (const name of [
				"Find a layer by typing its name",
				"Open every branch at this level",
				"Toggle the whole branch",
				"Move between editor regions",
				"Indent the selected lines",
				"Outdent the selected lines",
			])
				expect(await help.getByRole("row").filter({ hasText: name }).count()).toBe(1);
			await page.keyboard.press("F6");
			expect(
				await help.evaluate((element) =>
					element.contains((element.getRootNode() as Document | ShadowRoot).activeElement),
				),
			).toBe(true);
			await expectNoAxeViolations(page, `${canvas} shared command help ${theme}`, [], {
				exclude: ["iframe[title^='Canvas']"],
			});
			expect(pageErrors(page)).toEqual([]);
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`tree keyboard and logical row semantics on ${canvas} (${theme})`, async () => {
			const { page, tree } = await openEditor(theme, canvas);
			const alpha = tree.getByRole("treeitem", { name: /^Alpha/ });
			const beta = tree.getByRole("treeitem", { name: /^Beta/ });
			await alpha.click();
			expect(await alpha.getAttribute("aria-level")).toBe("2");
			expect(await alpha.getAttribute("aria-posinset")).toBe("2");
			expect(await alpha.getAttribute("aria-setsize")).toBe("4");
			await alpha.press("b");
			expect(await focused(beta)).toBe(true);
			await beta.press("r");
			expect(await focused(tree.getByRole("treeitem", { name: /^Bravo/ }))).toBe(true);
			await alpha.click();
			await alpha.press("Alt+Enter");
			expect(await alpha.getAttribute("aria-expanded")).toBe("false");
			await beta.click();
			await beta.press("ArrowLeft");
			await beta.press("*");
			expect(await alpha.getAttribute("aria-expanded")).toBe("true");
			expect(await beta.getAttribute("aria-expanded")).toBe("true");
			await alpha.press("Alt+Enter");
			await alpha.press("Alt+Enter");
			expect(await tree.getByRole("treeitem", { name: /^Apple/ }).getAttribute("aria-expanded")).toBe("true");
			const label = page.getByLabel("Layer label", { exact: true });
			await label.fill("Alpha renamed");
			expect(await focused(label)).toBe(true);
			await label.press("Enter");
			await page.waitForLoadState("networkidle");
			await expectNoAxeViolations(page, `${canvas} keyboard ${theme}`, [], { exclude: ["iframe[title^='Canvas']"] });
			expect(pageErrors(page)).toEqual([]);
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`F6 deep memory, modal containment and action focus on ${canvas} (${theme})`, async () => {
			const { page, tree } = await openEditor(theme, canvas);
			const alpha = tree.getByRole("treeitem", { name: /^Alpha/ });
			await alpha.click();
			await alpha.press("F6");
			const label = page.getByLabel("Layer label", { exact: true });
			await label.focus();
			await page.keyboard.press("F6");
			const html = page.getByRole("textbox", { name: canvas === "builder" ? "Template markup" : /^HTML of / });
			expect(await focused(html)).toBe(true);
			await html.press("F6");
			expect(
				await page
					.getByRole("region", { name: "CSS", exact: true })
					.evaluate((region) => region.contains((region.getRootNode() as Document | ShadowRoot).activeElement)),
			).toBe(true);
			// Code mode also has Page/Site JS; the Template Builder has no JS region.
			await page.keyboard.press("F6");
			if (canvas === "live") await page.keyboard.press("F6");
			await page.keyboard.press("F6");
			expect(await focused(alpha)).toBe(true);
			await page.keyboard.press("F6");
			expect(await focused(label)).toBe(true);
			await page.keyboard.press("Shift+F6");
			await alpha.press("ControlOrMeta+i");
			const dialog = page.getByRole("dialog");
			await dialog.waitFor();
			await dialog.getByRole("combobox").first().focus();
			await page.keyboard.press("F6");
			expect(
				await dialog.evaluate((region) =>
					region.contains((region.getRootNode() as Document | ShadowRoot).activeElement),
				),
			).toBe(true);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			expect(await focused(alpha)).toBe(true);
			await alpha.press("ControlOrMeta+i");
			await dialog.getByRole("combobox").fill("Paragraph");
			await dialog.getByRole("combobox").press("Enter");
			await dialog.waitFor({ state: "hidden" });
			expect(await focused(tree.getByRole("treeitem", { selected: true }))).toBe(true);
			const bravo = tree.getByRole("treeitem", { name: /^Bravo/ });
			await bravo.click();
			await page
				.getByRole("textbox", { name: canvas === "builder" ? "Template markup" : /^HTML of / })
				.and(page.locator(":not([readonly])"))
				.waitFor();
			await bravo.press("Delete");
			const beta = tree.getByRole("treeitem", { name: /^Beta/ });
			await bravo.waitFor({ state: "hidden" });
			expect(await focused(beta)).toBe(true);
			expect(await beta.getAttribute("aria-selected")).toBe("true");
			await tree.getByRole("treeitem", { name: /^Berry/ }).press("Delete");
			expect(await focused(beta)).toBe(true);
			await alpha.press("Delete");
			expect(await focused(beta)).toBe(true);
			if (canvas === "live") {
				expect(
					await page
						.locator("a[data-wc-code]")
						.evaluateAll((links) => links.every((link) => (link as HTMLElement).tabIndex === -1)),
				).toBe(true);
				await page.getByRole("link", { name: "Skip to Layers", exact: true }).focus();
				await page.keyboard.press("Shift+F6");
				expect(
					await page
						.locator('[data-editor-region="topbar"]')
						.evaluate((region) => region.contains((region.getRootNode() as ShadowRoot).activeElement)),
				).toBe(true);
				await page.getByRole("button", { name: "Hide code", exact: true }).click();
				await page.keyboard.press("F6");
				expect(await focused(beta)).toBe(true);
				await page.keyboard.press("F6");
				await page.keyboard.press("F6");
				expect(
					await page
						.locator('[data-editor-region="topbar"]')
						.evaluate((region) => region.contains((region.getRootNode() as ShadowRoot).activeElement)),
				).toBe(true);
			}
			expect(pageErrors(page)).toEqual([]);
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`caret selection in a collapsed branch keeps a visible tree tab stop on ${canvas} (${theme})`, async () => {
			const { page, tree } = await openEditor(theme, canvas);
			const alpha = tree.getByRole("treeitem", { name: /^Alpha/ });
			await alpha.click();
			await alpha.press("ArrowLeft");
			const html = page.getByRole("textbox", { name: canvas === "builder" ? "Template markup" : /^HTML of / });
			await html.and(page.locator(":not([readonly])")).waitFor();
			if (canvas === "builder")
				await page.locator("[data-selected-tag]").filter({ hasText: 'data-wc-id="alpha"' }).waitFor();
			await html.focus();
			await html.evaluate((element) => {
				const area = element as HTMLTextAreaElement;
				const at = area.value.indexOf('data-wc-id="apple"');
				area.setSelectionRange(at, at);
			});
			await html.press("ArrowRight");
			await page.getByLabel("Layer label", { exact: true }).and(page.locator('[value="Apple"]')).waitFor();
			expect(await focused(html)).toBe(true);
			expect(await tree.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
			await html.press("Shift+F6");
			await page.keyboard.press("Shift+F6");
			expect(await focused(alpha)).toBe(true);
			expect(await alpha.getAttribute("aria-expanded")).toBe("false");
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`code indentation and suggestion Tab departure on ${canvas} (${theme})`, async () => {
			const { page } = await openEditor(theme, canvas);
			const html = page.getByRole("textbox", { name: canvas === "builder" ? "Template markup" : /^HTML of / });
			await html.and(page.locator(":not([readonly])")).waitFor();
			const markup = "<section>\n  <p>Text</p>\n</section>";
			await html.fill(markup);
			await html.press("ControlOrMeta+a");
			await html.press("ControlOrMeta+]");
			expect(await html.inputValue()).toBe("  <section>\n    <p>Text</p>\n  </section>");
			await html.press("ControlOrMeta+[");
			expect(await html.inputValue()).toBe(markup);
			await html.press("Tab");
			expect(await focused(html)).toBe(false);
			if (canvas === "live") {
				await html.focus();
				await html.press("ControlOrMeta+End");
				await page.keyboard.type("{{@");
				await page.getByRole("option", { name: /\{\{@if\}\}/ }).waitFor();
				await html.press("Tab");
				expect(await html.inputValue()).toEndWith("{{@if }}\n{{/if}}");
				expect(await focused(html)).toBe(false);
				await html.fill(markup);
			}
			const cssRegion = page.getByRole("region", { name: "CSS", exact: true });
			const css = cssRegion.getByRole("textbox", { name: "CSS: Site CSS", exact: true });
			await css.and(page.locator(":not([readonly])")).waitFor();
			await page.waitForLoadState("networkidle");
			await css.fill("p { color: red; }");
			await css.blur();
			await css.fill("p { color: blue; }");
			await css.press("ControlOrMeta+z");
			await page
				.locator("[data-editor-messages]")
				.getByRole("status")
				.filter({ hasText: /Undid Edit CSS/ })
				.waitFor();
			expect(await css.inputValue()).toBe("p { color: red; }");
			expect(await focused(css)).toBe(true);
			await css.fill("  p { color: red; }");
			await css.press("End");
			await css.press("Enter");
			expect(await css.inputValue()).toBe("  p { color: red; }\n  ");
			await css.fill("dis");
			await css.press("Control+Space");
			await cssRegion.getByRole("option", { name: "display", exact: true }).waitFor();
			await css.press("Tab");
			expect(await css.inputValue()).toBe("display: ;");
			expect(await focused(css)).toBe(false);
			await css.fill("dis");
			await css.press("Control+Space");
			await css.press("Shift+Tab");
			expect(await css.inputValue()).toBe("dis");
			expect(await focused(css)).toBe(false);
			await css.fill("@layer page { p { color: red; } }");
			await css.press("ControlOrMeta+s");
			await page
				.locator("[data-editor-messages]")
				.getByRole("alert")
				.filter({ hasText: /@layer/ })
				.waitFor();
			// Incomplete CSS suggestions are deliberately invalid previews, not runtime exceptions.
			forgetPageErrors(
				page,
				0,
				(message) => message === "Failed to load resource: the server responded with a status of 400 (Bad Request)",
			);
			expect(pageErrors(page)).toEqual([]);
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`shared speech, insertion focus and quiet autosaves on ${canvas} (${theme})`, async () => {
			const { page, tree, api, siteId, postType } = await openEditor(theme, canvas);
			const alpha = tree.getByRole("treeitem", { name: /^Alpha/ });
			await alpha.click();
			await alpha.press("ArrowLeft");
			await page.getByRole("button", { name: "Inside", exact: true }).click();
			await page.getByRole("button", { name: "Paragraph", exact: true }).click();
			const inserted = tree.getByRole("treeitem", { selected: true });
			await page.waitForFunction(() => {
				let active = document.activeElement;
				while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
				return (
					active?.getAttribute("role") === "treeitem" &&
					active.getAttribute("aria-selected") === "true" &&
					active.textContent?.trim() === "p"
				);
			});
			expect(await inserted.getAttribute("aria-level")).toBe("3");
			const messages = page.locator("[data-editor-messages]");
			expect(await messages.count()).toBe(1);
			const polite = messages.getByRole("status");
			const urgent = messages.getByRole("alert");
			await polite.filter({ hasText: /Inserted/ }).waitFor();
			await inserted.press("Alt+ArrowUp");
			await polite.filter({ hasText: /Moved/ }).waitFor();
			await inserted.press("Alt+ArrowUp");
			await urgent.filter({ hasText: /first/ }).waitFor();
			expect(await polite.textContent()).not.toMatch(/Saved/);
			for (let attempt = 0; attempt < 60; attempt++) {
				const draft =
					(await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.draft ?? "";
				if (draft.indexOf("Paragraph") >= 0 && draft.indexOf("Paragraph") < draft.indexOf('data-wc-id="apple"')) break;
				await page.waitForTimeout(50);
			}
			// A remote edit goes through the real shared Draft and must not take the Inspector's focus.
			const label = page.getByLabel("Layer label", { exact: true });
			await label.focus();
			const current = (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup;
			await api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: postType.id,
				markup: `${current?.draft}\n<!-- Peer update -->`,
			});
			await tree.getByRole("treeitem", { name: /Peer update/ }).waitFor();
			expect(await focused(label)).toBe(true);
			expect(await polite.textContent()).not.toMatch(/Saved/);
			// A refused insertion stays in its modal and reaches the same accessible message area.
			await tree.getByRole("treeitem", { name: /^Apple/ }).click();
			await page.getByRole("button", { name: "Inside", exact: true }).click();
			await tree.getByRole("treeitem", { name: /^Apple/ }).press("ControlOrMeta+i");
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("combobox").fill("Paragraph");
			await dialog.getByRole("combobox").press("Enter");
			await urgent.filter({ hasText: /can't go inside/ }).waitFor();
			expect(await dialog.isVisible()).toBe(true);
			await page.keyboard.press("Shift+F6");
			expect(
				await dialog.evaluate((region) =>
					region.contains((region.getRootNode() as Document | ShadowRoot).activeElement),
				),
			).toBe(true);
		});
	}

for (const theme of THEMES)
	test(`cross-canvas navigation focuses the selected row (${theme})`, async () => {
		const { page, tree } = await openEditor(theme, "builder");
		await tree.getByRole("treeitem", { name: /^Berry/ }).click();
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/stories/first");
		const berry = page.getByRole("treeitem", { name: /^Berry/, selected: true });
		await berry.waitFor();
		expect(await focused(berry)).toBe(true);
		await page.getByRole("button", { name: "Open in builder", exact: true }).click();
		await page.waitForURL((url) => url.pathname.startsWith("/builder/"));
		await berry.waitFor();
		expect(await focused(berry)).toBe(true);
	});

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`Component JS keys and saved text on ${canvas} (${theme})`, async () => {
			const { page, api, siteId, postType } = await openEditor(theme, canvas);
			const { component } = await api.components.create({ siteId, name: "KeyboardCard" });
			await api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: '<section data-wc-id="card"><h2>Card</h2></section>',
			});
			if (canvas === "builder") await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
			else {
				const markup =
					(await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.draft ?? "";
				await api.templates.saveEntryTemplateMarkup({
					siteId,
					postTypeId: postType.id,
					markup: `${markup}<KeyboardCard />`,
				});
				await page.reload();
				await page.getByRole("treeitem", { name: /^KeyboardCard/ }).click();
				await page.getByRole("textbox", { name: "HTML of KeyboardCard · Component", exact: true }).waitFor();
				await page
					.getByRole("group", { name: "Which script", exact: true })
					.getByRole("button", { name: "Component", exact: true })
					.click();
			}
			const region = page.getByRole("region", { name: /^JS/ });
			const js = region.getByRole("textbox", { name: "JS: KeyboardCard · Component script", exact: true });
			await js.and(page.locator(":not([readonly])")).waitFor();
			await js.fill("  // First");
			await js.press("End");
			await js.press("Enter");
			expect(await js.inputValue()).toBe("  // First\n  ");
			await js.fill("// First\n// Second");
			await js.press("ControlOrMeta+a");
			await js.press("ControlOrMeta+]");
			expect(await js.inputValue()).toBe("  // First\n  // Second");
			await js.press("ControlOrMeta+[");
			expect(await js.inputValue()).toBe("// First\n// Second");
			await js.press("Tab");
			expect(await focused(js)).toBe(false);
			await js.focus();
			await js.press("Shift+Tab");
			expect(await focused(js)).toBe(false);
			await region.getByRole("button", { name: "Save", exact: true }).click();
			await page.locator("[data-editor-messages]").getByRole("status").filter({ hasText: /Saved/ }).waitFor();
			expect((await api.components.getScript({ siteId, componentId: component.id })).script?.draft.code).toBe(
				"// First\n// Second",
			);
			await js.focus();
			await js.press("ControlOrMeta+a");
			await js.press("ControlOrMeta+]");
			expect(await js.inputValue()).toBe("  // First\n  // Second");
			await js.press("ControlOrMeta+z");
			await page
				.locator("[data-editor-messages]")
				.getByRole("status")
				.filter({ hasText: /Undid Edit JS/ })
				.waitFor();
			expect(await js.inputValue()).toBe("// First\n// Second");
			expect(await focused(js)).toBe(true);
			await page.waitForLoadState("networkidle");
			await expectNoAxeViolations(page, `${canvas} Component JS keyboard ${theme}`, [], {
				exclude: ["iframe[title^='Canvas']"],
			});
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`branch rows, hidden Placements and source names on ${canvas} (${theme})`, async () => {
			const { page, tree, api, siteId, postType } = await openEditor(theme, canvas);
			const { loop } = await api.loops.create({ siteId, name: "days", source: "items", fields: [] });
			await api.loops.publish({ siteId, loopId: loop.id });
			const { component } = await api.components.create({ siteId, name: "KeyboardCard" });
			await api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: '<section data-wc-id="card"><h2>Card</h2></section>',
			});
			await api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: postType.id,
				markup:
					'<article data-wc-id="main"><h1>Branches</h1>\n{{@if site.language == "it"}}<p>Italian</p>{{@else}}<section data-wc-label="Alternative"><p>English</p></section>{{/if}}\n{{@loop days as day}}<p>Day</p>{{@empty}}<p data-wc-label="No days">Empty</p>{{/loop}}\n<KeyboardCard data-wc-id="first" data-wc-hidden="true" /><KeyboardCard data-wc-id="second" /></article>',
			});
			await page.reload();
			const otherwise = tree.getByRole("treeitem", { name: "Else", exact: true });
			await otherwise.click();
			await cycleBranchInspector(page, otherwise);
			expect(await otherwise.getAttribute("aria-level")).toBe("3");
			expect(await otherwise.getAttribute("aria-posinset")).toBe("2");
			expect(await otherwise.getAttribute("aria-setsize")).toBe("2");
			expect(await otherwise.getAttribute("aria-expanded")).toBe("true");
			await otherwise.press("Alt+Enter");
			expect(await tree.getByRole("treeitem", { name: /^Alternative/ }).count()).toBe(0);
			await otherwise.press("Alt+Enter");
			expect(await tree.getByRole("treeitem", { name: /^Alternative/ }).getAttribute("aria-expanded")).toBe("true");
			const empty = tree.getByRole("treeitem", { name: "When there are no items", exact: true });
			await empty.click();
			await cycleBranchInspector(page, empty);
			await empty.press("ArrowLeft");
			expect(await empty.getAttribute("aria-expanded")).toBe("false");
			await empty.press("*");
			expect(await empty.getAttribute("aria-expanded")).toBe("true");
			const hidden = tree.getByRole("treeitem", { name: /KeyboardCard.*Placement of KeyboardCard.*hidden placement/ });
			expect(await hidden.count()).toBe(1);
			if (canvas === "live") {
				expect(
					await page
						.locator("[data-wc-hidden-placement]")
						.evaluateAll(
							(nodes) => nodes.length > 0 && nodes.every((node) => node.getAttribute("aria-hidden") === "true"),
						),
				).toBe(true);
				const roots = tree.getByRole("treeitem", { name: /section.*from Component KeyboardCard/ });
				expect(await roots.count()).toBe(2);
				for (const row of await roots.all()) {
					expect(await row.getAttribute("aria-posinset")).toBe("1");
					expect(await row.getAttribute("aria-setsize")).toBe("1");
				}
				await hidden.press("Alt+Enter");
				expect(await roots.count()).toBe(1);
				await hidden.press("Alt+Enter");
				expect(await roots.count()).toBe(2);
			}
			for (const [label, parent] of [
				["Alternative", "Else"],
				["No days", "When there are no items"],
			]) {
				const child = tree.getByRole("treeitem", { name: new RegExp(`^${label}`) });
				await child.press("Delete");
				await child.waitFor({ state: "hidden" });
				const branch = tree.getByRole("treeitem", { name: parent, exact: true, selected: true });
				await branch.waitFor();
				expect(await focused(branch)).toBe(true);
			}
			await page.waitForLoadState("networkidle");
			await expectNoAxeViolations(page, `${canvas} branch semantics ${theme}`, [], {
				exclude: ["iframe[title^='Canvas']"],
			});
		});
	}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`drawer F6 memory and cross-canvas action focus on ${canvas} (${theme})`, async () => {
			const { page, tree } = await openEditor(theme, canvas);
			const alpha = tree.getByRole("treeitem", { name: /^Alpha/ });
			await alpha.click();
			const label = page.getByLabel("Layer label", { exact: true });
			await label.focus();
			await page.setViewportSize({ width: 1100, height: 900 });
			await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
			expect(await focused(label)).toBe(true);
			await page.keyboard.press("F6");
			await waitForFocusRegion(page, "html");
			expect(await page.getByRole("button", { name: "Settings", exact: true }).getAttribute("aria-expanded")).toBe(
				"false",
			);
			await page.keyboard.press("Shift+F6");
			await waitForFocusRegion(page, "inspector");
			expect(await focused(label)).toBe(true);
			await page.keyboard.press("Shift+F6");
			await waitForFocusRegion(page, "tree");
			expect(await focused(alpha)).toBe(true);
			for (let cycle = 0; cycle < 3; cycle++) {
				await page.keyboard.press("Shift+F6");
				await waitForFocusRegion(page, "topbar");
				await page.keyboard.press("F6");
				await waitForFocusRegion(page, "tree");
			}
			await alpha.press("ControlOrMeta+i");
			const dialog = page.getByRole("dialog");
			await dialog.waitFor();
			await dialog.getByRole("combobox").first().focus();
			await page.keyboard.press("F6");
			expect(
				await dialog.evaluate((dialog) =>
					dialog.contains((dialog.getRootNode() as Document | ShadowRoot).activeElement),
				),
			).toBe(true);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			await alpha.press("Delete");
			const beta = tree.getByRole("treeitem", { name: /^Beta/ });
			await waitForFocusRegion(page, "tree");
			expect(await focused(beta)).toBe(true);
			await page
				.getByRole("button", { name: canvas === "builder" ? "View on a page" : "Open in builder", exact: true })
				.click();
			await page.waitForURL((url) =>
				canvas === "builder" ? url.pathname === "/stories/first" : url.pathname.includes("/builder/"),
			);
			if (canvas === "live") expect(new URL(page.url()).searchParams.get("element")).toBe("beta");
			await waitForFocusRegion(page, "tree");
			expect(await focused(page.getByRole("treeitem", { name: /^Beta/ }))).toBe(true);
			// Destination controls finish loading after the selected row; measure their settled styling.
			await page.waitForLoadState("networkidle");
			await expectNoAxeViolations(page, `drawer keyboard ${canvas} ${theme}`, [], {
				exclude: ["iframe[title^='Canvas']"],
			});
		});
	}

for (const theme of THEMES)
	test(`F6 reaches the tree from the real Builder preview iframe (${theme})`, async () => {
		const { page, tree } = await openEditor(theme, "builder");
		await page.frameLocator("iframe[title^='Canvas']").getByText("Two", { exact: true }).click();
		expect(await page.locator("iframe[title^='Canvas']").evaluate((frame) => document.activeElement === frame)).toBe(
			true,
		);
		await page.keyboard.press("F6");
		await waitForFocusRegion(page, "tree");
		expect(await focused(tree.getByRole("treeitem", { name: /^Berry/ }))).toBe(true);
	});

for (const theme of THEMES)
	test(`cross-canvas navigation waits for the current layer's delayed selection metadata (${theme})`, async () => {
		const { page, tree } = await openEditor(theme, "live");
		await tree.getByRole("treeitem", { name: /^Alpha/ }).click();
		await page.waitForLoadState("networkidle");
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await page.route("**/_webcraft/edit/api/code/open", async (route) => {
			const response = await route.fetch();
			if ((route.request().postDataJSON() as { ref?: string }).ref === "content#beta") {
				held.resolve();
				await release.promise;
			}
			await route.fulfill({ response });
		});
		try {
			await tree.getByRole("treeitem", { name: /^Beta/ }).click();
			await held.promise;
			await page.getByRole("button", { name: "Open in builder", exact: true }).click();
			release.resolve();
			await page.waitForURL((url) => url.pathname.includes("/builder/"));
			expect(new URL(page.url()).searchParams.get("element")).toBe("beta");
			await waitForFocusRegion(page, "tree");
			expect(await focused(page.getByRole("treeitem", { name: /^Beta/ }))).toBe(true);
		} finally {
			release.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
	});
