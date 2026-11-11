import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

/** The outline must enclose the rendered output, including every repeated root. */
async function expectOutline(page: Page, kind: "selected" | "hover", selector: string) {
	await page.waitForFunction(
		({ kind, selector }) => {
			const outline = document
				.querySelector("webcraft-code-mode")
				?.shadowRoot?.querySelector<HTMLElement>(`.outline.${kind}`);
			const rects = [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect());
			if (!outline || outline.hidden || !rects.length) return false;
			const actual = outline.getBoundingClientRect();
			const expected = {
				left: Math.min(...rects.map((rect) => rect.left)),
				top: Math.min(...rects.map((rect) => rect.top)),
				right: Math.max(...rects.map((rect) => rect.right)),
				bottom: Math.max(...rects.map((rect) => rect.bottom)),
			};
			return Object.entries(expected).every(
				([edge, value]) => Math.abs(actual[edge as keyof typeof expected] - value) <= 2,
			);
		},
		{ kind, selector },
	);
	expect(await page.locator(`.outline.${kind}`).isVisible()).toBe(true);
}

for (const theme of THEMES) {
	test(`Loop selection and hover reach its markup and all rendered items (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Shared selection");
		const slug = `selection-${theme}`;
		const { id: siteId } = await local.createSite(workspace.id, { name: "Shared selection", slug });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { loop } = await api.loops.create({
			siteId,
			name: "hours",
			source: "items",
			fields: [{ key: "day", label: "Day", type: "text" }],
		});
		await api.loops.saveItems({ siteId, loopId: loop.id, items: [{ day: "Monday" }, { day: "Sunday" }] });
		await api.loops.publish({ siteId, loopId: loop.id });
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header data-wc-id="header">\n<p data-wc-id="before" data-wc-label="Before">Before</p>\n{{@loop hours as item}}\n<p data-wc-id="day">{{ item.day }}</p>\n{{/loop}}\n</header>\n<main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith(slug));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		const row = tree.getByRole("treeitem", { name: /Loop hours.*×2/ });
		await row.waitFor();
		await page.waitForLoadState("networkidle");
		await tree.getByRole("treeitem", { name: /^Before p$/ }).click();
		await page.locator(".language-markup .line.marked").filter({ hasText: 'data-wc-id="before"' }).waitFor();
		await row.hover();
		await page.locator(".language-markup .line.hovered").filter({ hasText: "{{@loop hours}}" }).waitFor();
		await expectOutline(page, "hover", 'header p[data-wc-code="site#day"]');
		expect(await tree.getByRole("treeitem", { name: /^Before p$/ }).getAttribute("aria-selected")).toBe("true");
		await row.click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "{{@loop hours}}" }).waitFor();
		await expectOutline(page, "selected", 'header p[data-wc-code="site#day"]');
		expect(await row.getAttribute("aria-selected")).toBe("true");
		expect(await page.locator(".language-markup .line.marked").allTextContents()).not.toContain(
			'<p data-wc-label="Before" data-wc-id="before">Before</p>',
		);
	});
}

for (const theme of THEMES) {
	test(`Conditions, branches, values and comments share selection without stale page outlines (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Selection branches");
		const slug = `selection-branches-${theme}`;
		const { id: siteId } = await local.createSite(workspace.id, { name: "Selection branches", slug });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { component } = await api.components.create({
			siteId,
			name: "SelectionNote",
			props: [
				{ key: "quote", label: "Quote", type: "text", default: "A shared quote" },
				{ key: "show", label: "Show", type: "boolean", default: false },
			],
		});
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup:
				'<section data-wc-id="note">\n<p data-wc-id="before" data-wc-label="Before">Before</p>\n{{@if props.show}}<p data-wc-id="absent">Never shown</p>{{/if}}\n{{@if props.show}}\n<p data-wc-id="hidden">Hidden</p>\n{{@else}}\n<p data-wc-id="quote">\n{{ props.quote }}\n</p>\n{{/if}}\n<!--Staff note-->\n<p data-wc-id="fixed">Fixed only</p>\n</section>',
		});
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<header data-wc-id="header"><SelectionNote data-wc-id="placement" /></header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith(slug));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.getByRole("treeitem", { name: /^Before p$/ }).click();
		await page.waitForLoadState("networkidle");
		const condition = tree.getByRole("treeitem", { name: /^If props.show/ }).last();
		await condition.click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "{{@if props.show}}" }).waitFor();
		await expectOutline(page, "selected", 'header p[data-wc-code="site/placement#quote"]');
		const branch = tree.getByRole("treeitem", { name: "Else", exact: true });
		await branch.hover();
		await page.locator(".language-markup .line.hovered").filter({ hasText: "{{@else}}" }).waitFor();
		await expectOutline(page, "hover", 'header p[data-wc-code="site/placement#quote"]');
		expect(await condition.getAttribute("aria-selected")).toBe("true");
		await branch.click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "{{@else}}" }).waitFor();
		await expectOutline(page, "selected", 'header p[data-wc-code="site/placement#quote"]');
		const value = tree.getByRole("treeitem", { name: /^\{\{ props.quote \}\}/ });
		await value.click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "{{ props.quote }}" }).waitFor();
		// A value has a text range, not the full width of its parent paragraph.
		const expectedText = await page.locator('header p[data-wc-code="site/placement#quote"]').evaluate((element) => {
			const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let text = nodes.nextNode();
			while (text && text.textContent !== "A shared quote") text = nodes.nextNode();
			if (!text) throw new Error("The rendered quote is missing");
			const range = document.createRange();
			range.selectNodeContents(text);
			return range.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number };
		});
		const actualText = await page.locator(".outline.selected").boundingBox();
		expect(actualText).not.toBeNull();
		for (const key of ["x", "y", "width", "height"] as const)
			expect(Math.abs((actualText?.[key] ?? -1000) - expectedText[key])).toBeLessThanOrEqual(2);
		await tree.getByRole("treeitem", { name: /^Staff note/ }).click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "<!--Staff note-->" }).waitFor();
		expect(await page.locator(".outline.selected").isVisible()).toBe(false);
		await tree.getByRole("treeitem", { name: /^Staff note/ }).hover();
		await page.locator(".language-markup .line.hovered").filter({ hasText: "<!--Staff note-->" }).waitFor();
		expect(await page.locator(".outline.hover").isVisible()).toBe(false);
		await tree.getByRole("treeitem", { name: /Fixed only.*Fixed text/ }).click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "Fixed only" }).waitFor();
		expect(await page.locator(".outline.selected").isVisible()).toBe(true);
		// The same parser positions drive caret selection, including a Component's Props preamble.
		const html = page.getByRole("textbox", { name: /^HTML of / });
		await html.evaluate((area: HTMLTextAreaElement) => {
			area.focus();
			area.setSelectionRange(area.value.indexOf("{{@else}}") + 3, area.value.indexOf("{{@else}}") + 3);
		});
		await html.press("ArrowRight");
		await tree.getByRole("treeitem", { name: "Else", exact: true, selected: true }).waitFor();
		await expectOutline(page, "selected", 'header p[data-wc-code="site/placement#quote"]');
		// Identical Conditions remain distinct by their source addresses, even when one renders nothing.
		await tree
			.getByRole("treeitem", { name: /^If props.show/ })
			.first()
			.click();
		await page.locator(".language-markup .line.marked").filter({ hasText: 'data-wc-id="absent"' }).waitFor();
		expect(await page.locator(".outline.selected").isVisible()).toBe(false);
		await tree.getByRole("treeitem", { name: /Hidden.*Fixed text/ }).click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "Hidden" }).waitFor();
		expect(await page.locator(".outline.selected").isVisible()).toBe(false);
	});
}

