import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
const slug = "popup-module";
beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	await api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
	const workspace = await local.createWorkspace();
	const siteId = (await local.createSite(workspace.id, { slug })).id;
	await install.goLive(siteId);
	const items = JSON.stringify([
		{ heading: "Overview", text: "First panel" },
		{ heading: "Details", text: "Second panel" },
	]);
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: `<Tabs label="Offer details" items='${items}'/>`,
	});
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Offer", enabled: true } });
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<h1>{{ title }}</h1><Tabs label="Page details" items='${items}'/>{{@popup offer}}{{@consentSettings}}`,
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "details" });
	await api.entries.publish({ siteId, entryId: entry.id });
});
afterAll(async () => {
	await install.close();
});

for (const theme of THEMES)
	test(`a consented Module enhances its Block when a Popup mounts later (${theme})`, async () => {
		const page = await install.newPage(theme);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(install.liveUrl(slug, "/offers/details"));
		await page.getByRole("button", { name: "Accept all", exact: true }).click();
		// The visible Block proves the consented script has run before the hidden tree mounts.
		await page.getByRole("tablist", { name: "Page details", exact: true }).waitFor();
		const link = page.getByRole("link", { name: "Offer", exact: true });
		await link.focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
		await dialog.waitFor();
		const first = dialog.getByRole("tab", { name: "Overview", exact: true });
		await first.waitFor({ timeout: 5000 });
		await first.focus();
		await page.keyboard.press("ArrowRight");
		expect(await dialog.getByRole("tab", { name: "Details", exact: true }).getAttribute("aria-selected")).toBe("true");
		expect(await dialog.getByRole("tabpanel", { name: "Details", exact: true }).textContent()).toContain(
			"Second panel",
		);
		await expectNoAxeViolations(page, `Popup with a Module Block ${theme}`);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
