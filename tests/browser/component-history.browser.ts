import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

async function openSource(
	theme: "light" | "dark",
	canvas: "builder" | "live",
	prepare?: (page: Page) => Promise<void>,
) {
	const workspace = await install.install.createWorkspace("Component history");
	const site = await install.install.createSite(workspace.id, { name: "Component history", slug: `parts-${theme}` });
	const staff = await install.install.createStaff({ workspaces: [workspace.id] });
	const api = staff.browser.api;
	const { component } = await api.components.create({ siteId: site.id, name: "HistorySource" });
	await api.components.saveMarkup({
		siteId: site.id,
		componentId: component.id,
		props: [{ key: "title", type: "text", label: "Title", default: "Original" }],
		markup:
			'<article data-wc-id="source"><p data-wc-id="body">{{ props.title }}</p><aside data-wc-id="side">Side</aside></article>',
	});
	const { postType } = await api.postTypes.create({ siteId: site.id, name: "Notes", urlPattern: "/notes/{slug}" });
	await api.entries.create({ siteId: site.id, postTypeId: postType.id, title: "First" });
	await api.templates.saveEntryTemplateMarkup({
		siteId: site.id,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1><HistorySource />",
	});
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	await prepare?.(page);
	await install.signIn(page, staff.account);
	await page.goto(install.adminUrl(`/builder/${site.id}/component/${component.id}`));
	if (canvas === "live") {
		await page.getByRole("button", { name: "View on a page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/notes/first");
		await page.locator('p[data-wc-code$="#body"]').click();
	} else {
		await page.frameLocator("iframe[title^='Canvas']").getByText("Original", { exact: true }).waitFor();
	}
	const paragraph = page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name: /^p\b/ });
	await paragraph.click();
	await paragraph.and(page.locator("[aria-selected=true]")).waitFor();
	await page.getByRole("button", { name: "Make Component", exact: true }).waitFor();
	return { page, api, siteId: site.id, componentId: component.id };
}

