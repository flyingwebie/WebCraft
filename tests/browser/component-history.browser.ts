import { afterEach, beforeEach, expect, test } from "bun:test";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

async function openSource(theme: "light" | "dark", canvas: "builder" | "live") {
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
