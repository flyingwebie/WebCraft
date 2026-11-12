import { afterEach, beforeEach, expect, test } from "bun:test";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

async function editorPage(theme: (typeof THEMES)[number], canvas: "live" | "preview", initialStyle?: string) {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("Style co-editing");
	const { id: siteId } = await local.createSite(workspace.id, {
		name: "Style co-editing",
		slug: "style-co-editing",
	});
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const original =
		'<header data-wc-id="header"><p data-wc-id="greeting" data-wc-label="Before">Original text</p></header><main>{{@outlet}}</main>'.replace(
			"<p ",
			initialStyle ? `<p style="${initialStyle}" ` : "<p ",
		);
	await api.templates.saveSiteTemplateMarkup({ siteId, markup: original });
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	if (canvas === "preview") await page.goto(install.adminUrl(`/builder/${siteId}/site-template`));
	else {
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith("style-co-editing"));
		await page.getByRole("button", { name: "Code", exact: true }).click();
	}
	const tree = page.getByRole("tree", { name: "Layers" });
	return { api, siteId, original, page, tree };
}

async function styledEditorPage(theme: (typeof THEMES)[number]) {
	const editor = await editorPage(theme, "live");
	const { api, siteId, original, page, tree } = editor;
	const earlier = await api.designSystem.createClass({ siteId, name: "earlier-style", styles: "color: red;" });
	await api.designSystem.createClass({ siteId, name: "current-style", styles: "color: blue;" });
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: original
			.replace("<p ", '<p class="earlier-style" ')
			.replace("</p>", '</p><p class="current-style" data-wc-id="current" data-wc-label="Current">Current</p>'),
	});
	await tree.getByRole("treeitem", { name: /^Current p$/ }).waitFor();
	await tree.getByRole("treeitem", { name: /^Before p$/ }).click();
	await page.getByRole("textbox", { name: "CSS: .earlier-style", exact: true }).waitFor();
	await page.waitForLoadState("networkidle");
	return { ...editor, earlierId: earlier.class.id };
}

