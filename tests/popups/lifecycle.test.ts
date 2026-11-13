import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { openDraft } from "../harness/co-editing.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let owner: TestBrowser;
let siteId: string;
beforeAll(async () => {
	install = await createTestInstall();
});
beforeEach(async () => {
	const workspace = await install.createWorkspace();
	siteId = (await install.createSite(workspace.id)).id;
	staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	author = (await install.createMember({ workspaceId: workspace.id, role: "author" })).browser;
	owner = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser;
});
afterAll(async () => {
	await install.close();
});
test("Staff build a Popup; Members change and publish its Content independently", async () => {
	const { popup } = await staff.api.popups.create({ siteId, name: "Summer offer", key: "summer" });
	await staff.api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: { layout: "slide-in", trigger: { kind: "delay", seconds: 8 } },
	});
	await expect(
		owner.api.popups.saveDraft({ siteId, popupId: popup.id, popup: { layout: "bar" } }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await author.api.popups.saveContent({
		siteId,
		popupId: popup.id,
		language: "en",
		values: { title: "Summer savings", enabled: true },
	});
	await expect(author.api.popups.publishContent({ siteId, popupId: popup.id })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await staff.api.popups.publish({ siteId, popupId: popup.id });
	await owner.api.popups.publishContent({ siteId, popupId: popup.id });
	const saved = await owner.api.popups.get({ siteId, popupId: popup.id });
	expect(saved.popup.published?.layout).toBe("slide-in");
	expect(saved.content.published?.values.title).toBe("Summer savings");
	expect(saved.content.published?.values.enabled).toBe(true);
	await author.api.popups.saveContent({ siteId, popupId: popup.id, language: "en", values: { enabled: false } });
	expect((await owner.api.popups.get({ siteId, popupId: popup.id })).content.published?.values.enabled).toBe(true);
});

test("Authors submit Popup Content for Review and two editors keep each other's changes", async () => {
	const { popup } = await staff.api.popups.create({ siteId, name: "Reviewed offer", key: "reviewed" });
	await author.api.popups.saveContent({
		siteId,
		popupId: popup.id,
		values: { title: "Author's offer", enabled: true },
	});
	const { reviews } = await author.api.reviews.submit({
		siteId,
		items: [{ kind: "popupContent", id: popup.id }],
		note: "Ready for next week",
	});
	expect(reviews[0]).toMatchObject({
		item: { kind: "popupContent", id: popup.id },
		status: "inReview",
		name: "Reviewed offer",
	});
	expect((await owner.api.popups.get({ siteId, popupId: popup.id })).content.review?.status).toBe("inReview");
	const a = await openDraft(install, author, siteId, { kind: "popupContent", id: popup.id });
	const b = await openDraft(install, owner, siteId, { kind: "popupContent", id: popup.id });
	try {
		a.change((current) => ({
			...(current as Record<string, DocumentJson>),
			values: {
				...(current as { values: Record<string, DocumentJson> }).values,
				title: { en: "Edited together" },
			},
		}));
		await a.saved();
		await b.untilDraft((d) => JSON.stringify(d).includes("Edited together"), "the other editor's title");
		await owner.api.popups.saveContent({ siteId, popupId: popup.id, values: { text: "Separate text" } });
		await a.untilDraft((d) => JSON.stringify(d).includes("Separate text"), "API save mirrored to the open editor");
		const saved = await author.api.popups.get({ siteId, popupId: popup.id });
		expect(saved.content.draft.values).toMatchObject({ title: "Edited together", text: "Separate text" });
		expect(saved.content.review?.changedSinceSubmitted).toBe(true);
	} finally {
		a.close();
		b.close();
	}
	await owner.api.popups.publishContent({ siteId, popupId: popup.id });
	expect((await owner.api.popups.get({ siteId, popupId: popup.id })).content.review).toBeNull();
});

test("Default language changes preserve shared Popup Content and both versions", async () => {
	await staff.api.languages.add({ siteId, code: "it" });
	const { popup } = await staff.api.popups.create({ siteId, name: "Dates", key: "dates" });
	const start = "2030-05-01T09:00:00Z";
	const end = "2030-05-31T09:00:00Z";
	await owner.api.popups.saveContent({
		siteId,
		popupId: popup.id,
		values: { title: "Offer", enabled: true, start, end },
	});
	await owner.api.popups.saveContent({ siteId, popupId: popup.id, language: "it", values: { title: "Offerta" } });
	await owner.api.popups.publishContent({ siteId, popupId: popup.id });
	const ask = await staff.api.languages.setDefault({ siteId, code: "it" });
	if (ask.changed) throw new Error("Expected preview");
	await staff.api.languages.setDefault({ siteId, code: "it", confirmation: ask.confirmation.id });
	const read = await owner.api.popups.get({ siteId, popupId: popup.id });
	expect(read.content.draft.values).toMatchObject({ title: "Offerta", enabled: true, start, end });
	expect(read.content.published?.values).toMatchObject({ enabled: true, start, end });
});

test("Popup API refuses other Workspaces, restricted Sites and other-Site Media", async () => {
	const { popup } = await staff.api.popups.create({ siteId, name: "Private", key: "private" });
	const ws = await install.createWorkspace();
	const foreign = (await install.createSite(ws.id)).id;
	const other = (await install.createStaff({ workspaces: [ws.id] })).browser;
	for (const call of [
		() => other.api.popups.get({ siteId, popupId: popup.id }),
		() => other.api.popups.saveContent({ siteId, popupId: popup.id, values: { enabled: false } }),
		() => staff.api.popups.get({ siteId: foreign, popupId: popup.id }),
	])
		await expect(call()).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	const denied = (await install.createMember({ workspaceId: ws.id, role: "owner", sites: [foreign] })).browser;
	await expect(denied.api.popups.list({ siteId })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	const { media } = await other.api.media.upload({
		siteId: foreign,
		file: upload(await photo({ width: 80, height: 80 }), "private.jpg"),
	});
	await expect(
		owner.api.popups.saveContent({ siteId, popupId: popup.id, values: { image: media.id } }),
	).rejects.toMatchObject({ code: "POPUP_INVALID" });
});

test("a Popup publishes its own tree and settings atomically; a Scheduled publish freezes both", async () => {
	const { popup } = await staff.api.popups.create({ siteId, name: "Atomic", key: "atomic" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: "<p>Original structure</p>",
	});
	await staff.api.popups.publish({ siteId, popupId: popup.id });
	expect((await staff.api.components.getMarkup({ siteId, componentId: popup.componentId })).markup.published).toContain(
		"Original structure",
	);
	await staff.api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Frozen structure</p>" });
	await staff.api.popups.saveDraft({ siteId, popupId: popup.id, popup: { layout: "bar" } });
	const drafts = await staff.api.publishing.drafts({ siteId });
	expect(JSON.stringify(drafts)).toContain(popup.id);
	const at = new Date(install.clock.now().getTime() + 60_000).toISOString();
	await staff.api.publishing.schedule({ siteId, item: { kind: "popup", id: popup.id }, at });
	await staff.api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Later structure</p>" });
	await staff.api.popups.saveDraft({ siteId, popupId: popup.id, popup: { layout: "modal" } });
	install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);
	const markup = await staff.api.components.getMarkup({ siteId, componentId: popup.componentId });
	expect(markup.markup.published).toContain("Frozen structure");
	expect(markup.markup.draft).toContain("Later structure");
	const current = await staff.api.popups.get({ siteId, popupId: popup.id });
	expect(current.popup.published?.layout).toBe("bar");
	expect(current.popup.draft.layout).toBe("modal");
	expect(current.popup.status).toBe("changed");
	const history = await staff.api.history.list({ siteId, item: { kind: "popup", id: popup.id } });
	const revision = history.copies.find((copy) => copy.type === "revision");
	if (!revision) throw new Error("Popup revision missing");
	await staff.api.history.restore({
		siteId,
		item: { kind: "popup", id: popup.id },
		copy: { type: "revision", id: revision.id },
	});
	expect((await staff.api.components.getMarkup({ siteId, componentId: popup.componentId })).markup.draft).toContain(
		"Frozen structure",
	);
});

test("publishing a Popup tells its Component editors and supersedes its older schedule", async () => {
	const { popup } = await staff.api.popups.create({ siteId, name: "Publication", key: "publication" });
	await staff.api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Earlier tree</p>" });
	await staff.api.publishing.schedule({
		siteId,
		item: { kind: "popup", id: popup.id },
		at: new Date(install.clock.now().getTime() + 60_000).toISOString(),
	});
	await staff.api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Current tree</p>" });
	const editor = await openDraft(install, staff, siteId, { kind: "component", id: popup.componentId });
	try {
		await staff.api.popups.publish({ siteId, popupId: popup.id });
		await editor.until(
			() => editor.messages.some((m) => m.type === "published"),
			"the Component's publish notification",
		);
		expect((await staff.api.publishing.scheduled({ siteId })).scheduled).toEqual([]);
		install.clock.advance(60_000);
		await install.drainJobs();
		expect(
			(await staff.api.components.getMarkup({ siteId, componentId: popup.componentId })).markup.published,
		).toContain("Current tree");
	} finally {
		editor.close();
	}
});

test("creating a Popup keeps its Component name valid and avoids existing Component names", async () => {
	const { component: existing } = await staff.api.components.create({ siteId, name: "PopupCoexist" });
	await staff.api.components.saveMarkup({ siteId, componentId: existing.id, markup: "<p>Keep this Component</p>" });
	const { popup: first } = await staff.api.popups.create({ siteId, name: "Coexist", key: "coexist" });
	expect(first.componentId).not.toBe(existing.id);
	expect((await staff.api.components.getMarkup({ siteId, componentId: existing.id })).markup.draft).toContain(
		"Keep this Component",
	);
	const { popup: longKey } = await staff.api.popups.create({ siteId, name: "Long key", key: "a".repeat(80) });
	const { popup: longName } = await staff.api.popups.create({ siteId, name: "B".repeat(120) });
	for (const popup of [first, longKey, longName]) {
		const { component } = await staff.api.components.get({ siteId, componentId: popup.componentId });
		expect(component.name.length).toBeLessThanOrEqual(64);
		expect(popup.key.length).toBeLessThanOrEqual(80);
	}
});
