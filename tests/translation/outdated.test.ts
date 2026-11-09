// Values a person wrote are never overwritten by AI translation (GLOSSARY.md › Outdated translation):
// when their Default-language source changes, they become Outdated translations, shown in the Entry
// editor next to the old and the new source, until someone updates or confirms them. A Body field
// keeps this per Block (ADR 0018): a hand-edited paragraph is Outdated on its own, and the rest of
// the article stays free to be translated again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { freshBread, type TranslatedSite, translatedSite } from "./support.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

type Block = { id: string; type: string; text: { text: string }[]; source?: { id: string; by: string } };

async function italian(site: TranslatedSite, entryId: string) {
	return (await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" })).entry;
}

async function translateNow(site: TranslatedSite) {
	await site.owner.api.translations.translateNow({ siteId: site.siteId });
	expect((await install.drainJobs()).failed).toEqual([]);
}

describe("a value a person wrote", () => {
	test("is never overwritten; once its source changes it is Outdated, shown next to the old and the new source", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		await site.editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "it",
			fields: { summary: "Pasta madre croccante" },
		});
		await translateNow(site);
		const before = await italian(site, entryId);
		expect(before.draft.fields.summary).toBe("Pasta madre croccante");
		expect(before.translation?.outdated).toEqual([]);

		await site.owner.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			fields: { summary: "Crusty rye sourdough" },
		});
		await translateNow(site);
		const after = await italian(site, entryId);
		expect(after.draft.fields.summary).toBe("Pasta madre croccante");
		expect(after.translation?.outdated).toEqual([
			{
				at: "fields.summary",
				block: null,
				labels: ["Summary"],
				translation: "Pasta madre croccante",
				oldSource: "Crusty sourdough",
				newSource: "Crusty rye sourdough",
			},
		]);
		const { lines } = await site.editor.api.translations.queue({ siteId: site.siteId, language: "it" });
		expect(lines).toContainEqual(
			expect.objectContaining({
				at: "fields.summary",
				status: "outdated",
				writtenBy: expect.objectContaining({ kind: "person", name: expect.any(String) }),
				oldSource: "Crusty sourdough",
				source: "Crusty rye sourdough",
			}),
		);
	});

	test("confirming it ends Outdated; updating it does too", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		await site.editor.api.entries.saveDraft({ siteId: site.siteId, entryId, language: "it", title: "Pane fresco" });
		await site.owner.api.entries.saveDraft({ siteId: site.siteId, entryId, title: "Fresh bread daily" });
		expect((await italian(site, entryId)).translation?.outdated.map((found) => found.at)).toEqual(["title"]);

		await site.editor.api.translations.confirm({
			siteId: site.siteId,
			item: { kind: "entry", id: entryId },
			language: "it",
			at: "title",
		});
		expect((await italian(site, entryId)).translation?.outdated).toEqual([]);

		await site.owner.api.entries.saveDraft({ siteId: site.siteId, entryId, title: "Fresh bread, daily" });
		expect((await italian(site, entryId)).translation?.outdated).toHaveLength(1);
		await site.editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "it",
			title: "Pane fresco, ogni giorno",
		});
		expect((await italian(site, entryId)).translation?.outdated).toEqual([]);
	});

	test("Re-translate asks the AI again, replacing it on purpose", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		await site.editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "it",
			fields: { summary: "Vecchia" },
		});
		await site.editor.api.translations.retranslate({
			siteId: site.siteId,
			item: { kind: "entry", id: entryId },
			language: "it",
			at: "fields.summary",
		});
		const entry = await italian(site, entryId);
		expect(entry.draft.fields.summary).toBe("[it] Crusty sourdough");
		expect(entry.translation?.aiWritten).toContain("fields.summary");
	});

	test("an AI translation whose source changed is written again; a person's in Automatic mode stays live", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		const entryId = await freshBread(site);
		await site.editor.api.entries.saveDraft({ siteId: site.siteId, entryId, language: "de", title: "Frisches Brot" });
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await install.drainJobs();

		await site.owner.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			title: "Fresh breads",
			fields: { summary: "Crusty rye" },
		});
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await install.drainJobs();
		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "de" });
		expect(entry.published?.title).toBe("Frisches Brot");
		expect(entry.published?.fields.summary).toBe("[de] Crusty rye");
		expect(entry.translation?.outdated.map((found) => found.at)).toEqual(["title"]);
	});
});

describe("a body, Block by Block", () => {
	test("a paragraph a person edited stays and is Outdated on its own; the others are translated again", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		await translateNow(site);
		const translated = (await italian(site, entryId)).draft.fields.body as Block[];
		expect(translated.map((block) => block.source)).toEqual([
			expect.objectContaining({ id: "p1", by: "ai" }),
			expect.objectContaining({ id: "p2", by: "ai" }),
		]);

		// A person rewrites the first paragraph of the Italian body, keeping the second as the AI wrote it.
		await site.editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "it",
			fields: { body: [{ ...translated[0], text: "Le nostre pagnotte lievitano di notte." }, translated[1]] },
		});
		expect(((await italian(site, entryId)).draft.fields.body as Block[])[0]?.source).toMatchObject({
			id: "p1",
			by: "person",
		});

		await site.owner.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			fields: {
				body: [
					{ id: "p1", type: "paragraph", text: "Our loaves rise for two nights." },
					{ id: "p2", type: "paragraph", text: "Bake at 230 °C." },
					{ id: "p3", type: "paragraph", text: "Enjoy them warm." },
				],
			},
		});
		await translateNow(site);

		const entry = await italian(site, entryId);
		const body = entry.draft.fields.body as Block[];
		expect(body.map((block) => block.text)).toEqual([
			[{ text: "Le nostre pagnotte lievitano di notte." }],
			[{ text: "[it] Bake at 230 °C." }],
			[{ text: "[it] Enjoy them warm." }],
		]);
		expect(entry.translation?.outdated).toEqual([
			{
				at: "fields.body",
				block: body[0]?.id ?? "",
				labels: ["Body"],
				translation: "Le nostre pagnotte lievitano di notte.",
				oldSource: "Our loaves rise overnight.",
				newSource: "Our loaves rise for two nights.",
			},
		]);

		await site.editor.api.translations.confirm({
			siteId: site.siteId,
			item: { kind: "entry", id: entryId },
			language: "it",
			at: "fields.body",
			block: body[0]?.id,
		});
		expect((await italian(site, entryId)).translation?.outdated).toEqual([]);
	});

	test("the editor's untouched copy of the Default language's Blocks is translated; a person's own Block stays", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		// The block editor starts a translation from the Default language's Blocks, with their ids.
		await site.editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "it",
			fields: {
				body: [
					{ id: "p1", type: "paragraph", text: "Our loaves rise overnight." },
					{ id: "mine", type: "paragraph", text: "Solo in Italia: il pane del giovedì." },
					{ id: "p2", type: "paragraph", text: [{ text: "Bake at " }, { text: "220 °C", marks: ["bold"] }] },
				],
			},
		});
		await translateNow(site);
		const body = (await italian(site, entryId)).draft.fields.body as Block[];
		expect(body.map((block) => block.text[0]?.text)).toEqual([
			"[it] Our loaves rise overnight.",
			"Solo in Italia: il pane del giovedì.",
			"[it] Bake at ",
		]);
	});
});
