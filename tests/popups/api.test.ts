import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
test("the Publishing toolset previews and confirms each Popup layer independently", async () => {
	const admin = await install.superadmin();
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id)).id;
	const { popup } = await admin.api.popups.create({ siteId, name: "Confirmed offer" });
	await admin.api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "An offer", enabled: true } });
	const { secret } = await createApiToken(admin, {
		workspaceId: workspace.id,
		name: "Popup publisher",
		toolsets: ["publishing"],
	});
	const { api } = tokenClient(install, secret);
	for (const kind of ["popup", "popupContent"] as const) {
		const publish = (confirmation?: string) =>
			kind === "popup"
				? api.popups.publish({ siteId, popupId: popup.id, confirmation })
				: api.popups.publishContent({ siteId, popupId: popup.id, confirmation });
		const first = (await publish()) as unknown as { confirmation: { id: string }; preview: { item: unknown } };
		expect(first.preview.item).toEqual({ kind, id: popup.id });
		const before = await admin.api.popups.get({ siteId, popupId: popup.id });
		expect(kind === "popup" ? before.popup.published : before.content.published).toBeNull();
		await publish(first.confirmation.id);
		const after = await admin.api.popups.get({ siteId, popupId: popup.id });
		expect(kind === "popup" ? after.popup.published : after.content.published).not.toBeNull();
		await expect(publish(first.confirmation.id)).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
	}
});
test("a public API client changes one Popup setting without resetting omitted settings", async () => {
	const admin = await install.superadmin();
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id)).id;
	const { popup } = await admin.api.popups.create({ siteId, name: "Partial updates" });
	await admin.api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: {
			trigger: { kind: "delay", seconds: 12 },
			frequency: { kind: "interval", days: 7 },
			autoCloseSeconds: 30,
			mainButton: "#offer-action",
		},
	});
	const { secret } = await createApiToken(admin, {
		workspaceId: workspace.id,
		name: "Popup settings",
		toolsets: ["structure"],
	});
	const { api } = tokenClient(install, secret);
	const changed = await api.popups.saveDraft({ siteId, popupId: popup.id, popup: { layout: "bar" } });
	expect(changed.popup.draft).toMatchObject({
		layout: "bar",
		trigger: { kind: "delay", seconds: 12 },
		frequency: { kind: "interval", days: 7 },
		autoCloseSeconds: 30,
		mainButton: "#offer-action",
	});
	const cleared = await api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: { autoCloseSeconds: null, mainButton: null },
	});
	expect(cleared.popup.draft).toMatchObject({
		layout: "bar",
		trigger: { kind: "delay", seconds: 12 },
		frequency: { kind: "interval", days: 7 },
		autoCloseSeconds: null,
		mainButton: null,
	});
	expect((await api.popups.get({ siteId, popupId: popup.id })).popup.draft).toEqual(cleared.popup.draft);
	expect((await api.popups.list({ siteId })).popups.map((p) => p.id)).toContain(popup.id);
});
