import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let otherSite: string;
let id: string;
let postTypeId: string;
let entryId: string;
const rules = {
	paths: [],
	postTypeIds: [],
	entryIds: [],
	languages: [],
	devices: ["phone", "desktop"],
	visitors: "all",
};
const page = "https://targeted.live.test/news/welcome";
beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	const ws = await install.createWorkspace();
	siteId = (await install.createSite(ws.id, { slug: "targeted" })).id;
	otherSite = (await install.createSite(ws.id, { slug: "other" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [ws.id] })).browser;
	owner = (await install.createMember({ workspaceId: ws.id, role: "owner" })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	const { popup } = await staff.api.popups.create({ siteId, name: "Sale", key: "sale" });
	id = popup.id;
	await staff.api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>{{ props.text }}</p>" });
	await staff.api.popups.saveContent({
		siteId,
		popupId: id,
		values: { title: "Sale", text: "A seasonal offer", enabled: true },
	});
	await staff.api.popups.publish({ siteId, popupId: id });
	await staff.api.popups.publishContent({ siteId, popupId: id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "News",
		urlPattern: "/news/{slug}",
		fields: [],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId,
		title: "Welcome",
		slug: "welcome",
		fields: {},
	});
	entryId = entry.id;
	await staff.api.entries.saveDraft({
		siteId,
		entryId,
		language: "it",
		title: "Benvenuti",
		slug: "welcome",
		fields: {},
	});
	await staff.api.entries.publish({ siteId, entryId });
});
afterAll(async () => {
	await install.close();
});
async function visible(url = page) {
	return (await expectSafePage(await install.request(url))).includes("data-wc-popup=");
}
async function settings(change: Record<string, unknown>) {
	await staff.api.popups.saveDraft({ siteId, popupId: id, popup: { rules: { ...rules, ...change } } });
	await staff.api.popups.publish({ siteId, popupId: id });
}
test("path, Post Type, Entry and language rules intersect and survive publishing", async () => {
	await settings({ paths: ["/elsewhere"] });
	expect(await visible()).toBe(false);
	await settings({ paths: ["/it/news/*"], postTypeIds: [postTypeId], entryIds: [entryId], languages: ["it"] });
	expect(await visible()).toBe(false);
	expect(await visible(page.replace("/news/", "/it/news/"))).toBe(true);
	await settings({});
	expect(await visible()).toBe(true);
});
test("scheduled Content dates bound cached output and drafts stay private", async () => {
	await settings({});
	const start = new Date(install.clock.now().getTime() + 60_000).toISOString();
	const end = new Date(install.clock.now().getTime() + 120_000).toISOString();
	await owner.api.popups.saveContent({ siteId, popupId: id, values: { start, end } });
	expect(await visible()).toBe(true);
	await owner.api.popups.publishContent({ siteId, popupId: id });
	expect(await visible()).toBe(false);
	install.clock.advance(60_000);
	expect(await visible()).toBe(true);
	install.clock.advance(60_000);
	expect(await visible()).toBe(false);
	await owner.api.popups.saveContent({ siteId, popupId: id, values: { start: null, end: null } });
	await owner.api.popups.publishContent({ siteId, popupId: id });
});
test("translations fall back per value and publish separately", async () => {
	await settings({});
	await owner.api.popups.saveContent({ siteId, popupId: id, values: { start: null, end: null } });
	await owner.api.popups.publishContent({ siteId, popupId: id });
	await owner.api.popups.saveContent({ siteId, popupId: id, language: "it", values: { title: "Saldi" } });
	let html = await expectSafePage(await install.request(page.replace("/news/", "/it/news/")));
	expect(html).not.toContain("Saldi");
	await owner.api.popups.publishContent({ siteId, popupId: id });
	html = await expectSafePage(await install.request(page.replace("/news/", "/it/news/")));
	expect(html).toContain("Saldi");
	expect(html).toContain("A seasonal offer");
});
test("every Trigger and frequency can be saved; unknown targeting and other-Site ids are refused", async () => {
	for (const trigger of [
		{ kind: "load" },
		{ kind: "delay", seconds: 4 },
		{ kind: "scroll", percent: 50 },
		{ kind: "element", selector: "#offer" },
		{ kind: "exit" },
		{ kind: "idle", seconds: 10 },
		{ kind: "click" },
	] as const) {
		const { popup } = await staff.api.popups.saveDraft({
			siteId,
			popupId: id,
			popup: { trigger, frequency: { kind: "interval", days: 2 } },
		});
		expect(popup.draft.trigger).toEqual(trigger);
		expect(popup.draft.frequency).toEqual({ kind: "interval", days: 2 });
		expect(popup.checks.length).toBe(trigger.kind === "load" || trigger.kind === "delay" ? 1 : 0);
	}
	await expect(staff.api.popups.get({ siteId: otherSite, popupId: id })).rejects.toMatchObject({
		code: "POPUP_NOT_FOUND",
	});
	const { entry } = await staff.api.entries.create({
		siteId: otherSite,
		postTypeId: (await staff.api.postTypes.list({ siteId: otherSite })).postTypes[0]?.id ?? "",
		title: "Other",
		fields: {},
	});
	await expect(
		staff.api.popups.saveDraft({ siteId, popupId: id, popup: { rules: { ...rules, entryIds: [entry.id] } } }),
	).rejects.toMatchObject({ code: "POPUP_INVALID" });
});
test("history, Publish all and Scheduled publish expose Content independently", async () => {
	await owner.api.popups.saveContent({ siteId, popupId: id, values: { title: "Frozen" } });
	const list = await owner.api.publishing.drafts({ siteId });
	expect(JSON.stringify(list)).toContain("popupContent");
	const at = new Date(install.clock.now().getTime() + 60_000).toISOString();
	await owner.api.publishing.schedule({ siteId, item: { kind: "popupContent", id }, at });
	await owner.api.popups.saveContent({ siteId, popupId: id, values: { title: "Later draft" } });
	install.clock.advance(60_000);
	await install.drainJobs();
	const saved = await owner.api.popups.get({ siteId, popupId: id });
	expect(saved.content.published?.values.title).toBe("Frozen");
	expect(saved.content.draft.values.title).toBe("Later draft");
	const history = await owner.api.history.list({ siteId, item: { kind: "popupContent", id } });
	expect(history.copies.length).toBeGreaterThan(0);
});

