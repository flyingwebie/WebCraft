import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let sequence = 0;
beforeAll(async () => {
	install = await startBrowserInstall({ backForwardCache: true });
	await (await install.install.superadmin()).api.modules.approve({ moduleId: "popups", version: "1.0.0" });
});
afterAll(async () => {
	await install.close();
});

for (const theme of THEMES)
	test(`Back restores Popup links and automatic push Bars from the browser cache (${theme})`, async () => {
		const { api } = await install.install.superadmin();
		const workspace = await install.install.createWorkspace();
		const slug = `popup-navigation-${++sequence}`;
		const siteId = (await install.install.createSite(workspace.id, { slug })).id;
		for (const name of ["Offer", "Notice"]) {
			const { popup } = await api.popups.create({ siteId, name, key: name.toLowerCase() });
			await api.popups.saveDraft({
				siteId,
				popupId: popup.id,
				popup:
					name === "Offer"
						? { trigger: { kind: "click" } }
						: { layout: "bar", barPosition: "top", barBehavior: "push", trigger: { kind: "load" } },
			});
			await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: name, enabled: true } });
			await api.popups.publish({ siteId, popupId: popup.id });
			await api.popups.publishContent({ siteId, popupId: popup.id });
		}
		const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
		const { template } = await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<h1>{{ title }}</h1>{{@popup offer}}<a href="/offers/today?next=1">Next page</a>',
		});
		await api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "today" });
		await api.entries.publish({ siteId, entryId: entry.id });
		await install.goLive(siteId);
		const page = await install.newPage(theme);
		// Observe the browser's real restoration event: a reload must not make this test pass.
		await page.addInitScript(() => {
			window.addEventListener("pageshow", (event) => {
				const root = document.documentElement;
				root.dataset.cacheRestores = event.persisted ? String(Number(root.dataset.cacheRestores ?? 0) + 1) : "0";
			});
		});
		const url = install.liveUrl(slug, "/offers/today");
		await page.goto(url);
		const notice = page.getByRole("dialog", { name: "Notice", exact: true });
		await notice.waitFor();
		const initialHeading = await page.getByRole("heading", { name: "Offers", exact: true }).boundingBox();
		for (let restores = 1; restores <= 2; restores++) {
			await page.getByRole("link", { name: "Next page", exact: true }).click();
			await page.waitForURL(/next=1$/);
			// Restored documents do not fire another load event.
			await page.goBack({ waitUntil: "commit" });
			await page.waitForFunction((count) => document.documentElement.dataset.cacheRestores === String(count), restores);
			await page.getByRole("link", { name: "Offer", exact: true }).click();
			const offer = page.getByRole("dialog", { name: "Offer", exact: true });
			await offer.waitFor({ timeout: 5000 });
			expect(page.url()).toBe(url);
			await page.keyboard.press("Escape");
			await offer.waitFor({ state: "detached" });
			await notice.waitFor({ timeout: 5000 });
			expect(await page.getByRole("dialog", { name: "Notice", exact: true }).count()).toBe(1);
			expect(await page.getByRole("heading", { name: "Offers", exact: true }).boundingBox()).toEqual(initialHeading);
			await expectNoAxeViolations(page, `Popups after cached restoration ${restores} ${theme}`);
		}
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
