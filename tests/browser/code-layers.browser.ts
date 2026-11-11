import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Locator } from "playwright";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

/** Repeated actions must mutate the live region so assistive technology hears them again. */
async function nextAnnouncement(region: Locator): Promise<{ heard: Promise<string | null> }> {
	const ready = Promise.withResolvers<void>();
	const callback = `announcementReady${crypto.randomUUID().replaceAll("-", "")}`;
	await region.page().exposeFunction(callback, ready.resolve);
	const heard = region
		.evaluate(
			(element, callback) =>
				new Promise<string>((resolve, reject) => {
					const observer = new MutationObserver(() => {
						clearTimeout(timeout);
						observer.disconnect();
						resolve(element.textContent ?? "");
					});
					const timeout = setTimeout(() => {
						observer.disconnect();
						reject(new Error("The next action was not announced"));
					}, 5000);
					observer.observe(element, { childList: true, characterData: true, subtree: true });
					(window as unknown as Record<string, () => void>)[callback]?.();
				}),
			callback,
		)
		.then(
			(text) => text.trim(),
			(error) => {
				ready.reject(error);
				return null;
			},
		);
	await ready.promise;
	return { heard };
}

for (const theme of THEMES) {
	test(`live Layers and Inspector share selection and Draft edits (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Editor panels");
		const slug = `layers-${theme}`;
		const { id: siteId } = await local.createSite(workspace.id, { name: "Editor panels", slug });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header data-wc-id="header">\n<p data-wc-id="welcome">\nWelcome\n</p>\n</header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith(slug));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.waitFor();
		await page.locator("header p[data-wc-code]").click();
		await page.getByLabel("Layer label", { exact: true }).fill("Greeting");
		await page.getByLabel("Layer label", { exact: true }).press("Enter");
		await tree.getByRole("treeitem", { name: /Greeting/ }).waitFor();
		await page.waitForFunction(() =>
			document
				.querySelector("webcraft-code-mode")
				?.shadowRoot?.querySelector("textarea")
				?.value.includes('data-wc-label="Greeting"'),
		);
		for (let attempt = 0; attempt < 80; attempt++) {
			if ((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft.includes('data-wc-label="Greeting"'))
				break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain('data-wc-label="Greeting"');
		const other = await install.newPage(theme);
		other.setDefaultTimeout(10000);
		await other.context().addCookies(await page.context().cookies());
		await other.goto(page.url());
		await other.getByRole("tree", { name: "Layers" }).waitFor();
		const html = page.getByRole("textbox", { name: /^HTML of / });
		await html.focus();
		await html.press("ControlOrMeta+a");
		await html.press("ArrowLeft");
		await html.press("ArrowRight");
		expect(await html.evaluate((area: HTMLTextAreaElement) => area.selectionStart)).toBe(1);
		await tree.getByRole("treeitem", { name: /^header$/, selected: true }).waitFor();
		await tree.getByRole("treeitem", { name: /Greeting/ }).click();
		const beforeTyping = await html.inputValue();
		const refusals: Promise<{ path: string; status: number; code: unknown }>[] = [];
		page.on("response", (response) => {
			if (response.status() < 400) return;
			refusals.push(
				response
					.json()
					.catch(() => ({}))
					.then((body) => ({
						path: new URL(response.url()).pathname,
						status: response.status(),
						code: body.code,
					})),
			);
		});
		const invalid = page.waitForResponse(
			(response) => response.url().endsWith("/code/editorRead") && response.status() === 400,
		);
		await html.fill(`${beforeTyping}<aside`);
		await invalid;
		await other.getByRole("treeitem", { name: /Greeting/ }).click();
		await other.getByLabel("Layer label", { exact: true }).fill("Greeting together");
		await other.getByLabel("Layer label", { exact: true }).press("Enter");
		await tree.getByRole("treeitem", { name: /Greeting together/ }).waitFor();
		const release = Promise.withResolvers<void>();
		let hold = true;
		await page.route("**/_webcraft/edit/api/code/open", async (route) => {
			if (hold) {
				hold = false;
				await release.promise;
			}
			await route.continue();
		});
		try {
			const opening = page.waitForRequest((request) => request.url().endsWith("/code/open"));
			await html.fill(beforeTyping.replace("Welcome", "Typed together"));
			await opening;
			await html.fill((await html.inputValue()).replace("Typed together", "Typed together twice"));
		} finally {
			release.resolve();
		}
		await other.locator("header p", { hasText: "Typed together twice" }).waitFor();
		expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain(
			'data-wc-label="Greeting together"',
		);
		await other.getByRole("treeitem", { name: /Typed together/ }).waitFor();
		await other.getByRole("treeitem", { name: /Greeting together/ }).waitFor();
		await page.unroute("**/_webcraft/edit/api/code/open");
		await page.waitForLoadState("networkidle");
		const printed = Promise.withResolvers<void>();
		const display = Promise.withResolvers<void>();
		let holdPrinted = true;
		await page.route("**/_webcraft/edit/api/code/open", async (route) => {
			if (!holdPrinted) return route.continue();
			holdPrinted = false;
			const response = await route.fetch();
			printed.resolve();
			await display.promise;
			await route.fulfill({ response });
		});
		try {
			await html.fill((await html.inputValue()).replace("Typed together twice", "Typed before printing"));
			await printed.promise;
			await other.getByRole("treeitem", { name: /Greeting together/ }).click();
			await other.getByLabel("Layer label", { exact: true }).fill("Greeting later");
			await other.getByLabel("Layer label", { exact: true }).press("Enter");
			await tree.getByRole("treeitem", { name: /Greeting later/ }).waitFor();
		} finally {
			display.resolve();
		}
		await page.waitForFunction(() =>
			document
				.querySelector("webcraft-code-mode")
				?.shadowRoot?.querySelector("textarea")
				?.value.includes('data-wc-label="Greeting later"'),
		);
		await other.close();
		await tree.getByRole("treeitem", { name: /Greeting/ }).hover();
		await page.locator('.outline.hover[data-hover-ref="site#welcome"]').waitFor();
		expect(await tree.getByRole("treeitem", { name: /Greeting/ }).getAttribute("aria-selected")).toBe("true");
		await page.locator(".language-markup .line.hovered").waitFor();

		await page.getByRole("button", { name: "After", exact: true }).click();
		await page.getByRole("button", { name: "Paragraph", exact: true }).focus();
		await page.locator('[data-insert-preview="after"]').waitFor();
		expect(await page.locator(".language-markup .insert-line").textContent()).toContain("</p>");
		await page.getByRole("button", { name: "Paragraph", exact: true }).press("Enter");
		await page.locator("header p").filter({ hasText: "Paragraph" }).waitFor();
		expect(await tree.getByRole("treeitem", { name: /^p$/ }).getAttribute("aria-selected")).toBe("true");
		await tree.getByRole("treeitem", { name: /Greeting/ }).click();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		const addClass = page.getByRole("combobox", { name: "Add a Class" });
		await addClass.fill("greeting");
		await addClass.press("Enter");
		await page.getByRole("button", { name: "Edit the styles of greeting" }).waitFor();
		await expectNoAxeViolations(page, `Code mode Layers (${theme})`);
		// Incomplete authored HTML is refused; other HTTP failures and browser errors are unexpected.
		const failed = await Promise.all(refusals);
		expect(failed.length).toBeGreaterThan(0);
		for (const refusal of failed) {
			expect(["/_webcraft/edit/api/code/preview", "/_webcraft/edit/api/code/editorRead"]).toContain(refusal.path);
			expect(refusal.status).toBe(400);
			expect(refusal.code).toBe("TEMPLATE_MARKUP_INVALID");
		}
		expect(
			pageErrors(page).filter(
				(message) => message !== "Failed to load resource: the server responded with a status of 400 (Bad Request)",
			),
		).toEqual([]);
		if (process.env.WEBCRAFT_EDITOR_EVIDENCE)
			await page.screenshot({ path: `${process.env.WEBCRAFT_EDITOR_EVIDENCE}/layers-${theme}.png` });
	});
}

test("Placements keep their own Props beside the Component's inline tree and markup", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("Placement editor");
	const { id: siteId } = await local.createSite(workspace.id, { name: "Placement editor", slug: "placement-editor" });
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { component } = await api.components.create({
		siteId,
		name: "Quote",
		props: [{ key: "quote", label: "Quotation", type: "text", required: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<blockquote data-wc-id="quotation">{{ props.quote }}</blockquote>\n<p data-wc-id="credit">Credit</p>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header><Quote data-wc-id="quote-placement" quote="First quotation" /></header><main>{{@outlet}}</main>',
	});
	const page = await install.newPage("dark");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith("placement-editor"));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	const tree = page.getByRole("tree", { name: "Layers" });
	await tree.getByText("Component · Quote", { exact: true }).waitFor();
	await tree
		.getByRole("treeitem")
		.filter({ hasText: /^Quote/ })
		.click();
	await page.getByRole("textbox", { name: "HTML of Quote · Component" }).waitFor();
	await page.locator(".outline.selected").waitFor();
	const marked = await page.locator(".language-markup .line.marked").allTextContents();
	expect(marked.slice(0, 3)).toEqual(["{{@props}}", expect.stringContaining("quote: text required"), "{{/props}}"]);
	expect(marked.slice(3)).toEqual([
		'<blockquote data-wc-id="quotation">{{ props.quote }}</blockquote>',
		'<p data-wc-id="credit">Credit</p>',
	]);
	const selected = await page.locator(".outline.selected").boundingBox();
	const quotation = await page.locator("blockquote[data-wc-code]").boundingBox();
	const credit = await page.locator('p[data-wc-code$="#credit"]').boundingBox();
	expect(selected?.y).toBeCloseTo(quotation?.y ?? 0, 0);
	expect((selected?.y ?? 0) + (selected?.height ?? 0)).toBeCloseTo((credit?.y ?? 0) + (credit?.height ?? 0), 0);
	await page.getByRole("button", { name: "After", exact: true }).click();
	await page.getByRole("button", { name: "Paragraph", exact: true }).focus();
	const marker = page.locator('[data-insert-preview="after"]');
	await marker.waitFor();
	expect((await marker.boundingBox())?.y).toBeCloseTo((credit?.y ?? 0) + (credit?.height ?? 0), 0);
	await page.getByRole("button", { name: "Paragraph", exact: true }).press("Enter");
	await page.locator("header > p", { hasText: "Paragraph" }).waitFor();
	expect(await page.locator("header > p").allTextContents()).toEqual(["Credit", "Paragraph"]);
	await tree
		.getByRole("treeitem")
		.filter({ hasText: /^Quote/ })
		.click();
	await page.getByLabel("Quotation (required)", { exact: true }).fill("This Placement only");
	await page.getByLabel("Quotation (required)", { exact: true }).press("Enter");
	await page.locator("blockquote", { hasText: "This Placement only" }).waitFor();
	expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain(
		'quote="This Placement only"',
	);
	expect((await api.components.getMarkup({ siteId, componentId: component.id })).markup.draft).toContain("props.quote");
	const placement = tree.getByRole("treeitem").filter({ hasText: /^Quote/ });
	await placement.focus();
	await placement.press("Tab");
	expect(
		await tree.evaluate((element) =>
			element.contains(
				element.getRootNode() instanceof ShadowRoot
					? (element.getRootNode() as ShadowRoot).activeElement
					: document.activeElement,
			),
		),
	).toBe(false);
	await placement.focus();
	await placement.press("Shift+Tab");
	const visibility = page.getByRole("group", { name: "Selected layer", exact: true });
	expect(
		await visibility
			.getByRole("button", { name: "Hide placement", exact: true })
			.evaluate((element) => element.matches(":focus")),
	).toBe(true);
	const changed = page.getByRole("status").filter({ hasText: "Changed." });
	await changed.waitFor();
	const hiddenAnnouncement = await nextAnnouncement(changed);
	await page.keyboard.press("Enter");
	await page.locator("blockquote[data-wc-hidden-placement]").waitFor();
	expect(await hiddenAnnouncement.heard).toBe("Changed.");
	await visibility.getByRole("button", { name: "Show placement", exact: true }).press("Enter");
	await page.locator("blockquote:not([data-wc-hidden-placement])").waitFor();
	await page.getByRole("button", { name: "Edit the Component", exact: true }).click();
	await page.getByLabel("Layer label", { exact: true }).waitFor();
	expect(await tree.getByRole("button", { name: "Hide placement", exact: true }).count()).toBe(1);
	await tree.getByRole("button", { name: "Hide placement", exact: true }).click();
	await tree.locator('[data-hidden="true"]').waitFor();
	await page.locator("blockquote[data-wc-hidden-placement]").waitFor();
	expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain('data-wc-hidden="true"');
	await tree.getByRole("button", { name: "Show placement", exact: true }).click();
	await page.locator("blockquote:not([data-wc-hidden-placement])").waitFor();
	await expectNoAxeViolations(page, "Placement and Component elements");
});

for (const theme of THEMES) {
	test(`making fixed text a Prop announces the conversion on the live canvas (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Fixed text announcement");
		const { id: siteId } = await local.createSite(workspace.id, {
			name: "Fixed text announcement",
			slug: "fixed-text-announcement",
		});
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { component } = await api.components.create({ siteId, name: "Notice" });
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: '<aside data-wc-id="notice"><p data-wc-id="message">Closed on Sundays</p></aside>',
		});
		await api.components.publish({ siteId, componentId: component.id });
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<header><Notice data-wc-id="notice-placement" /></header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith("fixed-text-announcement"));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.waitFor();
		await page.locator('p[data-wc-code$="#message"]').click();
		await page.getByLabel("Layer label", { exact: true }).fill("Message holder");
		await page.getByLabel("Layer label", { exact: true }).press("Enter");
		await tree.getByRole("treeitem", { name: /Message holder/ }).waitFor();
		const status = page.getByRole("status").filter({ hasText: "Renamed Message holder." });
		await status.waitFor();
		await tree.getByRole("treeitem", { name: /^“Closed on Sundays”/ }).click();
		await page.getByRole("button", { name: "Make it a Prop", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Make it a Prop" });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Message");
		const announcement = await nextAnnouncement(status);
		await dialog.getByRole("button", { name: "Make it a Prop", exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		expect(await announcement.heard).toBe("The text now reads {{ props.message }}.");
		let saved = await api.components.getMarkup({ siteId, componentId: component.id });
		for (let attempt = 0; attempt < 40 && !saved.markup.draft.includes("{{ props.message }}"); attempt++) {
			await page.waitForTimeout(100);
			saved = await api.components.getMarkup({ siteId, componentId: component.id });
		}
		expect(saved.markup.draft).toContain("{{ props.message }}");
		expect(saved.component.draft.props).toEqual([
			expect.objectContaining({ key: "message", default: "Closed on Sundays" }),
		]);
		await tree.getByRole("treeitem", { name: /^\{\{ props.message \}\}/, selected: true }).waitFor();
		await page.locator(".language-markup .line.marked").filter({ hasText: "{{ props.message }}" }).waitFor();
		expect(await page.locator(".outline.selected").isVisible()).toBe(true);
	});
}