for (const theme of THEMES) {
	test(`a delayed CSS read keeps the current live Layers selection (${theme})`, async () => {
		const { page, tree, earlierId } = await styledEditorPage(theme);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		await page.route("**/_webcraft/edit/api/code/css", async (route) => {
			// The shared CSS panel reads by the Classes the selected element has now.
			const earlier = (route.request().postDataJSON().classes ?? []).includes(earlierId);
			const response = await route.fetch();
			if (earlier) {
				held.resolve();
				await release.promise;
			}
			await route.fulfill({ response });
			if (earlier) delivered.resolve();
		});
		try {
			// Away and back, so selecting Before reads its Classes again.
			await tree.getByRole("treeitem", { name: /^Current p$/ }).click();
			await page.getByRole("textbox", { name: "CSS: .current-style", exact: true }).waitFor();
			await tree.getByRole("treeitem", { name: /^Before p$/ }).click();
			await held.promise;
			const current = tree.getByRole("treeitem", { name: /^Current p$/ });
			await current.click();
			await page.getByRole("textbox", { name: "CSS: .current-style", exact: true }).waitFor();
			await page.locator(".language-markup .line.marked").filter({ hasText: 'data-wc-id="current"' }).waitFor();
			expect(await page.getByLabel("Layer label", { exact: true }).inputValue()).toBe("Current");
			release.resolve();
			await delivered.promise;
			await page.waitForLoadState("networkidle");
			expect(await current.getAttribute("aria-selected")).toBe("true");
			const css = page.getByRole("textbox", { name: /^CSS: / });
			expect(await css.getAttribute("aria-label")).toBe("CSS: .current-style");
			expect(await css.inputValue()).toBe("color: blue;");
		} finally {
			release.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
	});

	test(`typing during a CSS read preserves the unfinished declarations (${theme})`, async () => {
		const { api, siteId, page, tree, earlierId } = await styledEditorPage(theme);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		let hold = true;
		await page.route("**/_webcraft/edit/api/code/css", async (route) => {
			if (!hold || !(route.request().postDataJSON().classes ?? []).includes(earlierId)) return route.continue();
			hold = false;
			const response = await route.fetch();
			held.resolve();
			await release.promise;
			await route.fulfill({ response });
			delivered.resolve();
		});
		try {
			// Away and back, so selecting Before reads its Classes again.
			await tree.getByRole("treeitem", { name: /^Current p$/ }).click();
			await page.getByRole("textbox", { name: "CSS: .current-style", exact: true }).waitFor();
			await tree.getByRole("treeitem", { name: /^Before p$/ }).click();
			await held.promise;
			const css = page.getByRole("textbox", { name: "CSS: .earlier-style", exact: true });
			await css.fill("color: purple;");
			release.resolve();
			await delivered.promise;
			await page.waitForLoadState("networkidle");
			expect(await css.inputValue()).toBe("color: purple;");
			const { designSystem } = await api.designSystem.get({ siteId });
			expect(designSystem.draft.classes.find((each) => each.name === "earlier-style")?.styles).toBe("color: red;");
		} finally {
			release.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
	});

	test(`live layer moves announce pickup, refusals and their new position (${theme})`, async () => {
		const { api, siteId, original, page, tree } = await editorPage(theme, "live");
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: original.replace("</p>", '</p><section data-wc-id="group" data-wc-label="Group">Group text</section>'),
		});
		const group = tree.getByRole("treeitem", { name: /^Group section/ });
		await group.click();
		await page.waitForLoadState("networkidle");
		await group.press("Space");
		await page.getByRole("status").filter({ hasText: "Picked up Group." }).waitFor();
		await group.press("ArrowRight");
		await page
			.getByRole("status")
			.filter({ hasText: "<section> can't go inside <p>: a browser would end the paragraph before it." })
			.waitFor();
		expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain("</p><section");
		await group.press("ArrowUp");
		await page.getByRole("status").filter({ hasText: "Moved Group: 1 of 2 in header." }).waitFor();
		await group.press("Space");
		await page.getByRole("status").filter({ hasText: "Put down Group: 1 of 2 in header." }).waitFor();
		await group.press("Space");
		await group.press("ArrowDown");
		await group.press("Escape");
		await page.getByRole("status").filter({ hasText: "Put Group back where it was." }).waitFor();
		expect(await group.getAttribute("aria-selected")).toBe("true");
	});

	for (const canvas of ["preview", "live"] as const) {
		test(`the ${canvas} Inspector edits current Props while preserving retained values (${theme})`, async () => {
			const local = install.install;
			const { api } = await local.superadmin();
			const workspace = await local.createWorkspace("Retained Props editor");
			const { id: siteId } = await local.createSite(workspace.id, {
				name: "Retained Props editor",
				slug: "retained-props-editor",
			});
			const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
			const { component } = await api.components.create({
				siteId,
				name: "Notice",
				props: [
					{ key: "value", label: "Value", type: "text" },
					{ key: "other", label: "Other", type: "text" },
				],
			});
			const target = { siteId, componentId: component.id };
			const original = await api.components.saveMarkup({ ...target, markup: "<p>{{ props.value }}</p>" });
			await api.components.publish(target);
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup:
					'<header><Notice data-wc-id="notice" value="Old text" other="Before" /></header><main>{{@outlet}}</main>',
			});
			await api.components.saveDraft({
				...target,
				props: original.component.draft.props.map((prop) =>
					prop.key === "value" ? { id: prop.id, key: prop.key, label: prop.label, type: "number" as const } : prop,
				),
			});
			const page = await install.newPage(theme);
			page.setDefaultTimeout(10000);
			await install.signIn(page, staff);
			if (canvas === "preview") await page.goto(install.adminUrl(`/builder/${siteId}/site-template`));
			else {
				await page.goto(install.adminUrl(`/sites/${siteId}`));
				await page.getByRole("button", { name: "Edit on site" }).click();
				await page.waitForURL((url) => url.hostname.startsWith("retained-props-editor"));
				await page.getByRole("button", { name: "Code", exact: true }).click();
			}
			await page.waitForLoadState("networkidle");
			await page
				.getByRole("tree", { name: "Layers" })
				.getByRole("treeitem", { name: /^Notice/ })
				.click();
			const value = page.getByRole("textbox", { name: "Value", exact: true });
			expect(await value.inputValue()).toBe("");
			await page.getByRole("textbox", { name: "Other", exact: true }).fill("After");
			await page.getByRole("textbox", { name: "Other", exact: true }).press("Enter");
			await value.fill("42");
			await value.press("Enter");
			let stored = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (stored.includes('value="42"') && stored.includes('other="After"')) break;
				await page.waitForTimeout(50);
			}
			expect(stored).toContain('value="42"');
			expect(stored).toContain('other="After"');
			expect(stored).toContain("data-wc-retained");
			expect(stored).toContain("Old text");
			await api.components.saveMarkup({ ...target, markup: original.markup });
			const restored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			expect(restored).toContain('value="Old text"');
			expect(restored).toContain('other="After"');
		});

		test(`a delayed Class refresh preserves newer declarations on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			const peer = await api.designSystem.createClass({ siteId, name: "peer-class", styles: "color: red;" });
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original.replace("<p ", '<p class="peer-class" '),
			});
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			await page.getByRole("tab", { name: ".peer-class", exact: true }).click();
			await page.waitForLoadState("networkidle");
			const captured = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const delivered = Promise.withResolvers<void>();
			const releaseFresh = Promise.withResolvers<void>();
			let holdFresh = false;
			await page.route(/\/(builder\/open|code\/editor)$/, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				const classes = (canvas === "preview" ? body.json.catalogue.classes : body.opened.catalogue.classes) as {
					id: string;
					styles: string;
				}[];
				const old = classes.some((each) => each.id === peer.class.id && each.styles === "color: blue;");
				if (old) {
					captured.resolve();
					await release.promise;
				} else if (holdFresh) await releaseFresh.promise;
				await route.fulfill({ response });
				if (old) delivered.resolve();
			});
			try {
				await api.designSystem.updateClass({ siteId, classId: peer.class.id, styles: "color: blue;" });
				await captured.promise;
				await api.designSystem.updateClass({ siteId, classId: peer.class.id, styles: "color: purple;" });
				const value = page.getByRole("textbox", { name: "CSS: .peer-class", exact: true });
				for (let attempt = 0; attempt < 100 && !(await value.inputValue()).includes("purple"); attempt++)
					await page.waitForTimeout(50);
				expect(await value.inputValue()).toContain("purple");
				holdFresh = true;
				release.resolve();
				await delivered.promise;
				await page.waitForTimeout(300);
				expect(await value.inputValue()).toContain("purple");
			} finally {
				release.resolve();
				releaseFresh.resolve();
			}
		});

		test(`a delayed Class save preserves peer declarations on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			await api.designSystem.createClass({ siteId, name: "local-class", styles: "color: red;" });
			const peer = await api.designSystem.createClass({ siteId, name: "peer-class", styles: "color: blue;" });
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original.replace("<p ", '<p class="local-class peer-class" '),
			});
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			await page.getByRole("tab", { name: ".local-class", exact: true }).click();
			await page.getByRole("textbox", { name: "CSS: .local-class", exact: true }).fill("color: green;");
			const captured = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const delivered = Promise.withResolvers<void>();
			await page.route(/\/(builder\/saveCss|code\/saveCss)$/, async (route) => {
				const response = await route.fetch();
				captured.resolve();
				await release.promise;
				await route.fulfill({ response });
				delivered.resolve();
			});
			try {
				await page
					.getByRole("region", { name: "CSS", exact: true })
					.getByRole("button", { name: "Save", exact: true })
					.click();
				await captured.promise;
				await api.designSystem.updateClass({ siteId, classId: peer.class.id, styles: "color: purple;" });
				await page.getByRole("tab", { name: ".peer-class", exact: true }).click();
				const value = page.getByRole("textbox", { name: "CSS: .peer-class", exact: true });
				for (let attempt = 0; attempt < 100 && !(await value.inputValue()).includes("purple"); attempt++)
					await page.waitForTimeout(50);
				expect(await value.inputValue()).toContain("purple");
				release.resolve();
				await delivered.promise;
				await page.waitForLoadState("networkidle");
				expect(await value.inputValue()).toContain("purple");
			} finally {
				release.resolve();
			}
		});

		test(`creating a Class preserves peer Classes and labels on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			await api.designSystem.createClass({ siteId, name: "peer-class", styles: "font-weight: 600;" });
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			await page.getByRole("button", { name: "Give this element a Class", exact: true }).click();
			await page.getByRole("combobox", { name: "Class name" }).fill("local-class");
			await page.waitForLoadState("networkidle");
			const captured = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await page.route(/\/(designSystem\/createClass|code\/createClass)$/, async (route) => {
				const response = await route.fetch();
				captured.resolve();
				await release.promise;
				await route.fulfill({ response });
			});
			try {
				await page.getByRole("button", { name: "Add", exact: true }).click();
				await captured.promise;
				await api.templates.saveSiteTemplateMarkup({
					siteId,
					markup: original
						.replace('data-wc-id="header"', 'data-wc-id="header" data-wc-label="Peer header"')
						.replace("<p ", '<p class="peer-class" '),
				});
				await tree.getByRole("treeitem", { name: /^Peer header/ }).waitFor();
				release.resolve();
				let stored = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
					if (stored.includes("local-class")) break;
					await page.waitForTimeout(50);
				}
				expect(stored).toContain("local-class");
				expect(stored).toContain("peer-class");
				expect(stored).toContain('data-wc-label="Peer header"');
			} finally {
				release.resolve();
			}
		});

		test(`fixed-text conversion preserves text changed by a peer on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			await tree.getByRole("treeitem", { name: /^“Original text”/ }).click();
			await page.getByRole("button", { name: "Make it a Global", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Make it a Global" });
			await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Welcome");
			const captured = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await page.route(/\/(globals\/setFields|code\/editorService)$/, async (route) => {
				if (canvas === "live" && route.request().postDataJSON().method !== "globals.setFields") return route.continue();
				const response = await route.fetch();
				captured.resolve();
				await release.promise;
				await route.fulfill({ response });
			});
			try {
				await dialog.getByRole("button", { name: "Make it a Global", exact: true }).click();
				await captured.promise;
				await api.templates.saveSiteTemplateMarkup({ siteId, markup: original.replace("Original text", "Peer text") });
				await page.getByRole("treeitem", { name: /^“Peer text”/, includeHidden: true }).waitFor();
				release.resolve();
				await dialog
					.getByText("The selected text changed. Select it again to make it editable.", { exact: true })
					.waitFor();
				const stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				expect(stored).toContain("Peer text");
				expect(stored).not.toContain("{{ site.welcome }}");
			} finally {
				release.resolve();
			}
		});

		test(`fixed-text conversion follows its element and preserves peer edits on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			await tree.getByRole("treeitem", { name: /^“Original text”/ }).click();
			await page.getByRole("button", { name: "Make it a Global", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Make it a Global" });
			await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Welcome");
			const captured = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await page.route(/\/(globals\/setFields|code\/editorService)$/, async (route) => {
				if (canvas === "live" && route.request().postDataJSON().method !== "globals.setFields") return route.continue();
				const response = await route.fetch();
				captured.resolve();
				await release.promise;
				await route.fulfill({ response });
			});
			try {
				await dialog.getByRole("button", { name: "Make it a Global", exact: true }).click();
				await captured.promise;
				await api.templates.saveSiteTemplateMarkup({
					siteId,
					markup: original
						.replace('data-wc-id="header"', 'data-wc-id="header" data-wc-label="Peer header"')
						.replace("<p ", '<section data-wc-id="peer-group"><p ')
						.replace("</p>", "</p></section>"),
				});
				await page.getByRole("treeitem", { name: /^Peer header/, includeHidden: true }).waitFor();
				release.resolve();
				await dialog.waitFor({ state: "hidden" });
				let stored = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
					if (stored.includes("{{ site.welcome }}")) break;
					await page.waitForTimeout(50);
				}
				expect(stored).toContain("{{ site.welcome }}");
				expect(stored).toContain('data-wc-label="Peer header"');
				expect(stored).toContain(
					'<section data-wc-id="peer-group"><p data-wc-label="Before" data-wc-id="greeting">{{ site.welcome }}</p></section>',
				);
			} finally {
				release.resolve();
			}
		});
	}

	test(`cancelling a live keyboard move keeps the moved layer selected (${theme})`, async () => {
		const { api, siteId, original, page, tree } = await editorPage(theme, "live");
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: original
				.replace('data-wc-label="Before"', 'data-wc-label="First"')
				.replace("</p>", '</p><p data-wc-id="second" data-wc-label="Second">Second text</p>'),
		});
		const first = tree.getByRole("treeitem", { name: /^First/ });
		await first.click();
		await page.waitForLoadState("networkidle");
		await first.press("Space");
		await first.press("ArrowDown");
		let stored = "";
		for (let attempt = 0; attempt < 100; attempt++) {
			stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			if (stored.indexOf('data-wc-id="second"') < stored.indexOf('data-wc-id="greeting"')) break;
			await page.waitForTimeout(50);
		}
		expect(stored.indexOf('data-wc-id="second"')).toBeLessThan(stored.indexOf('data-wc-id="greeting"'));
		expect(await first.getAttribute("data-grabbed")).toBe("true");
		await first.press("Escape");
		for (let attempt = 0; attempt < 100; attempt++) {
			stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			if (stored.indexOf('data-wc-id="greeting"') < stored.indexOf('data-wc-id="second"')) break;
			await page.waitForTimeout(50);
		}
		expect(stored.indexOf('data-wc-id="greeting"')).toBeLessThan(stored.indexOf('data-wc-id="second"'));
		expect(await first.getAttribute("aria-selected")).toBe("true");
		expect(await first.getAttribute("data-grabbed")).not.toBe("true");
		expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
		await first.press("Space");
		await first.press("ArrowDown");
		await first.press("ControlOrMeta+z");
		await page.getByRole("status").filter({ hasText: "Undid Move First" }).first().waitFor();
		const interrupted = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
		expect(interrupted.indexOf('data-wc-id="greeting"')).toBeLessThan(interrupted.indexOf('data-wc-id="second"'));
		expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
		await first.press("Space");
		await first.press("ArrowDown");
		await first.press("ArrowUp");
		await first.press("ArrowDown");
		await first.press("Space");
		await page.getByRole("button", { name: "Undo", exact: true }).click();
		await page.getByRole("status").filter({ hasText: "Undid Move First" }).first().waitFor();
		const undone = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
		expect(undone.indexOf('data-wc-id="greeting"')).toBeLessThan(undone.indexOf('data-wc-id="second"'));
		expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
	});

	for (const canvas of ["preview", "live"] as const) {
		test(`peer changes invalidate keyboard move cancellation on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original
					.replace('data-wc-id="header"', 'data-wc-id="header" data-wc-label="Before header"')
					.replace('data-wc-label="Before"', 'data-wc-label="First"')
					.replace("</p>", '</p><p data-wc-id="second" data-wc-label="Second">Second text</p>'),
			});
			const first = tree.getByRole("treeitem", { name: /^First/ });
			await first.click();
			await page.waitForLoadState("networkidle");
			await first.press("Space");
			expect(await first.getAttribute("data-grabbed")).toBe("true");
			await first.press("ArrowDown");
			let moved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				moved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (moved.indexOf('data-wc-id="second"') < moved.indexOf('data-wc-id="greeting"')) break;
				await page.waitForTimeout(50);
			}
			expect(moved.indexOf('data-wc-id="second"')).toBeLessThan(moved.indexOf('data-wc-id="greeting"'));
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: moved.replace('data-wc-label="Before header"', 'data-wc-label="Peer header"'),
			});
			await tree.getByRole("treeitem", { name: /^Peer header/ }).waitFor();
			if (canvas === "live")
				await page.getByRole("status").filter({ hasText: "This move can no longer be cancelled" }).waitFor();
			await first.press("Escape");
			await tree.getByRole("treeitem", { name: /^Peer header/ }).waitFor();
			await page.waitForLoadState("networkidle");
			const stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			expect(stored).toContain('data-wc-label="Peer header"');
			expect(stored.indexOf('data-wc-id="second"')).toBeLessThan(stored.indexOf('data-wc-id="greeting"'));
			expect(await first.getAttribute("data-grabbed")).not.toBe("true");
			await page.getByRole("button", { name: "Undo", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "Undid Move First" }).first().waitFor();
			const undone = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			expect(undone).toContain('data-wc-label="Peer header"');
			expect(undone.indexOf('data-wc-id="greeting"')).toBeLessThan(undone.indexOf('data-wc-id="second"'));
		});
	}

	test(`clearing a one-off style follows peer changes during its catalogue read (${theme})`, async () => {
		const { api, siteId, original, page, tree } = await editorPage(theme, "preview", "color: rgb(1, 2, 3);");
		await tree.getByRole("treeitem", { name: /^Before/ }).click();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		const declarations = page.getByLabel("Declarations", { exact: true });
		await page.waitForLoadState("networkidle");
		const reading = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		await page.route(/\/api\/rpc\/builder\/open$/, async (route) => {
			if (held) return route.continue();
			held = true;
			const response = await route.fetch();
			reading.resolve();
			await release.promise;
			await route.fulfill({ response });
		});
		try {
			await declarations.fill("");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await reading.promise;
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original
					.replace("<p ", '<section data-wc-id="group"><p ')
					.replace("</p>", "</p></section>")
					.replace('data-wc-label="Before"', 'data-wc-label="Remote"')
					.replace("rgb(1, 2, 3)", "rgb(4, 5, 6)"),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			release.resolve();
			await page.getByRole("status").filter({ hasText: "One-off style removed." }).waitFor();
			let stored = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (!stored.includes('class="')) break;
				await page.waitForTimeout(50);
			}
			expect(stored).not.toContain('class="');
			expect(stored).toContain('<section data-wc-id="group"><p data-wc-label="Remote"');
		} finally {
			release.resolve();
		}
	});

	test(`one-off styles can be cleared before their catalogue arrives (${theme})`, async () => {
		const { api, siteId, page, tree } = await editorPage(theme, "preview");
		await tree.getByRole("treeitem", { name: /^Before/ }).click();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		const declarations = page.getByLabel("Declarations", { exact: true });
		await page.waitForLoadState("networkidle");
		const release = Promise.withResolvers<void>();
		const freshHeld = Promise.withResolvers<void>();
		let holding = true;
		await page.route(/\/api\/rpc\/builder\/open$/, async (route) => {
			const response = await route.fetch();
			const body = (await response.json()) as { json: { catalogue: { classes: { generated: boolean }[] } } };
			if (holding && body.json.catalogue.classes.some((each) => each.generated)) {
				freshHeld.resolve();
				await release.promise;
			}
			await route.fulfill({ response });
		});
		try {
			await declarations.fill("color: rgb(1, 2, 3);");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await freshHeld.promise;
			await page.waitForFunction(() => {
				const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
				const paragraph = frame?.contentDocument?.querySelector("header p");
				return (
					paragraph?.getAttribute("class") && frame?.contentWindow?.getComputedStyle(paragraph).color === "rgb(1, 2, 3)"
				);
			});
			expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain('class="');
			await declarations.fill("");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			holding = false;
			release.resolve();
			await page.getByRole("status").filter({ hasText: "One-off style removed." }).waitFor();
			let stored = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (!stored.includes('class="')) break;
				await page.waitForTimeout(50);
			}
			expect(stored).not.toContain('class="');
			await page.waitForFunction(() => {
				const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
				const paragraph = frame?.contentDocument?.querySelector("header p");
				return paragraph && frame?.contentWindow?.getComputedStyle(paragraph).color !== "rgb(1, 2, 3)";
			});
		} finally {
			holding = false;
			release.resolve();
		}
	});

	for (const canvas of ["preview", "live"] as const) {
		test(`unfinished declarations survive a peer refresh on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas, "color: rgb(1, 2, 3);");
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			const declarations = page.getByLabel("Declarations", { exact: true });
			await page.waitForLoadState("networkidle");
			expect(await declarations.inputValue()).toBe("color: rgb(1, 2, 3);");
			await declarations.fill("");
			const refreshed = page.waitForResponse(async (response) => {
				if (!response.url().endsWith(canvas === "preview" ? "/builder/open" : "/code/editor")) return false;
				const body = await response.json();
				const classes = (canvas === "preview" ? body.json.catalogue.classes : body.opened.catalogue.classes) as {
					generated: boolean;
					styles: string;
				}[];
				return classes.some((each) => each.generated && each.styles === "color: rgb(4, 5, 6);");
			});
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original
					.replace('data-wc-label="Before"', 'data-wc-label="Remote"')
					.replace("rgb(1, 2, 3)", "rgb(4, 5, 6)"),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			await refreshed;
			await page.waitForLoadState("networkidle");
			expect(await declarations.inputValue()).toBe("");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			let stored = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (!stored.includes('class="')) break;
				await page.waitForTimeout(50);
			}
			expect(stored).toContain('data-wc-label="Remote"');
			expect(stored).not.toContain('class="');
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: stored.replace("<p ", '<p style="color: rgb(7, 8, 9);" '),
			});
			for (let attempt = 0; attempt < 100; attempt++) {
				if ((await declarations.inputValue()) === "color: rgb(7, 8, 9);") break;
				await page.waitForTimeout(50);
			}
			expect(await declarations.inputValue()).toBe("color: rgb(7, 8, 9);");
		});
	}

	test(`finishing a one-off style keeps the newly selected source's values (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Style source completion");
		const { id: siteId } = await local.createSite(workspace.id, {
			name: "Style source completion",
			slug: "style-source-completion",
		});
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		for (const [name, key] of [
			["FirstNotice", "first"],
			["SecondNotice", "second"],
		] as const) {
			const { component } = await api.components.create({
				siteId,
				name,
				props: [{ key, label: key, type: "text", default: name }],
			});
			await api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: `<p data-wc-id="${key}-element">{{ props.${key} }}</p>`,
			});
			await api.components.publish({ siteId, componentId: component.id });
		}
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header><FirstNotice data-wc-id="first" /><SecondNotice data-wc-id="second" /></header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith("style-source-completion"));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.getByText("Component · SecondNotice", { exact: true }).waitFor();
		await page.waitForLoadState("networkidle");
		await page.locator('p[data-wc-code="site/first#first-element"]').click();
		await page.getByRole("textbox", { name: "HTML of FirstNotice · Component" }).waitFor();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		await page.getByLabel("Declarations", { exact: true }).fill("color: red;");
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const releaseOther = Promise.withResolvers<void>();
		let saved = false;
		await page.route("**/_webcraft/edit/api/code/save", async (route) => {
			const response = await route.fetch();
			saved = true;
			await route.fulfill({ response });
		});
		await page.route("**/_webcraft/edit/api/code/editor", async (route) => {
			if (!saved) return route.continue();
			const ref = route.request().postDataJSON().ref;
			if (ref === "site/second") {
				// A slow refresh of the selected source must not expose another source's values in the meantime.
				const response = await route.fetch();
				await releaseOther.promise;
				return route.fulfill({ response });
			}
			if (ref !== "site/first") return route.continue();
			const response = await route.fetch();
			captured.resolve();
			await release.promise;
			await route.fulfill({ response });
			delivered.resolve();
		});
		try {
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await captured.promise;
			await page.locator('p[data-wc-code="site/second#second-element"]').click();
			await page.getByRole("textbox", { name: "HTML of SecondNotice · Component" }).waitFor();
			await tree
				.getByRole("treeitem")
				.filter({ hasText: /^\{\{ props\.second \}\}/ })
				.click();
			await page.getByRole("combobox", { name: "Reads", exact: true }).waitFor();
			expect(await page.locator('datalist option[value="props.second"]').count()).toBe(1);
			expect(await page.locator('datalist option[value="props.first"]').count()).toBe(0);
			release.resolve();
			await delivered.promise;
			await page.waitForTimeout(300);
			expect(await page.locator('datalist option[value="props.second"]').count()).toBe(1);
			expect(await page.locator('datalist option[value="props.first"]').count()).toBe(0);
		} finally {
			release.resolve();
			releaseOther.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
	});

	test(`unfinished styles stay with the selected source (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		const workspace = await local.createWorkspace("Style source identity");
		const { id: siteId } = await local.createSite(workspace.id, {
			name: "Style source identity",
			slug: "style-source-identity",
		});
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		for (const [name, colour] of [
			["FirstNotice", "rgb(1, 2, 3)"],
			["SecondNotice", "rgb(4, 5, 6)"],
		]) {
			const { component } = await api.components.create({ siteId, name: name as string });
			await api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: `<p data-wc-id="shared" style="color: ${colour};">${name}</p>`,
			});
			await api.components.publish({ siteId, componentId: component.id });
		}
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header><FirstNotice data-wc-id="first" /><SecondNotice data-wc-id="second" /></header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith("style-source-identity"));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("tree", { name: "Layers" }).waitFor();
		await page.waitForLoadState("networkidle");
		await page.locator('p[data-wc-code="site/first#shared"]').click();
		await page.getByRole("textbox", { name: "HTML of FirstNotice · Component" }).waitFor();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		expect(await page.getByLabel("Declarations", { exact: true }).inputValue()).toBe("color: rgb(1, 2, 3);");
		await page.getByLabel("Declarations", { exact: true }).fill("");
		await page.locator('p[data-wc-code="site/second#shared"]').click();
		await page.getByRole("textbox", { name: "HTML of SecondNotice · Component" }).waitFor();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		expect(await page.getByLabel("Declarations", { exact: true }).inputValue()).toBe("color: rgb(4, 5, 6);");
	});

	test(`a late catalogue cannot prevent clearing a one-off style (${theme})`, async () => {
		const { api, siteId, original, page, tree } = await editorPage(theme, "preview");
		await tree.getByRole("treeitem", { name: /^Before/ }).click();
		await page.getByRole("tab", { name: "Style", exact: true }).click();
		const declarations = page.getByLabel("Declarations", { exact: true });
		await declarations.fill("color: rgb(1, 2, 3);");
		await page.waitForLoadState("networkidle");
		const reading = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const captured = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		let reads = 0;
		let active = 0;
		let fresh = false;
		let finished = false;
		let quiet: ReturnType<typeof setTimeout> | undefined;
		await page.route(/\/api\/rpc\/builder\/open$/, async (route) => {
			const number = ++reads;
			if (number !== 2) {
				active++;
				clearTimeout(quiet);
			}
			try {
				if (number === 1) {
					reading.resolve();
					await releaseRead.promise;
				}
				const response = await route.fetch();
				const body = (await response.json()) as { json: { catalogue: { classes: { generated: boolean }[] } } };
				if (number === 2) {
					captured.resolve();
					await releaseOld.promise;
				}
				await route.fulfill({ response });
				if (number === 2) delivered.resolve();
				else fresh ||= body.json.catalogue.classes.some((each) => each.generated);
			} finally {
				if (number !== 2) {
					active--;
					// Wait for the other metadata reads to settle without counting their implementation's calls.
					if (!finished && fresh && active === 0) quiet = setTimeout(settled.resolve, 750);
				}
			}
		});
		const colourIs = (applied: boolean) =>
			page.waitForFunction((expected) => {
				const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
				const paragraph = frame?.contentDocument?.querySelector("header p");
				return paragraph && (frame?.contentWindow?.getComputedStyle(paragraph).color === "rgb(1, 2, 3)") === expected;
			}, applied);
		try {
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await reading.promise;
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			await captured.promise;
			releaseRead.resolve();
			await settled.promise;
			await colourIs(true);
			releaseOld.resolve();
			await delivered.promise;
			await page.waitForLoadState("networkidle");
			await declarations.fill("");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await colourIs(false);
			let stored = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				stored = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (!stored.includes('class="')) break;
				await page.waitForTimeout(50);
			}
			expect(stored).toContain('data-wc-label="Remote"');
			expect(stored).not.toContain('class="');
		} finally {
			finished = true;
			clearTimeout(quiet);
			releaseRead.resolve();
			releaseOld.resolve();
		}
	});

	test(`Module Component sources remain read-only (${theme})`, async () => {
		const local = install.install;
		const { api } = await local.superadmin();
		await api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const workspace = await local.createWorkspace("Read-only sources");
		const { id: siteId } = await local.createSite(workspace.id, {
			name: "Read-only sources",
			slug: "read-only-sources",
		});
		const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
		await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<header><Tabs data-wc-id="tabs-placement" label="Details" /></header><main>{{@outlet}}</main>',
		});
		const page = await install.newPage(theme);
		page.setDefaultTimeout(10000);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((u) => u.hostname.startsWith("read-only-sources"));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.getByRole("treeitem").filter({ hasText: /^Tabs/ }).click();
		const html = page.getByRole("textbox", { name: "HTML of Tabs · Component" });
		await html.waitFor();
		expect(await html.isEditable()).toBe(false);
		expect(await html.inputValue()).toContain("props.label");
	});

	test(`switching source preserves peer changes during selection and printing (${theme})`, async () => {
		const release = Promise.withResolvers<void>();
		const releasePrint = Promise.withResolvers<void>();
		try {
			const local = install.install;
			const { api } = await local.superadmin();
			const workspace = await local.createWorkspace("Source selection review");
			const { id: siteId } = await local.createSite(workspace.id, {
				name: "Source selection review",
				slug: "source-selection-review",
			});
			const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
			const { component } = await api.components.create({ siteId, name: "Notice" });
			const original =
				'<aside data-wc-id="notice"><p data-wc-id="message" data-wc-label="Before">Original text</p></aside>';
			await api.components.saveMarkup({ siteId, componentId: component.id, markup: original });
			await api.components.publish({ siteId, componentId: component.id });
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: '<header data-wc-id="header"><Notice data-wc-id="notice-placement" /></header><main>{{@outlet}}</main>',
			});
			const page = await install.newPage(theme);
			page.setDefaultTimeout(10000);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}`));
			await page.getByRole("button", { name: "Edit on site" }).click();
			await page.waitForURL((url) => url.hostname.startsWith("source-selection-review"));
			await page.getByRole("button", { name: "Code", exact: true }).click();
			const tree = page.getByRole("tree", { name: "Layers" });
			await tree.getByText("Component · Notice", { exact: true }).waitFor();
			await tree.getByRole("treeitem", { name: /^header$/ }).click();
			await page.getByLabel("Tag", { exact: true }).waitFor();
			await page.waitForLoadState("networkidle");
			const html = page.getByRole("textbox", { name: /^HTML of / });
			const held = Promise.withResolvers<void>();
			const fulfilled = Promise.withResolvers<void>();
			let hold = true;
			await page.route("**/_webcraft/edit/api/code/open", async (route) => {
				if (!hold || route.request().postDataJSON().ref !== "site/notice-placement#message") return route.continue();
				hold = false;
				const response = await route.fetch();
				held.resolve();
				await release.promise;
				await route.fulfill({ response });
				fulfilled.resolve();
			});
			await page.locator('p[data-wc-code="site/notice-placement#message"]').click();
			await held.promise;
			const painted = page.waitForResponse(async (response) => {
				if (!response.url().endsWith("/code/editorMarkup")) return false;
				const body = await response.json().catch(() => ({}));
				return body.markup?.includes('data-wc-label="Remote"') ?? false;
			});
			await api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: original.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			await painted;
			await page.waitForTimeout(150);
			const printing = Promise.withResolvers<void>();
			let holdPrint = true;
			await page.route("**/_webcraft/edit/api/code/editorMarkup", async (route) => {
				if (!holdPrint || route.request().postDataJSON().ref !== "site/notice-placement") return route.continue();
				holdPrint = false;
				const response = await route.fetch();
				printing.resolve();
				await releasePrint.promise;
				await route.fulfill({ response });
			});
			release.resolve();
			await fulfilled.promise;
			await printing.promise;
			await api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: original.replace('data-wc-label="Before"', 'data-wc-label="Newest"'),
			});
			await tree.getByRole("treeitem", { name: /^Newest/ }).waitFor();
			releasePrint.resolve();
			await page.getByRole("textbox", { name: "HTML of Notice · Component" }).waitFor();
			await page.waitForLoadState("networkidle");
			await html.fill((await html.inputValue()).replace("<aside ", '<aside data-wc-label="Local aside" '));
			let saved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				saved = (await api.components.getMarkup({ siteId, componentId: component.id })).markup.draft;
				if (saved.includes('data-wc-label="Local aside"')) break;
				await page.waitForTimeout(50);
			}
			expect(saved).toContain('data-wc-label="Local aside"');
			expect(saved).toContain('data-wc-label="Newest"');
		} finally {
			release.resolve();
			releasePrint.resolve();
		}
	});

	test(`a delayed Inspector selection preserves the peer's HTML for the next edit (${theme})`, async () => {
		const { api, siteId, page, tree } = await editorPage(theme, "live");
		const release = Promise.withResolvers<void>();
		try {
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByLabel("Tag", { exact: true }).waitFor();
			await page.waitForLoadState("networkidle");
			const html = page.getByRole("textbox", { name: /^HTML of / });
			const held = Promise.withResolvers<void>();
			const fulfilled = Promise.withResolvers<void>();
			let hold = true;
			await page.route("**/_webcraft/edit/api/code/open", async (route) => {
				if (!hold || route.request().postDataJSON().ref !== "site#greeting") return route.continue();
				hold = false;
				const response = await route.fetch();
				held.resolve();
				await release.promise;
				await route.fulfill({ response });
				fulfilled.resolve();
			});
			await page.getByLabel("Tag", { exact: true }).fill("h2");
			await page.getByLabel("Tag", { exact: true }).press("Enter");
			await held.promise;
			const changed = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			expect(changed).toContain("<h2 ");
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: changed.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			await page.waitForFunction(() =>
				document
					.querySelector("webcraft-code-mode")
					?.shadowRoot?.querySelector("textarea")
					?.value.includes('data-wc-label="Remote"'),
			);
			release.resolve();
			await fulfilled.promise;
			await page.waitForLoadState("networkidle");
			await html.fill((await html.inputValue()).replace("<header ", '<header data-wc-label="Local header" '));
			let saved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (saved.includes('data-wc-label="Local header"')) break;
				await page.waitForTimeout(50);
			}
			expect(saved).toContain('data-wc-label="Local header"');
			expect(saved).toContain('data-wc-label="Remote"');
		} finally {
			release.resolve();
		}
	});

	test(`an old Inspector refresh preserves the peer's tree for the next edit (${theme})`, async () => {
		const { api, siteId, page, tree } = await editorPage(theme, "live");
		const release = Promise.withResolvers<void>();
		try {
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByLabel("Layer label", { exact: true }).waitFor();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			await page.getByLabel("Declarations", { exact: true }).fill("color: rgb(1, 2, 3);");
			await page.waitForLoadState("networkidle");
			let afterSave = false;
			let capture = true;
			const held = Promise.withResolvers<void>();
			page.on("response", (response) => {
				if (response.url().endsWith("/code/save") && response.status() === 200) afterSave = true;
			});
			await page.route("**/_webcraft/edit/api/code/editor", async (route) => {
				if (!afterSave || !capture) return route.continue();
				const response = await route.fetch();
				held.resolve();
				await release.promise;
				await route.fulfill({ response });
			});
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await held.promise;
			// Let the post-save refreshes start, holding their real responses before the peer edit.
			await page.waitForTimeout(500);
			capture = false;
			const styled = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: styled.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			release.resolve();
			await page.waitForLoadState("networkidle");
			await page.getByRole("tab", { name: "Settings", exact: true }).click();
			await page.getByLabel("Tag", { exact: true }).fill("h2");
			await page.getByLabel("Tag", { exact: true }).press("Enter");
			let saved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (saved.includes("<h2 ")) break;
				await page.waitForTimeout(50);
			}
			expect(saved).toContain("<h2 ");
			expect(saved).toContain('data-wc-label="Remote"');
		} finally {
			release.resolve();
		}
	});

	test(`a late remote paint cannot replace newly saved HTML (${theme})`, async () => {
		const { api, siteId, original, page, tree } = await editorPage(theme, "live");
		const release = Promise.withResolvers<void>();
		try {
			await tree.getByRole("treeitem", { name: /^Before/ }).waitFor();
			await page.waitForLoadState("networkidle");
			const html = page.getByRole("textbox", { name: /^HTML of / });
			const shown = await html.inputValue();
			await html.fill(`${shown}<aside`);
			await page.waitForTimeout(500);
			const printing = Promise.withResolvers<void>();
			const fulfilled = Promise.withResolvers<void>();
			let hold = true;
			await page.route("**/_webcraft/edit/api/code/editorMarkup", async (route) => {
				const input = route.request().postDataJSON();
				if (!hold || !JSON.stringify(input.draft?.tree).includes('"label":"Remote"')) return route.continue();
				hold = false;
				const response = await route.fetch();
				printing.resolve();
				await release.promise;
				await route.fulfill({ response });
				fulfilled.resolve();
			});
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await printing.promise;
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			await html.fill(shown.replace("Original text", "Newly saved text"));
			await page.waitForFunction(() =>
				document
					.querySelector("webcraft-code-mode")
					?.shadowRoot?.querySelector("textarea")
					?.value.includes('data-wc-label="Remote"'),
			);
			expect(await html.inputValue()).toContain("Newly saved text");
			release.resolve();
			await fulfilled.promise;
			await page.waitForLoadState("networkidle");
			await html.fill((await html.inputValue()).replace("<header ", '<header data-wc-label="Local header" '));
			let saved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (saved.includes('data-wc-label="Local header"')) break;
				await page.waitForTimeout(50);
			}
			expect(saved).toContain('data-wc-label="Local header"');
			expect(saved).toContain("Newly saved text");
			expect(saved).toContain('data-wc-label="Remote"');
		} finally {
			release.resolve();
		}
	});
}

