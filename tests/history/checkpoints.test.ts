// Checkpoints (GLOSSARY.md): an item's Draft, saved while it is edited, so a Draft that was changed or
// written over can be got back before it is published. One is saved after 10 minutes of activity (the
// first change once the newest saved copy is 10 minutes old saves the Draft as it was just before), when
// the last person editing it leaves, and before a restore; never when nothing changed since the last
// Revision or Checkpoint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HistoryItem } from "@webcraft/core";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { type HistorySite, historySite } from "./support.ts";

let install: TestInstall;
let site: HistorySite;

beforeAll(async () => {
	install = await createTestInstall();
	site = await historySite(install);
});

afterAll(async () => {
	await install.close();
});

const MINUTE = 60_000;

/** A Loop's query limit standing for each marker. */
const LIMITS: Record<string, number> = { one: 5, two: 6, three: 7 };

/** An item's history as `[type, reason, what it holds]`, newest first. */
async function historyOf(api: TestBrowser["api"], siteId: string, item: HistoryItem) {
	const { copies } = await api.history.list({ siteId, item });
	const shown = [];
	for (const copy of copies) {
		const { content } = await api.history.get({ siteId, item, copy: { type: copy.type, id: copy.id } });
		shown.push({ type: copy.type, reason: copy.reason, content: JSON.stringify(content) });
	}
	return shown;
}

describe("while a Draft is edited", () => {
	test("the first change after 10 minutes saves the Draft as it was just before, with who changed it last", async () => {
		const { siteId, postTypeId, editor, editorId, author } = site;
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "First title" });
		const item = { kind: "entry", id: entry.id } as const;
		expect((await editor.api.history.list({ siteId, item })).copies).toEqual([]);

		await install.clock.advance(MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Second title" });
		// Nothing was saved of it yet: the Draft as it was made is kept.
		let shown = await historyOf(editor.api, siteId, item);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatchObject({ type: "checkpoint", reason: "activity" });
		expect(shown[0]?.content).toContain("First title");

		await install.clock.advance(4 * MINUTE);
		await author.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Third title" });
		expect(await historyOf(editor.api, siteId, item)).toHaveLength(1);

		await install.clock.advance(7 * MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Fourth title" });
		shown = await historyOf(editor.api, siteId, item);
		expect(shown.map((copy) => copy.type)).toEqual(["checkpoint", "checkpoint"]);
		expect(shown[0]?.content).toContain("Third title");
		const { copies } = await editor.api.history.list({ siteId, item });
		expect(copies[0]?.by?.person?.name).toBe("Al Author");
		expect(copies[1]?.by?.person?.id).toBe(editorId);
	});

	test("nothing is saved when the Draft is what the newest Revision holds", async () => {
		const { siteId, postTypeId, editor } = site;
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Rye loaf" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const item = { kind: "entry", id: entry.id } as const;

		await install.clock.advance(30 * MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Rye loaf, sliced" });
		// The Draft before this change is the published version, already a Revision.
		expect((await historyOf(editor.api, siteId, item)).map((copy) => copy.type)).toEqual(["revision"]);
		// A save changing nothing changes nothing.
		await install.clock.advance(30 * MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Rye loaf, sliced" });
		expect((await historyOf(editor.api, siteId, item)).map((copy) => copy.type)).toEqual(["revision"]);
	});

	test("when the last person leaves, the Draft is saved, once", async () => {
		const { siteId, postTypeId, editor } = site;
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Spelt loaf" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const item = { kind: "entry", id: entry.id } as const;

		await install.clock.advance(MINUTE);
		await editor.api.history.leave({ siteId, item });
		expect((await historyOf(editor.api, siteId, item)).map((copy) => copy.type)).toEqual(["revision"]);

		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { summary: "Nutty" } });
		await install.clock.advance(MINUTE);
		await editor.api.history.leave({ siteId, item });
		await install.clock.advance(MINUTE);
		await editor.api.history.leave({ siteId, item });
		const shown = await historyOf(editor.api, siteId, item);
		expect(shown.map(({ type, reason }) => ({ type, reason }))).toEqual([
			{ type: "checkpoint", reason: "left" },
			{ type: "revision", reason: null },
		]);
		expect(shown[0]?.content).toContain("Nutty");
	});
});