test("the same Component's HTML updates through each Placement", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("Repeated Component");
	const { id: siteId } = await local.createSite(workspace.id, {
		name: "Repeated Component",
		slug: "repeated-component",
	});
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { component } = await api.components.create({ siteId, name: "Notice", props: [] });
	await api.components.saveMarkup({ siteId, componentId: component.id, markup: '<p data-wc-id="notice">Before</p>' });
	await api.components.publish({ siteId, componentId: component.id });
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header><Notice data-wc-id="first" /><Notice data-wc-id="second" /></header><main>{{@outlet}}</main>',
	});
	const first = await install.newPage("dark");
	first.setDefaultTimeout(10000);
	await install.signIn(first, staff);
	await first.goto(install.adminUrl(`/sites/${siteId}`));
	await first.getByRole("button", { name: "Edit on site" }).click();
	await first.waitForURL((url) => url.hostname.startsWith("repeated-component"));
	await first.getByRole("button", { name: "Code", exact: true }).click();
	await first.getByRole("tree").getByText("Component · Notice", { exact: true }).nth(1).waitFor();
	const second = await install.newPage("dark");
	second.setDefaultTimeout(10000);
	await second.context().addCookies(await first.context().cookies());
	await second.goto(first.url());
	await second.getByRole("tree").getByText("Component · Notice", { exact: true }).nth(1).waitFor();
	await first.locator('[data-wc-code="site/first#notice"]').click();
	await second.locator('[data-wc-code="site/second#notice"]').click();
	await first.getByRole("textbox", { name: "HTML of Notice · Component" }).waitFor();
	await second.getByRole("textbox", { name: "HTML of Notice · Component" }).waitFor();
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<h2 data-wc-id="above">Above</h2>\n<p data-wc-id="notice">After</p>',
	});
	for (const page of [first, second]) {
		await page.waitForFunction(() =>
			document.querySelector("webcraft-code-mode")?.shadowRoot?.querySelector("textarea")?.value.includes("After"),
		);
		expect(await page.locator(".language-markup .line.marked").textContent()).toContain('data-wc-id="notice"');
	}
});

