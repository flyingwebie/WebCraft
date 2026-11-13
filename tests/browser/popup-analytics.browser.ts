import { afterAll, beforeAll, expect, test } from "bun:test";
import { analyticsApi, type CollectedEvent, DESKTOP_CHROME, dayOf } from "../harness/analytics.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let sequence = 0;
beforeAll(async () => {
	install = await startBrowserInstall();
	const { api } = await install.install.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	await api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
});
afterAll(async () => {
	await install.close();
});

async function scene(options: { analytics: boolean; enabled: boolean }) {
	const admin = await install.install.superadmin();
	const { api } = admin;
	const workspace = await install.install.createWorkspace();
	const slug = `popup-analytics-${++sequence}`;
	const siteId = (await install.install.createSite(workspace.id, { slug })).id;
	await api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: options.analytics });
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: '<p>Offer details.</p><a id="confirm" href="#details">Continue</a>',
	});
	await api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: { trigger: { kind: "load" }, mainButton: "#confirm" },
	});
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Offer", enabled: options.enabled } });
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<h1>{{ title }}</h1><p id="details">Details</p>',
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "today" });
	await api.entries.publish({ siteId, entryId: entry.id });
	await install.goLive(siteId);
	return { admin, siteId, popupId: popup.id, url: install.liveUrl(slug, "/offers/today") };
}

test("stored Analytics consent records an on-load Popup's shown, main-button and close events exactly once", async () => {
	const fixture = await scene({ analytics: true, enabled: false });
	const page = await install.newPage("light");
	// Analytics deliberately excludes automated user agents; visit as an ordinary browser.
	await page.setExtraHTTPHeaders({ "user-agent": DESKTOP_CHROME });
	const events: CollectedEvent[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith("/_wc/m/analytics/event")) events.push(request.postDataJSON() as CollectedEvent);
	});
	await page.goto(fixture.url);
	await page.waitForLoadState("networkidle");
	expect(events.filter((event) => event.t === "event")).toEqual([]);
	const recorded = page.waitForResponse(
		(response) => response.url().endsWith("/_wc/consent") && response.status() === 201,
	);
	await page.getByRole("button", { name: "Accept all", exact: true }).click();
	await recorded;
	await fixture.admin.api.popups.saveContent({
		siteId: fixture.siteId,
		popupId: fixture.popupId,
		values: { enabled: true },
	});
	await fixture.admin.api.popups.publishContent({ siteId: fixture.siteId, popupId: fixture.popupId });
	await page.reload();
	const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
	await dialog.waitFor();
	await dialog.getByRole("link", { name: "Continue", exact: true }).click();
	await page.keyboard.press("Escape");
	await dialog.waitFor({ state: "detached" });
	await page.waitForLoadState("networkidle");
	expect(events.filter((event) => event.t === "event").map((event) => event.n)).toEqual([
		"popup-shown:offer",
		"popup-clicked:offer",
		"popup-closed:offer",
	]);
	const totals = await analyticsApi(fixture.admin).stats.totals({ siteId: fixture.siteId, ...dayOf(new Date()) });
	expect(totals.totals.events).toBe(3);
	expect(pageErrors(page)).toEqual([]);
	await page.close();
});

for (const analytics of [false, true])
	test(`Popups work without collecting events when Analytics is ${analytics ? "refused" : "disabled"}`, async () => {
		const fixture = await scene({ analytics, enabled: true });
		const page = await install.newPage("dark");
		await page.setExtraHTTPHeaders({ "user-agent": DESKTOP_CHROME });
		const events: CollectedEvent[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/_wc/m/analytics/event")) events.push(request.postDataJSON() as CollectedEvent);
		});
		await page.goto(fixture.url);
		if (analytics) {
			await page.waitForLoadState("networkidle");
			expect(await page.getByRole("dialog", { name: "Offer", exact: true }).count()).toBe(0);
			const recorded = page.waitForResponse(
				(response) => response.url().endsWith("/_wc/consent") && response.status() === 201,
			);
			await page.getByRole("button", { name: "Reject all", exact: true }).click();
			await recorded;
		}
		const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
		await dialog.waitFor({ timeout: 5000 });
		await dialog.getByRole("link", { name: "Continue", exact: true }).click();
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		await page.reload();
		await dialog.waitFor({ timeout: 5000 });
		await page.waitForLoadState("networkidle");
		expect(events.filter((event) => event.t === "event")).toEqual([]);
		if (!analytics) expect(events).toEqual([]);
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