describe("every kind of Draft", () => {
	test("is saved as a Checkpoint after 10 minutes of activity", async () => {
		const own = await historySite(install);
		const { siteId, staff } = own;
		const { component } = await staff.api.components.create({ siteId, name: "Notice" });
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "latest",
			source: "query",
			query: { postTypes: ["posts"] },
		});
		const { filter } = await staff.api.filters.create({
			siteId,
			name: "latest",
			loop: "latest",
			controls: [
				{ type: "sort", key: "sort", options: [{ value: "a-z", label: "A to Z", by: "title", direction: "asc" }] },
			],
		});
		const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")
			?.id as string;
		const page = (await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "About us" })).entry;

		/** Each kind of Draft, with a save that writes `marker` into it; the first save makes the item where it needs one. */
		const kinds: {
			name: string;
			save(marker: string): Promise<HistoryItem>;
			holds?(content: string, marker: string): boolean;
		}[] = [
			{
				name: "Globals",
				save: async (marker) => {
					await staff.api.globals.saveDraft({ siteId, fields: { phone: marker } });
					return { kind: "globals" };
				},
			},
			{
				name: "Consent banner",
				save: async (marker) => {
					await staff.api.consentBanner.saveDraft({ siteId, fields: { heading: marker } });
					return { kind: "consentBanner" };
				},
			},
			{
				name: "Design system",
				save: async (marker) => {
					await staff.api.designSystem.saveDraft({ siteId, customCss: `/* ${marker} */` });
					return { kind: "designSystem" };
				},
			},
			{
				name: "Component",
				save: async (marker) => {
					await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: `<p>${marker}</p>` });
					return { kind: "component", id: component.id };
				},
			},
			{
				name: "Template",
				save: async (marker) => {
					const { template } = await staff.api.templates.saveSiteTemplateMarkup({
						siteId,
						markup: `<header>${marker}</header><main>{{@outlet}}</main>`,
					});
					return { kind: "template", id: template.id };
				},
			},
			{
				name: "script",
				save: async (marker) => {
					const { script } = await staff.api.scripts.saveDraft({ siteId, entryId: null, code: `// ${marker}` });
					return { kind: "script", id: script.id };
				},
			},
			{
				name: "Loop",
				save: async (marker) => {
					await staff.api.loops.saveDraft({
						siteId,
						loopId: loop.id,
						query: { postTypes: ["posts"], limit: LIMITS[marker] },
					});
					return { kind: "loop", id: loop.id };
				},
				holds: (content, marker) => content.includes(`"limit":${LIMITS[marker]}`),
			},
			{
				name: "Filter",
				save: async (marker) => {
					await staff.api.filters.saveDraft({ siteId, filterId: filter.id, applyLabel: marker });
					return { kind: "filter", id: filter.id };
				},
			},
			{
				name: "Form",
				save: async (marker) => {
					await staff.api.forms.saveDraft({ siteId, formId: form.id, form: { submitLabel: marker } });
					return { kind: "form", id: form.id };
				},
			},
			{
				name: "Form's emails",
				save: async (marker) => {
					await staff.api.forms.saveEmails({
						siteId,
						formId: form.id,
						emails: {
							notifications: [{ recipients: ["orders@acmebakery.example"], routing: null, subject: marker, intro: "" }],
						},
					});
					return { kind: "formEmails", id: form.id };
				},
			},
			{
				name: "Page",
				save: async (marker) => {
					await staff.api.entries.saveDraft({ siteId, entryId: page.id, title: marker });
					return { kind: "entry", id: page.id };
				},
			},
		];
		for (const kind of kinds) {
			await kind.save("one");
			await install.clock.advance(MINUTE);
			const item = await kind.save("two");
			await install.clock.advance(11 * MINUTE);
			await kind.save("three");
			const shown = await historyOf(staff.api, siteId, item);
			expect({ kind: kind.name, newest: shown[0]?.type }).toEqual({ kind: kind.name, newest: "checkpoint" });
			const newest = shown[0]?.content ?? "";
			const holds = kind.holds ?? ((content: string, marker: string) => content.includes(marker));
			expect({ kind: kind.name, holdsTwo: holds(newest, "two"), holdsThree: holds(newest, "three") }).toEqual({
				kind: kind.name,
				holdsTwo: true,
				holdsThree: false,
			});
		}
	});
});