test("Builder and Code mode edit the same live Draft", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("Two canvases");
	const { id: siteId } = await local.createSite(workspace.id, { name: "Two canvases", slug: "two-canvases" });
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	await api.designSystem.createClass({ siteId, name: "shared-ink", styles: "color: rgb(30, 40, 50);" });
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header><p class="shared-ink" data-wc-id="shared">Together</p></header><main>{{@outlet}}</main>',
	});
	const builder = await install.newPage("light");
	builder.setDefaultTimeout(10000);
	await install.signIn(builder, staff);
	await builder.goto(install.adminUrl(`/builder/${siteId}/site-template`));
	await builder.getByRole("tree", { name: "Layers" }).waitFor();
	const page = await install.newPage("dark");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith("two-canvases"));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	await page.getByRole("tree", { name: "Layers" }).waitFor();
	await builder.getByRole("treeitem", { name: /^p .*shared-ink/ }).click();
	await builder.getByLabel("Layer label", { exact: true }).fill("From Builder");
	await builder.getByLabel("Layer label", { exact: true }).press("Enter");
	await page.getByRole("treeitem", { name: /From Builder/ }).waitFor();
	await page.getByRole("treeitem", { name: /From Builder/ }).click();
	await page.getByLabel("Layer label", { exact: true }).fill("From Code");
	await page.getByLabel("Layer label", { exact: true }).press("Enter");
	await builder.getByRole("treeitem", { name: /From Code/ }).waitFor();
	expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain('data-wc-label="From Code"');
	// Let the preceding tree edit settle; the Class edit must propagate without another tree change.
	await page.waitForTimeout(1000);
	await builder.getByRole("tab", { name: "Style", exact: true }).click();
	await builder.getByRole("button", { name: "Edit the styles of shared-ink" }).click();
	await page.getByRole("tab", { name: "Style", exact: true }).click();
	await page.getByRole("button", { name: "Edit the styles of shared-ink" }).click();
	await page.getByLabel("Value 1", { exact: true }).fill("rgb(20, 30, 40)");
	await page.getByRole("button", { name: "Save shared-ink", exact: true }).click();
	await page.waitForFunction(() => {
		const paragraph = document.querySelector("header p");
		return paragraph && getComputedStyle(paragraph).color === "rgb(20, 30, 40)";
	});
	await builder.waitForFunction(() => {
		const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
		const paragraph = frame?.contentDocument?.querySelector("header p");
		return paragraph && frame?.contentWindow?.getComputedStyle(paragraph).color === "rgb(20, 30, 40)";
	});
	await builder.waitForFunction(
		() => document.querySelector<HTMLInputElement>('input[aria-label="Value 1"]')?.value === "rgb(20, 30, 40)",
	);
	await page.getByRole("region", { name: "HTML" }).getByRole("button", { name: "Save", exact: true }).click();
	await page.getByText("Saved to Draft · Site template", { exact: true }).first().waitFor();
	const html = page.getByRole("textbox", { name: /^HTML of / });
	await html.fill((await html.inputValue()).replace("<p ", '<p style="color: rgb(1, 2, 3);" '));
	await builder.waitForFunction(() => {
		const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
		const paragraph = frame?.contentDocument?.querySelector("header p");
		return paragraph && frame?.contentWindow?.getComputedStyle(paragraph).color === "rgb(1, 2, 3)";
	});
	await builder.getByRole("button", { name: "Template markup", exact: true }).click();
	const builderHtml = builder.getByRole("textbox", { name: "Template markup", exact: true });
	await builderHtml.fill((await builderHtml.inputValue()).replace("Together", "Written in Builder markup"));
	await page.locator("header p", { hasText: "Written in Builder markup" }).waitFor();
});