test("early phone warnings use the shared Checks collection without blocking publishing", async () => {
	await staff.api.popups.saveDraft({
		siteId,
		popupId: id,
		popup: { trigger: { kind: "delay", seconds: 4 }, rules, additionalTriggers: [] },
	});
	await staff.api.popups.publish({ siteId, popupId: id });
	const { checks } = await staff.api.checks.list({ siteId });
	expect(checks).toContainEqual(
		expect.objectContaining({
			check: "popupPhoneEarly",
			at: "trigger",
			item: { kind: "popup", id, name: "Sale" },
			href: `/sites/${siteId}/popups?popup=${id}`,
		}),
	);
	expect((await owner.api.checks.list({ siteId })).checks.some((c) => c.check === "popupPhoneEarly")).toBe(false);
	for (const popup of [
		{ trigger: { kind: "delay", seconds: 5 }, rules },
		{ trigger: { kind: "load" }, rules: { ...rules, devices: ["desktop"] } },
	]) {
		const saved = await staff.api.popups.saveDraft({ siteId, popupId: id, popup });
		expect(saved.popup.checks).toEqual([]);
	}
	const saved = await staff.api.popups.saveDraft({
		siteId,
		popupId: id,
		popup: { trigger: { kind: "click" }, rules, additionalTriggers: [{ kind: "load" }] },
	});
	expect(saved.popup.checks).toEqual([{ check: "popupPhoneEarly", at: "trigger" }]);
});

test("exclusions override includes, while a Popup command attaches regardless of Display rules", async () => {
	await settings({ paths: ["/news/*"], excludePaths: ["/news/welcome"] });
	expect(await visible()).toBe(false);
	await settings({ excludePostTypeIds: [postTypeId] });
	expect(await visible()).toBe(false);
	await settings({ excludeEntryIds: [entryId] });
	expect(await visible()).toBe(false);
	await expect(
		staff.api.popups.saveDraft({
			siteId,
			popupId: id,
			popup: { rules: { ...rules, referrer: "https://example.test" } },
		}),
	).rejects.toMatchObject({ code: "POPUP_INVALID" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<h1>{{ title }}</h1><p>{{@popup sale}}</p>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	expect(await visible()).toBe(true);
	await owner.api.popups.saveContent({ siteId, popupId: id, values: { enabled: false } });
	await owner.api.popups.publishContent({ siteId, popupId: id });
	expect(await visible()).toBe(false);
});

test("a Template attachment bypassing phone targeting still raises the ordinary phone Check", async () => {
	await staff.api.popups.saveDraft({
		siteId,
		popupId: id,
		popup: { trigger: { kind: "load" }, additionalTriggers: [], rules: { ...rules, devices: ["desktop"] } },
	});
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<h1>{{ title }}</h1>{{@popup sale}}",
	});
	expect((await staff.api.popups.get({ siteId, popupId: id })).popup.checks).toEqual([
		{ check: "popupPhoneEarly", at: "trigger" },
	]);
	expect((await staff.api.checks.list({ siteId })).checks).toContainEqual(
		expect.objectContaining({ check: "popupPhoneEarly", item: { kind: "popup", id, name: "Sale" } }),
	);
});