for (const theme of THEMES) {
	test(`read-only Module commands share hover and clear empty selection bounds (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		await api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const workspace = await local.createWorkspace("Read-only selection");
		const slug = `module-selection-${theme}`;
		const { id: siteId } = await local.createSite(workspace.id, { name: "Read-only selection", slug });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<header><Tabs data-wc-id="tabs" label="Details" /></header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith(slug));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.getByRole("treeitem").filter({ hasText: /^Tabs/ }).click();
		const html = page.getByRole("textbox", { name: "HTML of Tabs · Component" });
		await html.waitFor();
		await page.waitForLoadState("networkidle");
		const loop = tree.getByRole("treeitem", { name: /^Loop props.items/ });
		await loop.hover();
		await page.locator(".language-markup .line.hovered").filter({ hasText: "{{@loop props.items}}" }).waitFor();
		await loop.click();
		await page.waitForLoadState("networkidle");
		expect(await loop.getAttribute("aria-selected")).toBe("true");
		expect(await page.locator(".outline.selected").isVisible()).toBe(false);
		expect(await html.isEditable()).toBe(false);
	});
}

for (const theme of THEMES) {
	test(`Empty branches and generated command output follow selection from all views (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Generated selection");
		const slug = `generated-selection-${theme}`;
		const { id: siteId } = await local.createSite(workspace.id, { name: "Generated selection", slug });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { postTypes } = await api.postTypes.list({ siteId });
		const { entry: searchPage } = await api.entries.create({
			siteId,
			postTypeId: postTypes.find((each) => each.builtIn === "page")?.id ?? "",
			title: "Search",
			slug: "search",
		});
		await api.entries.publish({ siteId, entryId: searchPage.id });
		await api.pages.setSearchPage({ siteId, pageId: searchPage.id });
		await api.loops.create({
			siteId,
			name: "hours",
			source: "items",
			fields: [{ key: "day", label: "Day", type: "text" }],
		});
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header data-wc-id="header">\n{{@search}}\n{{@loop hours}}\n<p>{{ item.day }}</p>\n{{@empty}}\n<p data-wc-id="empty">Nothing yet</p>\n{{/loop}}\n</header>\n<main data-wc-id="main">\n{{@outlet}}\n</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith(slug));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		const empty = tree.getByRole("treeitem", { name: "When there are no items", exact: true });
		await empty.click();
		await page.locator(".language-markup .line.marked").filter({ hasText: "{{@empty}}" }).waitFor();
		await expectOutline(page, "selected", 'header p[data-wc-code="site#empty"]');
		const html = page.getByRole("textbox", { name: /^HTML of / });
		// Hover the command in the HTML textarea using its visible line's position.
		const line = page.locator(".language-markup .line").filter({ hasText: "{{@outlet}}" });
		await line.scrollIntoViewIfNeeded();
		const point = await line.boundingBox();
		if (!point) throw new Error("The outlet line is not visible");
		await page.mouse.move(point.x + 25, point.y + point.height / 2);
		await tree
			.getByRole("treeitem", { name: /^Page content/ })
			.and(page.locator('[data-hovered="true"]'))
			.waitFor();
		await expectOutline(page, "hover", "main > *");
		expect(await empty.getAttribute("aria-selected")).toBe("true");
		await html.evaluate((area: HTMLTextAreaElement) => {
			area.focus();
			const offset = area.value.indexOf("{{@outlet}}");
			area.setSelectionRange(offset + 3, offset + 3);
		});
		await html.press("ArrowRight");
		await tree.getByRole("treeitem", { name: /^Page content/, selected: true }).waitFor();
		await expectOutline(page, "selected", "main > *");
		await empty.click();
		await page.locator('header input[type="search"]').hover();
		await tree
			.getByRole("treeitem", { name: /^Search box/ })
			.and(page.locator('[data-hovered="true"]'))
			.waitFor();
		expect(await empty.getAttribute("aria-selected")).toBe("true");
		await page.locator('header input[type="search"]').click();
		await tree.getByRole("treeitem", { name: /^Search box/, selected: true }).waitFor();
		await expectOutline(page, "selected", "header form");
	});
}