for (const theme of THEMES)
	for (const canvas of ["builder", "live"] as const) {
		test(`Make Component and Props are own history steps, preserving peers on ${canvas} (${theme})`, async () => {
			const { page, api, siteId, componentId } = await openSource(theme, canvas);
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			try {
				await page.route(
					canvas === "builder" ? "**/api/rpc/components/make" : "**/code/makeComponent",
					async (route) => {
						const response = await route.fetch();
						held.resolve();
						await release.promise;
						await route.fulfill({ response });
					},
				);
				await page.keyboard.press("ControlOrMeta+k");
				const menu = page.getByRole("dialog", { name: "Command menu" });
				await menu.getByRole("combobox").fill("Make Component");
				await menu.getByRole("option", { name: /^Make Component/ }).click();
				const dialog = page.getByRole("dialog", { name: "Make Component" });
				await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("HistoryPart");
				await expectNoAxeViolations(page, `Component history ${canvas} ${theme}`, ["region"], {
					exclude: canvas === "builder" ? ["iframe[title^='Canvas']"] : [],
				});
				await dialog.getByRole("button", { name: "Make Component", exact: true }).click();
				await held.promise;
				// A peer changes another node and a declaration after the transaction, before its reply arrives.
				const current = await api.components.getMarkup({ siteId, componentId });
				expect(current.markup.draft).toContain(">Side<");
				await api.components.saveMarkup({
					siteId,
					componentId,
					markup: current.markup.draft.replace(">Side<", ">Peer side<"),
				});
				const peer = await api.components.saveDraft({
					siteId,
					componentId,
					props: [...current.component.draft.props, { key: "peer", label: "Peer", type: "text", default: "Kept" }],
				});
				const peerProps = peer.component.draft.props;
				expect(JSON.stringify(peer.component.draft.tree)).toContain("Peer side");
				release.resolve();
				await dialog.waitFor({ state: "hidden" });
				expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain("Peer side");
				const undo = page.getByRole("button", { name: "Undo", exact: true });
				expect(await undo.getAttribute("title")).toStartWith("Undo Make Component HistoryPart (");
				await undo.click();
				await page.getByRole("status").filter({ hasText: "Undid Make Component HistoryPart" }).first().waitFor();
				const reversed = await api.components.getMarkup({ siteId, componentId });
				expect(reversed.markup.draft).toContain("{{ props.title }}</p>");
				expect(reversed.markup.draft).toContain("Peer side");
				expect(reversed.markup.draft).not.toContain("<HistoryPart");
				expect(reversed.component.draft.props).toEqual(peerProps);
				const made = (await api.components.list({ siteId })).components.find((each) => each.name === "HistoryPart");
				expect(made?.published).toBeNull();
				expect(made?.draft.props.some((prop) => prop.key === "title")).toBe(true);
				expect(await undo.isDisabled()).toBe(true);
				await page.getByRole("button", { name: "Redo", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Redid Make Component HistoryPart" }).first().waitFor();
				const redone = await api.components.getMarkup({ siteId, componentId });
				expect(redone.markup.draft).toContain("<HistoryPart");
				expect(redone.markup.draft).toContain("Peer side");
				expect(redone.component.draft.props).toEqual(peerProps);
				await page
					.getByRole("tree", { name: "Layers" })
					.getByRole("treeitem", { name: /^HistoryPart\b/ })
					.and(page.locator("[aria-selected=true]"))
					.waitFor();

				// The Inspector's declaration action follows Make Component in this same history.
				await page
					.getByRole("tree", { name: "Layers" })
					.getByRole("treeitem", { name: /^aside\b/ })
					.click();
				const props = page.getByRole("region", { name: "Props of HistorySource" });
				await props.getByRole("button", { name: "Add a Prop" }).click();
				await props.getByRole("textbox", { name: "Name", exact: true }).nth(2).waitFor();
				await undo.click();
				await page.getByRole("status").filter({ hasText: "Undid Add Prop prop" }).first().waitFor();
				const withoutProp = await api.components.getMarkup({ siteId, componentId });
				expect(withoutProp.component.draft.props).toEqual(peerProps);
				expect(withoutProp.markup.draft).toContain("<HistoryPart");
			} finally {
				release.resolve();
				await page.unrouteAll({ behavior: "wait" });
				await page.close();
			}
		});

		test(`placed New Component retains its source step across navigation on ${canvas} (${theme})`, async () => {
			const { page, api, siteId, componentId } = await openSource(theme, canvas);
			try {
				await page
					.getByRole("group", { name: "Insert", exact: true })
					.getByRole("button", { name: "Component", exact: true })
					.click();
				const menu = page.getByRole("dialog", { name: "Command menu" });
				await menu.getByRole("option", { name: /^New Component/ }).click();
				const dialog = page.getByRole("dialog", { name: "New Component" });
				await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("EmptyPart");
				await dialog.getByRole("button", { name: "Create Component", exact: true }).click();
				await dialog.waitFor({ state: "hidden" });
				if (canvas === "builder") {
					await page.waitForURL((url) => url.pathname.includes("/component/") && !url.pathname.endsWith(componentId));
					await page.getByRole("heading", { name: "EmptyPart", exact: true }).waitFor();
				} else await page.getByRole("textbox", { name: /^HTML of EmptyPart/ }).waitFor();
				await page.waitForLoadState("networkidle");
				const undo = page.getByRole("button", { name: "Undo", exact: true });
				await undo.waitFor();
				expect(await undo.isDisabled()).toBe(false);
				await undo.click();
				await page.getByRole("status").filter({ hasText: "Undid Create Component EmptyPart" }).first().waitFor();
				expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).not.toContain("<EmptyPart");
				expect((await api.components.list({ siteId })).components.some((each) => each.name === "EmptyPart")).toBe(true);
				expect(await undo.isDisabled()).toBe(true);
				await page.getByRole("button", { name: "Redo", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Redid Create Component EmptyPart" }).first().waitFor();
				expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain("<EmptyPart");
			} finally {
				await page.close();
			}
		});
	}

for (const theme of THEMES) {
	for (const canvas of ["builder", "live"] as const) {
		test(`Class creation Undo never adopts peer CSS on ${canvas} (${theme})`, async () => {
			const { page, api, siteId, componentId } = await openSource(theme, canvas);
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			try {
				await page.route(
					canvas === "builder" ? "**/api/rpc/designSystem/createClass" : "**/code/createClass",
					async (route) => {
						const response = await route.fetch();
						held.resolve();
						await release.promise;
						await route.fulfill({ response });
					},
				);
				const css = page.getByRole("region", { name: "CSS", exact: true });
				await css.getByRole("button", { name: "Give this element a Class" }).click();
				await css.getByRole("combobox", { name: "Class name" }).fill("shared-class");
				await css.getByRole("combobox", { name: "Class name" }).press("Enter");
				await held.promise;
				const created = (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
					(each) => each.name === "shared-class",
				);
				if (!created) throw new Error("Expected the created Class");
				await api.designSystem.updateClass({ siteId, classId: created.id, styles: "color: blue;" });
				release.resolve();
				await css.getByRole("tab", { name: ".shared-class", selected: true }).waitFor();
				await page.getByRole("button", { name: "Undo", exact: true }).click();
				await page
					.getByRole("status")
					.or(page.getByRole("alert"))
					.filter({ hasText: /Undid|Skipped/ })
					.first()
					.waitFor();
				const kept = (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
					(each) => each.id === created.id,
				);
				expect(kept?.styles).toContain("blue");
				expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain(
					'class="shared-class"',
				);
				expect((await page.getByRole("alert").allTextContents()).join(" ")).toContain("Skipped");
				expect(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled()).toBe(true);
			} finally {
				release.resolve();
				await page.unrouteAll({ behavior: "wait" });
				await page.close();
			}
		});
	}

	test(`fixed text conversion is one reversible Prop action in Code mode (${theme})`, async () => {
		const { page, api, siteId, componentId } = await openSource(theme, "live");
		try {
			const before = await api.components.getMarkup({ siteId, componentId });
			await page
				.getByRole("tree", { name: "Layers" })
				.getByRole("treeitem", { name: /^“Side”/ })
				.click();
			await page.getByRole("button", { name: "Bind to Prop", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Bind to Prop" });
			await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Side label");
			await dialog.getByRole("button", { name: "Bind to Prop", exact: true }).click();
			await dialog.waitFor({ state: "hidden" });
			const undo = page.getByRole("button", { name: "Undo", exact: true });
			expect(await undo.isDisabled()).toBe(false);
			await undo.click();
			await page
				.getByRole("tree", { name: "Layers" })
				.getByRole("treeitem", { name: /^“Side”/ })
				.waitFor();
			const reversed = await api.components.getMarkup({ siteId, componentId });
			expect(reversed.component.draft.props).toEqual(before.component.draft.props);
			expect(reversed.markup.draft).toContain(">Side</aside>");
			expect(await undo.isDisabled()).toBe(true);
			await page.getByRole("button", { name: "Redo", exact: true }).click();
			await page
				.getByRole("tree", { name: "Layers" })
				.getByRole("treeitem", { name: /^{{ props.side_label }}/ })
				.waitFor();
			const redone = await api.components.getMarkup({ siteId, componentId });
			expect(redone.component.draft.props.find((prop) => prop.key === "side_label")?.default).toBe("Side");
			expect(redone.markup.draft).toContain("{{ props.side_label }}</aside>");
		} finally {
			await page.close();
		}
	});

	test(`delayed HTML acknowledgement retains the next incomplete typing step (${theme})`, async () => {
		let holding = false;
		const held = Promise.withResolvers<void>();
		const deliver: (() => void)[] = [];
		const { page, api, siteId, componentId } = await openSource(theme, "live", async (page) => {
			await page.routeWebSocket(/\/_webcraft\/edit\/drafts\/component\//, (socket) => {
				const upstream = socket.connectToServer();
				upstream.onMessage((message) => {
					if (holding && typeof message === "string" && JSON.parse(message).type === "saved") {
						deliver.push(() => socket.send(message));
						held.resolve();
					} else socket.send(message);
				});
			});
		});
		try {
			const html = page.getByRole("textbox", { name: /^HTML of HistorySource/ });
			const original = await html.inputValue();
			const valid = original.replace(">Side</aside>", ">Changed side</aside>");
			expect(valid).not.toBe(original);
			holding = true;
			await html.fill(valid);
			await held.promise;
			// The next burst starts after the documented one-second grouping window.
			await page.waitForTimeout(1100);
			await html.fill(`${valid}<`);
			holding = false;
			for (const send of deliver.splice(0)) send();
			await page.waitForResponse((response) => response.url().endsWith("/code/editorRead") && response.status() >= 400);
			await html.press("ControlOrMeta+z");
			await page.getByRole("status").filter({ hasText: "Undid Edit HTML of HistorySource" }).first().waitFor();
			expect(await html.inputValue()).toBe(valid);
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain("Changed side");
			await html.press("ControlOrMeta+z");
			await page
				.locator('aside[data-wc-code$="#side"]')
				.filter({ hasText: /^Side$/ })
				.waitFor();
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain(">Side</aside>");
			await html.press("ControlOrMeta+Shift+z");
			await page
				.locator('aside[data-wc-code$="#side"]')
				.filter({ hasText: /^Changed side$/ })
				.waitFor();
			await html.press("ControlOrMeta+Shift+z");
			await page.waitForFunction(({ element, text }) => (element as HTMLTextAreaElement | null)?.value === text, {
				element: await html.elementHandle(),
				text: `${valid}<`,
			});
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain("Changed side");
		} finally {
			holding = false;
			for (const send of deliver.splice(0)) send();
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`generated Class Undo never adopts peer CSS on the Builder (${theme})`, async () => {
		const { page, api, siteId, componentId } = await openSource(theme, "builder");
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			await page.route("**/api/rpc/components/saveMarkup", async (route) => {
				const response = await route.fetch();
				held.resolve();
				await release.promise;
				await route.fulfill({ response });
			});
			const html = page.getByRole("textbox", { name: "Template markup", exact: true });
			await html.fill(
				(await html.inputValue()).replace('<aside data-wc-id="side">', '<aside data-wc-id="side" style="color: red;">'),
			);
			await page.getByRole("button", { name: "Save", exact: true }).first().click();
			await held.promise;
			const generated = (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
				(each) => each.generated,
			);
			if (!generated) throw new Error("Expected a generated Class");
			await api.designSystem.updateClass({ siteId, classId: generated.id, styles: "color: blue;" });
			release.resolve();
			await page.getByRole("status").filter({ hasText: "HistorySource is saved to its Draft." }).first().waitFor();
			await page.getByRole("button", { name: "Undo", exact: true }).click();
			await page
				.getByRole("status")
				.or(page.getByRole("alert"))
				.filter({ hasText: /Undid|Skipped/ })
				.first()
				.waitFor();
			const kept = (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
				(each) => each.id === generated.id,
			);
			expect(kept?.styles).toContain("blue");
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain(generated.name);
			expect((await page.getByRole("alert").allTextContents()).join(" ")).toContain("Skipped");
		} finally {
			release.resolve();
			await page.unrouteAll({ behavior: "wait" });
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`HTML Create Class completes one reversible typing action (${theme})`, async () => {
		const { page, api, siteId, componentId } = await openSource(theme, "live");
		try {
			const html = page.getByRole("textbox", { name: /^HTML of HistorySource/ });
			const original = await html.inputValue();
			await html.fill(
				original.replace('<aside data-wc-id="side">', '<aside data-wc-id="side" class="suggested-class">'),
			);
			await page.getByRole("button", { name: "Create Class “suggested-class”", exact: true }).click();
			await page
				.getByRole("status")
				.filter({ hasText: "Class suggested-class added to the Design system's Draft" })
				.first()
				.waitFor();
			await html.press("ControlOrMeta+s");
			await page.getByRole("status").filter({ hasText: "Saved to Draft · HistorySource" }).first().waitFor();
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain(
				'class="suggested-class"',
			);
			await html.press("ControlOrMeta+z");
			await page.getByRole("status").filter({ hasText: "Undid" }).first().waitFor();
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).not.toContain("suggested-class");
			expect(
				(await api.designSystem.get({ siteId })).designSystem.draft.classes.some(
					(each) => each.name === "suggested-class",
				),
			).toBe(false);
			expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
			await html.press("ControlOrMeta+Shift+z");
			await page.getByRole("status").filter({ hasText: "Redid" }).first().waitFor();
			expect((await api.components.getMarkup({ siteId, componentId })).markup.draft).toContain(
				'class="suggested-class"',
			);
			expect(
				(await api.designSystem.get({ siteId })).designSystem.draft.classes.some(
					(each) => each.name === "suggested-class",
				),
			).toBe(true);
		} finally {
			await page.close();
		}
	});
}

test("navigation waits for HTML Class creation after its typing was undone", async () => {
	const { page, api, siteId } = await openSource("light", "live");
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		await page.route("**/code/createClass", async (route) => {
			const response = await route.fetch();
			held.resolve();
			await release.promise;
			await route.fulfill({ response });
		});
		const html = page.getByRole("textbox", { name: /^HTML of HistorySource/ });
		await html.fill(
			(await html.inputValue()).replace('<aside data-wc-id="side">', '<aside data-wc-id="side" class="pending-class">'),
		);
		await page.getByRole("button", { name: "Create Class “pending-class”", exact: true }).click();
		await held.promise;
		await html.press("ControlOrMeta+z");
		await page.getByRole("status").filter({ hasText: "Undid" }).first().waitFor();
		await page.getByRole("button", { name: "Open in builder", exact: true }).click();
		// A held own operation cannot be abandoned by an otherwise clean navigation.
		const leftEarly = await page
			.waitForURL((url) => url.pathname.includes("/builder/"), { timeout: 2000 })
			.then(
				() => true,
				() => false,
			);
		expect(leftEarly).toBe(false);
		release.resolve();
		await page
			.getByRole("status")
			.filter({ hasText: "Class pending-class added to the Design system's Draft" })
			.first()
			.waitFor();
		await page.getByRole("button", { name: "Open in builder", exact: true }).click();
		await page.waitForURL((url) => url.pathname.includes("/builder/"));
		const undo = page.getByRole("button", { name: "Undo", exact: true });
		await undo.and(page.locator(":not([disabled])")).waitFor();
		await undo.click();
		await page.getByRole("status").filter({ hasText: "Undid Create Class pending-class" }).first().waitFor();
		expect(
			(await api.designSystem.get({ siteId })).designSystem.draft.classes.some((each) => each.name === "pending-class"),
		).toBe(false);
	} finally {
		release.resolve();
		await page.unrouteAll({ behavior: "wait" });
		await page.close();
	}
});