for (const { input, canvas } of [
	{ input: "Inspector", canvas: "live" },
	{ input: "HTML", canvas: "live" },
	{ input: "Inspector", canvas: "preview" },
] as const) {
	for (const theme of THEMES) {
		test(`one-off styles preserve a peer edit through ${input} on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			if (input === "Inspector") {
				const selected =
					canvas === "live"
						? page.waitForResponse((response) => response.url().endsWith("/code/open"))
						: Promise.resolve();
				await tree.getByRole("treeitem", { name: /^Before/ }).click();
				await selected;
				await page.getByLabel("Layer label", { exact: true }).waitFor();
				await page.getByRole("tab", { name: "Style", exact: true }).click();
				await page.getByLabel("Declarations", { exact: true }).fill("color: rgb(1, 2, 3);");
			}
			await tree.getByRole("treeitem", { name: /^Before/ }).waitFor();
			await page.waitForLoadState("networkidle");

			// Hold a real read for Inspector styles, or a printed HTML response, while the peer saves.
			const sourceReads =
				canvas === "preview"
					? /\/api\/rpc\/builder\/open$/
					: input === "Inspector"
						? /\/_webcraft\/edit\/api\/code\/(open|editor)$/
						: /\/_webcraft\/edit\/api\/code\/editorMarkup$/;
			const reading = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await page.route(sourceReads, async (route) => {
				if (input === "HTML") {
					if (!Object.keys(route.request().postDataJSON().draft?.styles ?? {}).length) return route.continue();
					const response = await route.fetch();
					reading.resolve();
					await release.promise;
					await route.fulfill({ response });
				} else {
					reading.resolve();
					await release.promise;
					await route.continue();
				}
			});
			try {
				const saving = page.waitForResponse((response) =>
					response.url().endsWith(canvas === "live" ? "/code/save" : "/templates/saveSiteTemplateMarkup"),
				);
				if (input === "Inspector") await page.getByRole("button", { name: "Apply", exact: true }).click();
				else {
					const html = page.getByRole("textbox", { name: /^HTML of / });
					expect(await html.inputValue()).toContain("Original text");
					await html.fill((await html.inputValue()).replace("<p ", '<p style="color: rgb(1, 2, 3);" '));
				}
				await reading.promise;
				await api.templates.saveSiteTemplateMarkup({
					siteId,
					markup: original.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
				});
				await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
				release.resolve();
				expect((await saving).status()).toBe(input === "HTML" ? 409 : 200);
				expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain(
					'data-wc-label="Remote"',
				);
				if (input === "Inspector")
					for (const applied of [true, false]) {
						if (!applied) {
							await page.waitForLoadState("networkidle");
							await page.getByLabel("Declarations", { exact: true }).fill("");
							await page.getByRole("button", { name: "Apply", exact: true }).click();
						}
						await page.waitForFunction(
							({ canvas, applied }) => {
								const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
								const documentOf = canvas === "preview" ? frame?.contentDocument : document;
								const windowOf = canvas === "preview" ? frame?.contentWindow : window;
								const paragraph = documentOf?.querySelector("header p");
								return paragraph && (windowOf?.getComputedStyle(paragraph).color === "rgb(1, 2, 3)") === applied;
							},
							{ canvas, applied },
						);
					}
			} finally {
				release.resolve();
			}
		});
	}
}

for (const delayed of [false, true]) {
	test(`keeps a peer rename through repeated markup edits${delayed ? " while printing is delayed" : ""}`, async () => {
		const { api, siteId, page } = await editorPage("light", "preview");
		const { postType } = await api.postTypes.create({
			siteId,
			name: "Articles",
			urlPattern: "/articles/{slug}",
			fields: [],
		});
		const postTypeId = postType.id;
		await api.entries.create({ siteId, postTypeId, title: "Fresh bread", fields: {} });
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup:
				'<article data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="title">{{ title }}</h1><p data-wc-id="lead">Fresh from the oven</p></article>',
		});
		await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postTypeId}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("Fresh bread").waitFor();
		const draftMarkup = async () =>
			(await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
		const markup = page.getByRole("textbox", { name: "Template markup", exact: true });
		const original = await markup.inputValue();
		await markup.fill(`${original}<aside`);
		await markup.and(page.locator('[aria-invalid="true"]')).waitFor();
		const received = page.waitForResponse(
			async (response) => response.url().includes("/builder/open") && (await response.text()).includes("Remote"),
		);
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: original.replace('data-wc-label="Post"', 'data-wc-label="Remote"'),
		});
		await received;
		const printing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		if (delayed)
			await page.route("**/api/rpc/builder/markup", async (route) => {
				printing.resolve();
				await release.promise;
				await route.continue();
			});
		await markup.fill(original.replace("Fresh from the oven", "First local text"));
		if (delayed) {
			await printing.promise;
			await markup.fill((await markup.inputValue()).replace("First local text", "Second local text"));
			for (let attempt = 0; attempt < 80; attempt++) {
				if ((await draftMarkup()).includes("Second local text")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(await draftMarkup()).toContain("Second local text");
			release.resolve();
		}
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>("textarea")?.value.includes('data-wc-label="Remote"'),
		);
		if (!delayed) {
			expect(await markup.inputValue()).toContain("First local text");
			await markup.fill((await markup.inputValue()).replace("First local text", "Second local text"));
		}
		await page.frameLocator("iframe[title^='Canvas']").getByText("Second local text", { exact: true }).waitFor();
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();
		expect(await draftMarkup()).toContain('data-wc-label="Remote"');
		expect(await draftMarkup()).toContain("Second local text");
	});
}