test("Loops show their rendered count and use the shared keyboard actions", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("Loop layers");
	const { id: siteId } = await local.createSite(workspace.id, { name: "Loop layers", slug: "loop-layers" });
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const { loop } = await api.loops.create({
		siteId,
		name: "hours",
		source: "items",
		fields: [{ key: "day", label: "Day", type: "text" }],
	});
	await api.loops.saveItems({ siteId, loopId: loop.id, items: [{ day: "Monday" }, { day: "Sunday" }] });
	await api.loops.publish({ siteId, loopId: loop.id });
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "Opening hours",
		slug: "hours",
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	await api.pages.setHomePage({ siteId, pageId: entry.id });
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header data-wc-id="header">{{@loop hours as item}}<p data-wc-id="day">{{ item.day }}</p>{{/loop}}</header><main>{{@outlet}}</main>',
	});
	const page = await install.newPage("dark");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith("loop-layers"));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	const tree = page.getByRole("tree", { name: "Layers" });
	await tree.getByRole("treeitem", { name: /Loop hours.*×2/ }).waitFor();
	await tree.getByText("Page layout · Opening hours", { exact: true }).waitFor();
	await tree.getByRole("treeitem", { name: /Loop hours.*×2/ }).click();
	await page.getByRole("button", { name: "Paragraph", exact: true }).focus();
	await page.locator(".language-markup .insert-line").waitFor();
	await page.locator('[data-insert-preview="inside"]').waitFor();
	await tree.getByRole("treeitem", { name: /^p$/ }).click();
	await page.keyboard.press("F2");
	const rename = page.getByRole("textbox", { name: "Layer label of p" });
	await rename.fill("Day name");
	await rename.press("Enter");
	await tree.getByRole("treeitem", { name: /Day name/ }).waitFor();
	await page.keyboard.press("ControlOrMeta+d");
	await page.waitForFunction(() => document.querySelectorAll("header p").length === 4);
	await page.keyboard.press("ControlOrMeta+d");
	await page.waitForFunction(() => document.querySelectorAll("header p").length === 6);
	await tree
		.getByRole("treeitem", { name: /Day name/ })
		.first()
		.click();
	await page.keyboard.press("Delete");
	await page.waitForFunction(() => document.querySelectorAll("header p").length === 4);
	const deletion = page.getByRole("status").filter({ hasText: "Deleted Day name." });
	await deletion.waitFor();
	await tree
		.getByRole("treeitem", { name: /Day name/ })
		.first()
		.click();
	const announced = await nextAnnouncement(deletion);
	await page.keyboard.press("Delete");
	await page.waitForFunction(() => document.querySelectorAll("header p").length === 2);
	expect(await announced.heard).toBe("Deleted Day name.");
	await tree.getByRole("treeitem", { name: /Day name/ }).focus();
	await page.keyboard.press("ControlOrMeta+i");
	await page.getByRole("dialog").waitFor();
	await expectNoAxeViolations(page, "Shared Insert dialog on the live page");
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain('data-wc-label="Day name"');
});

