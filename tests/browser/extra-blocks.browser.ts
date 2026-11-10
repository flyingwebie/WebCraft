import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let admin: TestBrowser;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;
const path = "/stories/panels";
beforeAll(async () => {
	install = await startBrowserInstall();
	admin = await install.install.superadmin();
	await admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
	const workspace = await install.install.createWorkspace("Extra blocks");
	siteId = (await install.install.createSite(workspace.id, { name: "Extra blocks", slug: "extra" })).id;
	staff = (await install.install.createStaff({ workspaces: [workspace.id] })).account;
	await install.goLive(siteId);
	postTypeId = (
		await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			key: "stories",
			urlPattern: "/stories/{slug}",
			fields: [
				{
					key: "body",
					label: "Body",
					type: "body",
					components: ["extra-blocks:Tabs", "extra-blocks:Accordion", "extra-blocks:MapEmbed", "extra-blocks:Gallery"],
				},
			],
		})
	).postType.id;
	const tabs = (id: string) => ({
		id,
		type: "component",
		component: "extra-blocks:Tabs",
		props: [
			{ name: "label", value: id },
			{
				name: "items",
				value: JSON.stringify([
					{ heading: "First", text: "First panel" },
					{ heading: "Second", text: "Second panel" },
				]),
			},
		],
	});
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 40, height: 30 }), "gallery.jpg"),
	});
	await install.install.drainJobs();
	entryId = (
		await admin.api.entries.create({
			siteId,
			postTypeId,
			title: "Panels",
			fields: {
				body: [
					tabs("One"),
					tabs("Two"),
					{
						type: "component",
						component: "extra-blocks:Accordion",
						props: [{ name: "items", value: JSON.stringify([{ heading: "Delivery?", text: "Every day" }]) }],
					},
					{
						type: "component",
						component: "extra-blocks:MapEmbed",
						props: [
							{ name: "label", value: "Find us" },
							{ name: "url", value: "https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4" },
						],
					},
					{
						type: "component",
						component: "extra-blocks:Gallery",
						props: [
							{
								name: "images",
								value: JSON.stringify([
									{ image: media.id, alt: "Fresh bread", caption: "Morning", decorative: false },
									{ image: media.id, alt: "", caption: "", decorative: true },
								]),
							},
						],
					},
					{ type: "paragraph", text: "" },
				],
			},
		})
	).entry.id;
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1><div>{{ body }}</div></article>",
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	await admin.api.entries.publish({ siteId, entryId });
});
afterAll(async () => {
	await install.close();
});
for (const theme of THEMES) {
	test(`Extra blocks work without JavaScript and before Consent (${theme})`, async () => {
		const page = await install.newPage(theme, { javaScript: false });
		const requests: string[] = [];
		page.on("request", (request) => requests.push(request.url()));
		await page.goto(install.liveUrl("extra", path));
		expect(await page.getByText("Second panel", { exact: true }).count()).toBe(2);
		expect(await page.locator("iframe").count()).toBe(0);
		expect(await page.getByRole("img", { name: "Fresh bread", exact: true }).count()).toBe(1);
		expect(await page.locator('[data-extra-block="gallery"] img[alt=""]').count()).toBe(1);
		const summary = page.locator("summary");
		await summary.focus();
		await page.keyboard.press("Enter");
		expect(await page.locator("details").getAttribute("open")).not.toBeNull();
		expect(requests.some((url) => url.includes("openstreetmap.org"))).toBe(false);
		// axe requires JavaScript; the identical static markup is checked before Consent below.
		await page.close();
	});
	test(`Consent enables two independent keyboard tabsets and a named map (${theme})`, async () => {
		const page = await install.newPage(theme);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const external: string[] = [];
		await page.route("https://www.openstreetmap.org/**", async (route) => {
			external.push(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<!doctype html><html lang='en'><head><title>Map</title></head><body><main aria-label='Map'>Map</main></body></html>",
			});
		});
		await page.goto(install.liveUrl("extra", path));
		await page.getByRole("button", { name: "Accept all", exact: true }).waitFor();
		expect(external).toEqual([]);
		expect(await page.getByRole("tab").count()).toBe(0);
		await expectNoAxeViolations(page, `Extra blocks before Consent ${theme}`);
		await page.getByRole("button", { name: "Accept all", exact: true }).click();
		await page.getByRole("tablist", { name: "One", exact: true }).waitFor();
		const first = page.getByRole("tablist", { name: "One", exact: true });
		await first.getByRole("tab", { name: "First", exact: true }).focus();
		await page.keyboard.press("ArrowRight");
		expect(await first.getByRole("tab", { name: "Second", exact: true }).getAttribute("aria-selected")).toBe("true");
		expect(
			await page
				.getByRole("tablist", { name: "Two", exact: true })
				.getByRole("tab", { name: "First", exact: true })
				.getAttribute("aria-selected"),
		).toBe("true");
		await page.keyboard.press("Home");
		expect(await first.getByRole("tab", { name: "First", exact: true }).getAttribute("aria-selected")).toBe("true");
		await page.locator('iframe[title="Find us"]').waitFor();
		const ids = await page.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
		expect(new Set(ids).size).toBe(ids.length);
		await expectAccessibleScreen(page, `enhanced Extra blocks ${theme}`);
		await page.close();
	});
	test(`Staff allowances and the shared Body add controls are accessible (${theme})`, async () => {
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/post-types/${postTypeId}`));
		await page.getByRole("button", { name: /^Body/ }).click();
		await page.getByRole("checkbox", { name: "Gallery", exact: true }).waitFor();
		await expectNoAxeViolations(page, `Extra blocks allowances ${theme}`);
		await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		await page.getByRole("textbox", { name: "Paragraph, block 6", exact: true }).click();
		await page.keyboard.type("/");
		await page.getByRole("combobox", { name: "Blocks", exact: true }).fill("map");
		await page.getByRole("option", { name: "Map embed", exact: true }).click();
		await page.getByRole("textbox", { name: /Map title/ }).waitFor();
		await expectNoAxeViolations(page, `Extra blocks Props ${theme}`);
		await page.keyboard.press("Escape");
		await page.close();
	});
}

for (const theme of THEMES) {
	test(`Edit and Safe modes use the permitted Block catalogue without enhancement (${theme})`, async () => {
		const page = await install.newPage(theme);
		const requests: string[] = [];
		page.on("request", (request) => requests.push(request.url()));
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site", exact: true }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.liveUrl("extra", "/")).hostname);
		await page.addInitScript(() => {
			window.localStorage.setItem("webcraft-edit-hint", "seen");
		});
		await page.goto(install.liveUrl("extra", path));
		await page.locator("webcraft-edit-bar").waitFor({ state: "attached" });
		expect(await page.locator('script[data-wc-module="extra-blocks"]').count()).toBe(0);
		expect(await page.getByRole("tab").count()).toBe(0);
		expect(await page.locator("iframe").count()).toBe(0);
		const paragraph = page.locator('[data-wc-type="body"] p[contenteditable]').last();
		await paragraph.click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.press("/");
		await page.getByRole("dialog", { name: "Blocks", exact: true }).waitFor();
		await page.getByRole("combobox", { name: "Blocks", exact: true }).fill("map");
		await page.keyboard.press("Enter");
		const props = page.getByRole("dialog", { name: "Map embed: Props", exact: true });
		await props.waitFor();
		await expectNoAxeViolations(page, `Extra blocks Edit Props ${theme}`, ["region"]);
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: /: Edit mode menu$/ }).click();
		await page.getByRole("menuitem", { name: "Edit in Safe mode", exact: true }).click();
		await page.getByText("Safe mode", { exact: true }).waitFor();
		expect(await page.locator('script[data-wc-module="extra-blocks"]').count()).toBe(0);
		expect(await page.locator("iframe").count()).toBe(0);
		await expectNoAxeViolations(page, `Extra blocks Safe mode ${theme}`);
		expect(requests.some((url) => url.includes("openstreetmap.org"))).toBe(false);
		await page.close();
	});
}
