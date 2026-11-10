import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { translatedSite } from "../translation/support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
test("Popup Content uses Automatic and Review translation without overwriting a person", async () => {
	const site = await translatedSite(install, { it: "review", de: "automatic" });
	const siteId = site.siteId;
	const { popup } = await site.staff.api.popups.create({ siteId, name: "Seasonal offer", key: "seasonal" });
	const popupId = popup.id;
	await site.owner.api.popups.saveContent({
		siteId,
		popupId,
		values: { title: "Spring offer", text: "Fresh every morning", enabled: true },
	});
	await site.owner.api.popups.publishContent({ siteId, popupId });
	expect((await install.drainJobs()).failed).toEqual([]);
	const italian = await site.owner.api.popups.get({ siteId, popupId, language: "it" });
	const german = await site.owner.api.popups.get({ siteId, popupId, language: "de" });
	expect(italian.content.draft.values.title).toBe("[it] Spring offer");
	expect(italian.content.published?.values.title).toBe("Spring offer");
	expect(german.content.published?.values.title).toBe("[de] Spring offer");
	expect(
		(await site.editor.api.translations.queue({ siteId, language: "it" })).lines.some(
			(line) => line.item.kind === "popupContent" && line.item.id === popupId,
		),
	).toBe(true);
	await site.editor.api.translations.approve({
		siteId,
		language: "it",
		items: [{ kind: "popupContent", id: popupId }],
	});
	expect((await site.editor.api.popups.get({ siteId, popupId, language: "it" })).content.published?.values.title).toBe(
		"[it] Spring offer",
	);
	await site.editor.api.popups.saveContent({
		siteId,
		popupId,
		language: "it",
		values: { title: "Offerta di primavera" },
	});
	await site.owner.api.popups.saveContent({ siteId, popupId, values: { title: "Summer offer" } });
	await site.owner.api.popups.publishContent({ siteId, popupId });
	expect((await install.drainJobs()).failed).toEqual([]);
	expect((await site.editor.api.popups.get({ siteId, popupId, language: "it" })).content.draft.values.title).toBe(
		"Offerta di primavera",
	);
	const queue = await site.editor.api.translations.queue({ siteId, language: "it" });
	expect(queue.lines.find((line) => line.item.id === popupId)?.status).toBe("outdated");
});