for (const canvas of ["live", "preview"] as const) {
	test(`pastes layers into Else and Empty branches on the ${canvas} canvas`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Branch paste");
		const { id: siteId } = await local.createSite(workspace.id, { name: "Branch paste", slug: "branch-paste" });
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		const { loop } = await api.loops.create({
			siteId,
			name: "days",
			source: "items",
			fields: [{ key: "day", label: "Day", type: "text" }],
		});
		await api.loops.publish({ siteId, loopId: loop.id });
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header data-wc-id="header"><p data-wc-id="source" data-wc-label="Copy source">Copied value</p>{{@if site.language == "it"}}<span>Italian</span>{{@else}}{{/if}}{{@loop days as item}}<span>{{ item.day }}</span>{{@empty}}{{/loop}}</header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage("light");
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		const ready =
			canvas === "preview" ? page.waitForResponse((response) => response.url().includes("/builder/open")) : null;
		if (canvas === "live") {
			await page.goto(install.adminUrl(`/sites/${siteId}`));
			await page.getByRole("button", { name: "Edit on site" }).click();
			await page.waitForURL((url) => url.hostname.startsWith("branch-paste"));
			await page.getByRole("button", { name: "Code", exact: true }).click();
		} else {
			await page.goto(install.adminUrl(`/builder/${siteId}/site-template`));
			await ready;
		}
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.getByRole("treeitem", { name: /^Copy source/ }).click();
		await page.keyboard.press("ControlOrMeta+c");
		await tree.getByRole("treeitem", { name: "Else", exact: true }).click();
		await page.keyboard.press("ControlOrMeta+v");
		await tree
			.getByRole("treeitem", { name: /^Copy source/ })
			.nth(1)
			.waitFor();
		await tree.getByRole("treeitem", { name: "When there are no items", exact: true }).click();
		await page.keyboard.press("ControlOrMeta+v");
		await tree
			.getByRole("treeitem", { name: /^Copy source/ })
			.nth(2)
			.waitFor();
		for (let attempt = 0; attempt < 80; attempt++) {
			const text = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			if ((text.match(/Copied value/g) ?? []).length === 3) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft;
		expect(saved).toMatch(/\{\{@else\}\}\s*<p[^>]*>Copied value<\/p>\s*\{\{\/if\}\}/);
		expect(saved).toMatch(/\{\{@empty\}\}\s*<p[^>]*>Copied value<\/p>\s*\{\{\/loop\}\}/);
	});
}

test("the built-in Page template becomes a shared Draft on its first insertion", async () => {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("First template");
	const { id: siteId } = await local.createSite(workspace.id, { name: "First template", slug: "first-template" });
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith("first-template"));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	const tree = page.getByRole("tree", { name: "Layers" });
	await tree.getByText("Page template · Main", { exact: true }).waitFor();
	await tree.getByRole("treeitem", { name: /^main$/ }).click();
	await page.getByRole("button", { name: "Paragraph", exact: true }).click();
	await page.locator("main p", { hasText: "Paragraph" }).waitFor();
	expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain("Paragraph");
});
