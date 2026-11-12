import { afterEach, beforeEach, expect, test } from "bun:test";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

for (const theme of THEMES) {
	test(`one history in the Builder preserves peer work and uses Undo inside HTML, ${theme}`, async () => {
		const local = install.install;
		const workspace = await local.createWorkspace("History");
		const site = await local.createSite(workspace.id, { name: "History", slug: `history-${theme}` });
		const staff = await local.createStaff({ workspaces: [workspace.id] });
		const api = staff.browser.api;
		const { component } = await api.components.create({ siteId: site.id, name: "HistoryCard" });
		await api.components.saveMarkup({
			siteId: site.id,
			componentId: component.id,
			markup:
				'<section data-wc-id="box"><h2 data-wc-id="heading">Heading</h2><p data-wc-id="body">Original</p></section>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		try {
			await install.signIn(page, staff.account);
			await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
			const layers = page.getByRole("tree", { name: "Layers" });
			const paragraph = layers.getByRole("treeitem", { name: /^p\b/ });
			await page.frameLocator("iframe[title^='Canvas']").getByText("Original").waitFor();
			await paragraph.click();
			await page.keyboard.press("F2");
			await page.getByRole("textbox", { name: "Layer label of p" }).fill("Lead");
			await page.keyboard.press("Enter");
			await layers.getByRole("treeitem", { name: /^Lead/ }).waitFor();
			expect(await page.getByRole("button", { name: "Undo", exact: true }).getAttribute("title")).toBe(
				"Undo Rename Lead",
			);
			await page.getByRole("button", { name: "Save", exact: true }).first().click();
			await page.getByRole("status").filter({ hasText: "HistoryCard is saved to its Draft." }).first().waitFor();
			const current = await api.components.getMarkup({ siteId: site.id, componentId: component.id });
			await api.components.saveMarkup({
				siteId: site.id,
				componentId: component.id,
				markup: current.markup.draft.replace("Heading</h2>", "Peer heading</h2>"),
			});
			await page.frameLocator("iframe[title^='Canvas']").getByText("Peer heading").waitFor();
			const html = page.getByRole("textbox", { name: "Template markup" });
			await html.focus();
			await page.keyboard.press("ControlOrMeta+z");
			await paragraph.waitFor();
			expect(await html.evaluate((element) => element === document.activeElement)).toBe(true);
			await page.frameLocator("iframe[title^='Canvas']").getByText("Peer heading").waitFor();
			await page.keyboard.press("ControlOrMeta+Shift+z");
			await layers.getByRole("treeitem", { name: /^Lead/ }).waitFor();
			const original = await html.inputValue();
			await html.fill(`${original}<`);
			await page.keyboard.press("ControlOrMeta+z");
			expect(await html.inputValue()).toBe(original);
			await expectAccessibleScreen(page, `Undo history ${theme}`, { exclude: ["iframe[title^='Canvas']"] });
			await page.reload();
			await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
			expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
		} catch (error) {
			console.error(
				JSON.stringify({
					errors: pageErrors(page),
					tree: await page.getByRole("tree").textContent(),
					statuses: await page.getByRole("status").allTextContents(),
				}),
			);
			throw error;
		} finally {
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`Class creation, CSS and Component JS share chronological Undo after saving, ${theme}`, async () => {
		const local = install.install;
		const workspace = await local.createWorkspace("Code history");
		const site = await local.createSite(workspace.id, { name: "Code history", slug: `code-history-${theme}` });
		const staff = await local.createStaff({ workspaces: [workspace.id] });
		const api = staff.browser.api;
		const { component } = await api.components.create({ siteId: site.id, name: "CodeCard" });
		await api.components.saveMarkup({
			siteId: site.id,
			componentId: component.id,
			markup: '<p data-wc-id="body">Original</p>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		try {
			await install.signIn(page, staff.account);
			await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
			await page.frameLocator("iframe[title^='Canvas']").getByText("Original").waitFor();
			await page.getByRole("treeitem", { name: /^p\b/ }).click();
			const css = page.getByRole("region", { name: "CSS", exact: true });
			await css.getByRole("button", { name: "Give this element a Class" }).click();
			await css.getByRole("combobox", { name: "Class name" }).fill("my-class");
			await css.getByRole("combobox", { name: "Class name" }).press("Enter");
			await css.getByRole("tab", { name: ".my-class", selected: true }).waitFor();
			const text = css.getByRole("textbox", { name: "CSS: .my-class", exact: true });
			await text.fill("color: blue;");
			await text.press("ControlOrMeta+s");
			await css.getByRole("status").filter({ hasText: /saved/i }).waitFor();
			const jsRegion = page.getByRole("region", { name: "JS", exact: true });
			const js = jsRegion.getByRole("textbox");
			await js.fill("// own script");
			await js.press("ControlOrMeta+s");
			await jsRegion
				.getByRole("status")
				.filter({ hasText: /Saved to Draft/ })
				.waitFor();
			await js.press("ControlOrMeta+z");
			await page.waitForFunction(
				() => document.querySelector<HTMLTextAreaElement>('section[aria-label="JS"] textarea')?.value === "",
			);
			expect((await api.components.getScript({ siteId: site.id, componentId: component.id })).script?.draft.code).toBe(
				"",
			);
			await js.press("ControlOrMeta+z");
			await page.waitForFunction(
				() => document.querySelector<HTMLTextAreaElement>("[data-css-panel] textarea")?.value === "",
			);
			await js.press("ControlOrMeta+z");
			await css.getByRole("tab", { name: ".my-class" }).waitFor({ state: "hidden" });
			await page.getByRole("status").filter({ hasText: "Undid Create Class my-class" }).first().waitFor();
			expect(
				(await api.designSystem.get({ siteId: site.id })).designSystem.draft.classes.some(
					(each) => each.name === "my-class",
				),
			).toBe(false);
			await js.press("ControlOrMeta+Shift+z");
			await css.getByRole("tab", { name: ".my-class" }).waitFor();
		} catch (error) {
			console.error(
				JSON.stringify({ errors: pageErrors(page), statuses: await page.getByRole("status").allTextContents() }),
			);
			throw error;
		} finally {
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`history crosses Builder and Code mode, survives publish and clears on reload, ${theme}`, async () => {
		const local = install.install;
		const workspace = await local.createWorkspace("Navigation history");
		const site = await local.createSite(workspace.id, { name: "Navigation history", slug: `nav-history-${theme}` });
		const staff = await local.createStaff({ workspaces: [workspace.id] });
		const api = staff.browser.api;
		const { postType } = await api.postTypes.create({
			siteId: site.id,
			name: "Stories",
			urlPattern: "/stories/{slug}",
		});
		await api.entries.create({ siteId: site.id, postTypeId: postType.id, title: "First" });
		await api.templates.saveEntryTemplateMarkup({
			siteId: site.id,
			postTypeId: postType.id,
			markup: '<h1>{{ title }}</h1><p data-wc-id="lead">Before</p>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		try {
			await install.signIn(page, staff.account);
			page.on("pageerror", (error) => console.error(error.stack));
			await page.goto(install.adminUrl(`/builder/${site.id}/entry-template/${postType.id}`));
			await page.frameLocator("iframe[title^='Canvas']").getByText("Before").waitFor();
			const html = page.getByRole("textbox", { name: "Template markup", exact: true });
			await html.fill((await html.inputValue()).replace("Before</p>", "After</p>"));
			await page.getByRole("button", { name: "View on a page", exact: true }).click();
			await page.waitForURL((url) => url.pathname === "/stories/first");
			await page.getByRole("button", { name: "Undo", exact: true }).and(page.locator(":not([disabled])")).waitFor();
			await page.getByRole("button", { name: "Undo", exact: true }).click();
			await page.locator('p[data-wc-code="content#lead"]').filter({ hasText: "Before" }).waitFor();
			await page.getByRole("button", { name: "Redo", exact: true }).click();
			await page.locator('p[data-wc-code="content#lead"]').filter({ hasText: "After" }).waitFor();
			await page.getByRole("button", { name: "Open in builder", exact: true }).click();
			await page.waitForURL((url) => url.pathname.includes("/builder/"));
			await page.getByRole("button", { name: "Undo", exact: true }).and(page.locator(":not([disabled])")).waitFor();
			const template = (await api.templates.getEntryTemplate({ siteId: site.id, postTypeId: postType.id })).template;
			if (!template) throw new Error("Expected saved Template");
			await api.templates.publish({ siteId: site.id, templateId: template.id });
			await page.getByRole("button", { name: "Undo", exact: true }).click();
			await page.frameLocator("iframe[title^='Canvas']").getByText("Before").waitFor();
			const markup = await api.templates.getEntryTemplateMarkup({ siteId: site.id, postTypeId: postType.id });
			expect(markup.markup?.published).toContain("After");
			expect(markup.markup?.draft).toContain("Before");
			await page.reload();
			await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
			expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
		} catch (error) {
			console.error(
				JSON.stringify({
					errors: pageErrors(page),
					statuses: await page.getByRole("status").allTextContents(),
					url: page.url(),
					draft: await api.templates.getEntryTemplateMarkup({ siteId: site.id, postTypeId: postType.id }),
				}),
			);
			throw error;
		} finally {
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`first Template edit and one-off styles belong to the same history, ${theme}`, async () => {
		const workspace = await install.install.createWorkspace("New history");
		const site = await install.install.createSite(workspace.id, { name: "New history", slug: `new-history-${theme}` });
		const staff = await install.install.createStaff({ workspaces: [workspace.id] });
		const api = staff.browser.api;
		const { postType } = await api.postTypes.create({ siteId: site.id, name: "Notes", urlPattern: "/notes/{slug}" });
		const page = await install.newPage(theme);
		try {
			await install.signIn(page, staff.account);
			await page.goto(install.adminUrl(`/builder/${site.id}/entry-template/${postType.id}`));
			const html = page.getByRole("textbox", { name: "Template markup", exact: true });
			await html.fill('<p data-wc-id="lead">First</p>');
			await page.getByRole("button", { name: "Save", exact: true }).first().click();
			await page.frameLocator("iframe[title^='Canvas']").getByText("First").waitFor();
			await page.getByRole("treeitem", { name: /^p\b/ }).click();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			await page.getByRole("textbox", { name: "Declarations", exact: true }).fill("color: red;");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "One-off style applied." }).first().waitFor();
			await page.getByRole("textbox", { name: "Declarations", exact: true }).fill("color: blue;");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await page.getByRole("button", { name: "Apply", exact: true }).and(page.locator(":not([disabled])")).waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).first().click();
			await page
				.locator("header")
				.getByRole("button", { name: "Save", exact: true })
				.and(page.locator("[disabled]"))
				.waitFor();
			await page.frameLocator("iframe[title^='Canvas']").locator('p[class^="style-"]').waitFor();
			await page.getByRole("tab", { name: "Settings", exact: true }).click();
			await html.focus();
			await page.keyboard.press("ControlOrMeta+z");
			await page.getByRole("status").filter({ hasText: "Undid Edit one-off style" }).first().waitFor();
			await page.getByRole("tab", { name: "Style", exact: true, selected: true }).waitFor();
			expect(await html.evaluate((element) => element === document.activeElement)).toBe(true);
			await page.waitForFunction(() => {
				const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
				const node = frame?.contentDocument?.querySelector("p");
				return node && frame?.contentWindow?.getComputedStyle(node).color === "rgb(255, 0, 0)";
			});
			await page.keyboard.press("ControlOrMeta+z");
			await page.frameLocator("iframe[title^='Canvas']").locator("p:not([class])").waitFor();
			await page.keyboard.press("ControlOrMeta+z");
			await page.getByRole("treeitem", { name: /^p\b/ }).waitFor({ state: "hidden" });
			const read = await api.templates.getEntryTemplateMarkup({ siteId: site.id, postTypeId: postType.id });
			expect(read.markup?.draft).not.toContain("First");
		} finally {
			await page.close();
		}
	});
}

test("typing bursts end on blur and retain only the last 200 steps", async () => {
	const workspace = await install.install.createWorkspace("Bounded history");
	const site = await install.install.createSite(workspace.id, { name: "Bounded history", slug: "bounded-history" });
	const staff = await install.install.createStaff({ workspaces: [workspace.id] });
	const { component } = await staff.browser.api.components.create({ siteId: site.id, name: "BoundedHistory" });
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	try {
		await install.signIn(page, staff.account);
		await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
		const html = page.getByRole("textbox", { name: "Template markup", exact: true });
		await html.waitFor();
		for (let step = 1; step <= 201; step++) {
			await html.fill(`<!-- unfinished ${step}`);
			await html.blur();
		}
		await html.focus();
		for (let step = 200; step >= 1; step--) {
			await page.keyboard.press("ControlOrMeta+z");
			await page.waitForFunction(
				(value) => document.querySelector<HTMLTextAreaElement>('section[aria-label="HTML"] textarea')?.value === value,
				`<!-- unfinished ${step}`,
			);
		}
		expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('section[aria-label="HTML"] textarea')?.value ===
				"<!-- unfinished 2",
		);
		await html.fill("<!-- new branch");
		expect(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled()).toBe(true);
		await html.press("End");
		await page.keyboard.type(" together");
		await page.keyboard.press("ControlOrMeta+z");
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('section[aria-label="HTML"] textarea')?.value ===
				"<!-- unfinished 2",
		);
	} finally {
		await page.close();
	}
});

test("an obsolete own step is explained and skipped while Undo keeps the peer label", async () => {
	const workspace = await install.install.createWorkspace("Skipped history");
	const site = await install.install.createSite(workspace.id, { name: "Skipped history", slug: "skipped-history" });
	const staff = await install.install.createStaff({ workspaces: [workspace.id] });
	const api = staff.browser.api;
	const { component } = await api.components.create({ siteId: site.id, name: "SkippedHistory" });
	await api.components.saveMarkup({
		siteId: site.id,
		componentId: component.id,
		markup: '<p data-wc-id="lead">Before</p>',
	});
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	try {
		await install.signIn(page, staff.account);
		await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("Before").waitFor();
		const html = page.getByRole("textbox", { name: "Template markup", exact: true });
		await html.fill((await html.inputValue()).replace("Before</p>", "Early</p>"));
		await page.getByRole("button", { name: "Save", exact: true }).first().click();
		await page.frameLocator("iframe[title^='Canvas']").getByText("Early").waitFor();
		await page.getByRole("treeitem", { name: /^p\b/ }).click();
		await page.keyboard.press("F2");
		await page.getByRole("textbox", { name: "Layer label of p" }).fill("Mine");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "Save", exact: true }).first().click();
		await page.getByRole("status").filter({ hasText: "SkippedHistory is saved to its Draft." }).first().waitFor();
		const fresh = await api.components.getMarkup({ siteId: site.id, componentId: component.id });
		await api.components.saveMarkup({
			siteId: site.id,
			componentId: component.id,
			markup: fresh.markup.draft.replace("Mine", "Peer"),
		});
		await page.getByRole("treeitem", { name: /^Peer/ }).waitFor();
		await html.focus();
		await page.keyboard.press("ControlOrMeta+z");
		await page.frameLocator("iframe[title^='Canvas']").getByText("Before").waitFor();
		await page
			.getByRole("status")
			.filter({ hasText: /Skipped Rename Mine.*newer change.*Undid Edit HTML/ })
			.waitFor();
		expect(await page.getByRole("treeitem", { name: /^Peer/ }).count()).toBe(1);
		expect(await html.evaluate((el) => document.activeElement === el)).toBe(true);
	} finally {
		await page.close();
	}
});

for (const theme of THEMES) {
	test(`Code mode JS uses the tab history without running scripts, ${theme}`, async () => {
		const workspace = await install.install.createWorkspace("Script history");
		const site = await install.install.createSite(workspace.id, {
			name: "Script history",
			slug: `script-history-${theme}`,
		});
		const staff = await install.install.createStaff({ workspaces: [workspace.id] });
		const api = staff.browser.api;
		const { postType } = await api.postTypes.create({ siteId: site.id, name: "Posts", urlPattern: "/posts/{slug}" });
		await api.entries.create({ siteId: site.id, postTypeId: postType.id, title: "First" });
		await api.templates.saveEntryTemplateMarkup({
			siteId: site.id,
			postTypeId: postType.id,
			markup: '<h1>{{ title }}</h1><p data-wc-id="lead">Before</p>',
		});
		const page = await install.newPage(theme);
		const scriptResponses: string[] = [];
		page.on("response", (res) => {
			if (res.url().includes("/code/")) scriptResponses.push(`${res.status()} ${new URL(res.url()).pathname}`);
		});
		page.setDefaultTimeout(10000);
		try {
			await install.signIn(page, staff.account);
			page.on("pageerror", (error) => console.error(error.stack));
			await page.goto(install.adminUrl(`/builder/${site.id}/entry-template/${postType.id}`));
			await page.frameLocator("iframe[title^='Canvas']").getByText("Before").waitFor();
			await page.getByRole("button", { name: "View on a page", exact: true }).click();
			await page.waitForURL((url) => url.pathname === "/posts/first");
			const html = page.getByRole("textbox", { name: /^HTML of/ });
			await html.and(page.locator(":not([readonly])")).waitFor();
			await html.fill((await html.inputValue()).replace("Before</p>", "After</p>"));
			await page.locator('p[data-wc-code="content#lead"]').filter({ hasText: "After" }).waitFor();
			const js = page.getByRole("textbox", { name: /^JS:/ });
			await js.fill('document.body.dataset.historyRan = "yes";');
			await js.press("ControlOrMeta+s");
			await page
				.getByText(/Saved to Draft/)
				.first()
				.waitFor();
			await js.press("ControlOrMeta+z");
			await page.getByRole("button", { name: "Redo", exact: true }).and(page.locator(":not([disabled])")).waitFor();
			expect(await js.inputValue()).toBe("");
			await js.press("ControlOrMeta+z");
			await page.locator('p[data-wc-code="content#lead"]').filter({ hasText: "Before" }).waitFor();
			expect(
				await js.evaluate(
					(el) => el.getRootNode() instanceof ShadowRoot && (el.getRootNode() as ShadowRoot).activeElement === el,
				),
			).toBe(true);
			expect(await page.locator("body").getAttribute("data-history-ran")).toBe(null);
			await expectAccessibleScreen(page, `Code history ${theme}`);
		} catch (error) {
			console.error({
				scriptResponses,
				statusText: await page.locator(".status-text").allTextContents(),
				statuses: await page.getByRole("status").allTextContents(),
				errors: pageErrors(page),
				text: await page.getByRole("textbox", { name: /^JS:/ }).inputValue(),
			});
			throw error;
		} finally {
			await page.close();
		}
	});
}

test("page navigation keeps earlier Draft steps and announces their canvas without changing this page", async () => {
	const workspace = await install.install.createWorkspace("Page history");
	const site = await install.install.createSite(workspace.id, { name: "Page history", slug: "page-history" });
	const staff = await install.install.createStaff({ workspaces: [workspace.id] });
	const api = staff.browser.api;
	const first = await api.postTypes.create({ siteId: site.id, name: "First type", urlPattern: "/first/{slug}" });
	const second = await api.postTypes.create({ siteId: site.id, name: "Second type", urlPattern: "/second/{slug}" });
	for (const [postTypeId, title] of [
		[first.postType.id, "First"],
		[second.postType.id, "Second"],
	]) {
		const made = await api.entries.create({
			siteId: site.id,
			postTypeId: postTypeId as string,
			title: title as string,
		});
		await api.entries.publish({ siteId: site.id, entryId: made.entry.id });
		const saved = await api.templates.saveEntryTemplateMarkup({
			siteId: site.id,
			postTypeId: postTypeId as string,
			markup: `<h1>{{ title }}</h1><p data-wc-id="lead">${title} original</p>`,
		});
		await api.templates.publish({ siteId: site.id, templateId: saved.template.id });
	}
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	try {
		await install.signIn(page, staff.account);
		await page.goto(install.adminUrl(`/builder/${site.id}/entry-template/${first.postType.id}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("First original").waitFor();
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/first/first");
		const html = page.getByRole("textbox", { name: /^HTML of/ });
		await html.and(page.locator(":not([readonly])")).waitFor();
		await html.fill((await html.inputValue()).replace("First original", "My first change"));
		await page.locator('p[data-wc-code="content#lead"]').filter({ hasText: "My first change" }).waitFor();
		await page.getByRole("button", { name: /^Page:.*Switch page/ }).click();
		await page.getByRole("menuitem", { name: /^Second/ }).click();
		await page.waitForURL((url) => url.pathname === "/second/second");
		await page.getByRole("button", { name: "Undo", exact: true }).and(page.locator(":not([disabled])")).waitFor();
		await page.getByRole("textbox", { name: /^JS:/ }).focus();
		await page.keyboard.press("ControlOrMeta+z");
		await page
			.getByRole("status")
			.filter({ hasText: /Undid Edit HTML.* on First/ })
			.waitFor();
		expect(await page.locator('p[data-wc-code="content#lead"]').textContent()).toBe("Second original");
		expect(
			(await api.templates.getEntryTemplateMarkup({ siteId: site.id, postTypeId: first.postType.id })).markup?.draft,
		).toContain("First original");
	} finally {
		await page.close();
	}
});

test("typing during Class creation remains a separate finished step", async () => {
	const local = install.install;
	const workspace = await local.createWorkspace("Compound history");
	const site = await local.createSite(workspace.id, { name: "Compound history", slug: "compound-history" });
	const staff = await local.createStaff({ workspaces: [workspace.id] });
	const api = staff.browser.api;
	const { component } = await api.components.create({ siteId: site.id, name: "CompoundCard" });
	await api.components.saveMarkup({
		siteId: site.id,
		componentId: component.id,
		markup: '<p data-wc-id="body">Original</p>',
	});
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		await install.signIn(page, staff.account);
		await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("Original").waitFor();
		await page.getByRole("treeitem", { name: /^p\b/ }).click();
		await page.route("**/api/rpc/designSystem/createClass", async (route) => {
			const response = await route.fetch();
			held.resolve();
			await release.promise;
			await route.fulfill({ response });
		});
		const css = page.getByRole("region", { name: "CSS", exact: true });
		await css.getByRole("button", { name: "Give this element a Class" }).click();
		await css.getByRole("combobox", { name: "Class name" }).fill("slow-class");
		await css.getByRole("combobox", { name: "Class name" }).press("Enter");
		await held.promise;
		const js = page.getByRole("region", { name: "JS", exact: true }).getByRole("textbox");
		await js.fill("// a separate edit");
		release.resolve();
		await css.getByRole("tab", { name: ".slow-class", selected: true }).waitFor();
		await js.press("ControlOrMeta+z");
		await page.getByRole("status").filter({ hasText: "Undid Create Class slow-class" }).first().waitFor();
		await css.getByRole("tab", { name: ".slow-class" }).waitFor({ state: "detached" });
		expect(await js.inputValue()).toBe("// a separate edit");
		await js.press("ControlOrMeta+z");
		await page.waitForFunction(
			() => document.querySelector<HTMLTextAreaElement>('section[aria-label="JS"] textarea')?.value === "",
		);
	} finally {
		release.resolve();
		await page.close();
	}
});

test("saving keeps separate inline-style typing groups in HTML", async () => {
	const local = install.install;
	const workspace = await local.createWorkspace("Inline history");
	const site = await local.createSite(workspace.id, { name: "Inline history", slug: "inline-history" });
	const staff = await local.createStaff({ workspaces: [workspace.id] });
	const api = staff.browser.api;
	const { component } = await api.components.create({ siteId: site.id, name: "InlineCard" });
	await api.components.saveMarkup({
		siteId: site.id,
		componentId: component.id,
		markup: '<p data-wc-id="body">Original</p>',
	});
	const page = await install.newPage("light");
	page.setDefaultTimeout(10000);
	const colour = (expected: string) =>
		page.waitForFunction((expected) => {
			const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
			const node = frame?.contentDocument?.querySelector("p");
			return node && frame?.contentWindow?.getComputedStyle(node).color === expected;
		}, expected);
	try {
		await install.signIn(page, staff.account);
		await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("Original").waitFor();
		const html = page.getByRole("textbox", { name: "Template markup", exact: true });
		await html.fill('<p data-wc-id="body" style="color: red;">Original</p>');
		await colour("rgb(255, 0, 0)");
		await html.blur();
		await html.fill('<p data-wc-id="body" style="color: blue;">Original</p>');
		await colour("rgb(0, 0, 255)");
		await html.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();
		await html.press("ControlOrMeta+z");
		await colour("rgb(255, 0, 0)");
		await html.press("ControlOrMeta+z");
		await page.frameLocator("iframe[title^='Canvas']").locator("p:not([class])").waitFor();
		expect((await api.components.getMarkup({ siteId: site.id, componentId: component.id })).markup.draft).not.toContain(
			"style-",
		);
	} catch (failure) {
		console.error(
			JSON.stringify({
				html: await page.getByRole("textbox", { name: "Template markup", exact: true }).inputValue(),
				statuses: await page.getByRole("status").allTextContents(),
				errors: pageErrors(page),
			}),
		);
		throw failure;
	} finally {
		await page.close();
	}
});