for (const theme of THEMES) {
	test(`late selection metadata preserves newer typing, peer changes and the selected source (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Selection ownership");
		const slug = `selection-owner-${theme}`;
		const { id: siteId } = await local.createSite(workspace.id, { name: "Selection ownership", slug });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { component } = await api.components.create({
			siteId,
			name: "OwnedNote",
			props: [{ key: "quote", label: "Quote", type: "text", default: "Other source" }],
		});
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: '<p data-wc-id="note">\n{{ props.quote }}\n</p>',
		});
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header data-wc-id="header">\n<p data-wc-id="before" data-wc-label="Before">Before</p>\n{{@if true}}<p>Shown</p>{{/if}}\n<OwnedNote data-wc-id="placed" />\n</header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith(slug));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.getByRole("treeitem", { name: /^Before p$/ }).click();
		await page.waitForLoadState("networkidle");
		const html = page.getByRole("textbox", { name: /^HTML of / });
		const original = await html.inputValue();
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = page.waitForResponse(
			(response) =>
				response.url().endsWith("/code/editorRead") &&
				(response.request().postDataJSON() as { markup: string }).markup.includes(">Own first<"),
		);
		let held = false;
		await page.route("**/_webcraft/edit/api/code/editorRead", async (route) => {
			const request = route.request().postDataJSON() as { ref: string; markup: string };
			if (held || request.ref !== "site" || !request.markup.includes(">Own first<")) return route.continue();
			held = true;
			const response = await route.fetch();
			captured.resolve();
			await release.promise;
			await route.fulfill({ response });
		});
		try {
			await html.fill(original.replace(">Before<", ">Own first<"));
			await captured.promise;
			await html.fill(original.replace(">Before<", ">Own latest<"));
			await page.locator('header p[data-wc-code="site#before"]').filter({ hasText: "Own latest" }).waitFor();
			await page.getByRole("treeitem", { name: /Own latest.*Fixed text/ }).waitFor();
			// Let the public save settle before the peer changes a separate label.
			for (let attempt = 0; attempt < 80; attempt++) {
				if ((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft.includes("Own latest")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const draft = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			expect(draft).toContain("Own latest");
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: draft.replace(
					'<header data-wc-id="header">',
					'<header data-wc-label="Peer header" data-wc-id="header">',
				),
			});
			await tree.getByRole("treeitem", { name: /^Peer header/ }).waitFor();
			await tree.getByRole("treeitem", { name: /^If true/ }).click();
			await page.locator(".language-markup .line.marked").filter({ hasText: "{{@if true}}" }).waitFor();
			await tree
				.getByRole("treeitem", { name: /^OwnedNote/ })
				.getByText("OwnedNote", { exact: true })
				.click();
			await page.getByRole("textbox", { name: "HTML of OwnedNote · Component" }).waitFor();
			await tree.getByRole("treeitem", { name: /^\{\{ props.quote \}\}/ }).click();
			await page.waitForFunction(() => {
				const lines = document
					.querySelector("webcraft-code-mode")
					?.shadowRoot?.querySelectorAll(".language-markup .line.marked");
				return lines?.length === 1 && lines[0]?.textContent === "{{ props.quote }}";
			});
		} finally {
			release.resolve();
		}
		await (await delivered).finished();
		await page.waitForLoadState("networkidle");
		expect(await html.getAttribute("aria-label")).toBe("HTML of OwnedNote · Component");
		expect(await tree.getByRole("treeitem", { name: /^\{\{ props.quote \}\}/ }).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(await page.locator(".language-markup .line.marked").allTextContents()).toEqual(["{{ props.quote }}"]);
		const saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft;
		expect(saved).toContain("Own latest");
		expect(saved).toContain('data-wc-label="Peer header"');
	});
}
