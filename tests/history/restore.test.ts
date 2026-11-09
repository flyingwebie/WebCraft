// Restore (GLOSSARY.md › Revision): a Revision or Checkpoint copied back into the item's Draft. It never
// publishes; the Draft as it was is saved as a Checkpoint first, so a restore can itself be undone;
// anyone who may change the Draft may restore it; it goes in the Audit log. It is a change to the Draft
// like any other, checked as any save is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HistoryItem } from "@webcraft/core";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
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

/** The newest Revision of an item. */
async function newestRevision(api: TestBrowser["api"], siteId: string, item: HistoryItem) {
	const { copies } = await api.history.list({ siteId, item });
	const revision = copies.find((copy) => copy.type === "revision");
	if (!revision) throw new Error("No Revision");
	return revision;
}

describe("restoring a Revision", () => {
	test("copies it into the Draft, keeps the Draft as a Checkpoint first, publishes nothing and is logged", async () => {
		const { siteId, postTypeId, staff, editor, editorId } = site;
		const template = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		await staff.api.templates.publish({ siteId, templateId: template.template.id });
		const live = await goLive(install, siteId);
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Rye loaf", slug: "rye" });
		const item = { kind: "entry", id: entry.id } as const;
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const first = await newestRevision(editor.api, siteId, item);
		await install.clock.advance(MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Rye loaf, dark" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		await install.clock.advance(MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Rye loaf, half eaten" });

		await install.clock.advance(MINUTE);
		const restored = await editor.api.history.restore({ siteId, item, copy: { type: "revision", id: first.id } });
		expect(restored.restored).toMatchObject({ type: "revision", id: first.id });
		expect(restored.checkpoint).toMatchObject({ type: "checkpoint", reason: "restore" });

		const after = (await editor.api.entries.get({ siteId, entryId: entry.id })).entry;
		expect(after.draft.title).toBe("Rye loaf");
		// Nothing was published: visitors still see the last publish.
		expect(after.published?.title).toBe("Rye loaf, dark");
		expect(after.status).toBe("changed");
		expect(await (await install.request(`${live}/blog/rye`)).text()).toContain("Rye loaf, dark");

		// The Draft as it was is the newest Checkpoint, and can be restored in its turn.
		const { copies } = await editor.api.history.list({ siteId, item });
		expect(copies[0]).toMatchObject({ type: "checkpoint", reason: "restore", id: restored.checkpoint?.id });
		const kept = await editor.api.history.get({ siteId, item, copy: { type: "checkpoint", id: copies[0]?.id ?? "" } });
		expect(JSON.stringify(kept.content)).toContain("Rye loaf, half eaten");
		await editor.api.history.restore({ siteId, item, copy: { type: "checkpoint", id: copies[0]?.id ?? "" } });
		expect((await editor.api.entries.get({ siteId, entryId: entry.id })).entry.draft.title).toBe(
			"Rye loaf, half eaten",
		);

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 10 });
		const logged = entries.filter((each) => each.action === "draft.restore" && each.siteId === siteId);
		expect(logged[1]).toMatchObject({
			personId: editorId,
			details: {
				item: { kind: "entry", id: entry.id },
				from: { type: "revision", id: first.id },
			},
		});
	});

	test("compares as the same afterwards, and who restored it shows as who changed what it changed", async () => {
		const { siteId, postTypeId, editor, author, authorId } = site;
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Spelt loaf" });
		const item = { kind: "entry", id: entry.id } as const;
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const revision = await newestRevision(editor.api, siteId, item);
		await install.clock.advance(MINUTE);
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { summary: "Nutty" } });

		// An Author may change the Draft, so may restore it.
		await author.api.history.restore({ siteId, item, copy: { type: "revision", id: revision.id } });
		const comparison = await author.api.history.compare({ siteId, item, copy: { type: "revision", id: revision.id } });
		expect(comparison.changes).toBe(0);
		const { copies } = await author.api.history.list({ siteId, item });
		const checkpoint = copies.find((copy) => copy.reason === "restore");
		const back = await author.api.history.compare({
			siteId,
			item,
			copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
		});
		expect(back.parts.find((part) => part.key === "summary")).toMatchObject({
			changed: true,
			changedBy: { person: { id: authorId, name: "Al Author" } },
		});
	});

	test("needs what changing the Draft needs: Members may not restore Structure", async () => {
		const { siteId, staff, editor } = site;
		const { component } = await staff.api.components.create({ siteId, name: "Badge" });
		await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<b>New</b>" });
		await staff.api.components.publish({ siteId, componentId: component.id });
		const item = { kind: "component", id: component.id } as const;
		const revision = await newestRevision(staff.api, siteId, item);
		await expect(
			editor.api.history.restore({ siteId, item, copy: { type: "revision", id: revision.id } }),
		).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
		await expect(editor.api.history.list({ siteId, item })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("is checked as any save is: a Template placing a Component deleted since is refused, and nothing changes", async () => {
		const own = await historySite(install);
		const { siteId, staff } = own;
		const { component } = await staff.api.components.create({ siteId, name: "Banner" });
		await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<p>Sale</p>" });
		await staff.api.components.publish({ siteId, componentId: component.id });
		const { template } = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header><Banner /></header><main>{{@outlet}}</main>",
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const item = { kind: "template", id: template.id } as const;
		const revision = await newestRevision(staff.api, siteId, item);
		await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: "<header>Hi</header><main>{{@outlet}}</main>" });
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const deleting = await staff.api.components.delete({ siteId, componentId: component.id });
		await staff.api.components.delete({
			siteId,
			componentId: component.id,
			confirmation: (deleting as { confirmation: { id: string } }).confirmation.id,
		});
		const before = await staff.api.history.list({ siteId, item });

		await expect(
			staff.api.history.restore({ siteId, item, copy: { type: "revision", id: revision.id } }),
		).rejects.toMatchObject({ status: 400 });
		expect((await staff.api.history.list({ siteId, item })).copies).toEqual(before.copies);
	});
});

describe("every kind of item", () => {
	test("gets its Draft back from a Revision", async () => {
		const own = await historySite(install);
		const { siteId, staff } = own;
		const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")
			?.id as string;
		const page = (await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "About us" })).entry;
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		const { component } = await staff.api.components.create({ siteId, name: "Notice" });
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "latest",
			source: "query",
			query: { postTypes: ["posts"] },
		});
		await staff.api.loops.publish({ siteId, loopId: loop.id });
		const { filter } = await staff.api.filters.create({
			siteId,
			name: "latest",
			loop: "latest",
			controls: [
				{ type: "sort", key: "sort", options: [{ value: "a-z", label: "A to Z", by: "title", direction: "asc" }] },
			],
		});
		const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });

		/** Each kind: a save writing `marker` into its Draft, and its publish. */
		const kinds: {
			name: string;
			save(marker: string): Promise<HistoryItem>;
			publish(item: HistoryItem): Promise<unknown>;
		}[] = [
			{
				name: "Page",
				save: async (marker) => {
					await staff.api.entries.saveDraft({ siteId, entryId: page.id, title: marker });
					return { kind: "entry", id: page.id };
				},
				publish: () => staff.api.entries.publish({ siteId, entryId: page.id }),
			},
			{
				name: "Globals",
				save: async (marker) => {
					await staff.api.globals.saveDraft({ siteId, fields: { phone: marker } });
					return { kind: "globals" };
				},
				publish: () => staff.api.globals.publish({ siteId }),
			},
			{
				name: "Consent banner",
				save: async (marker) => {
					await staff.api.consentBanner.saveDraft({ siteId, fields: { heading: marker } });
					return { kind: "consentBanner" };
				},
				publish: () => staff.api.consentBanner.publish({ siteId }),
			},
			{
				name: "Design system",
				save: async (marker) => {
					await staff.api.designSystem.saveDraft({ siteId, customCss: `/* ${marker} */` });
					return { kind: "designSystem" };
				},
				publish: () => staff.api.designSystem.publish({ siteId }),
			},
			{
				name: "Component",
				save: async (marker) => {
					await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: `<p>${marker}</p>` });
					return { kind: "component", id: component.id };
				},
				publish: () => staff.api.components.publish({ siteId, componentId: component.id }),
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
				publish: (item) => staff.api.templates.publish({ siteId, templateId: (item as { id: string }).id }),
			},
			{
				name: "script",
				save: async (marker) => {
					const { script } = await staff.api.scripts.saveDraft({ siteId, entryId: null, code: `// ${marker}` });
					return { kind: "script", id: script.id };
				},
				publish: (item) => staff.api.scripts.publish({ siteId, scriptId: (item as { id: string }).id }),
			},
			{
				name: "Loop",
				save: async (marker) => {
					await staff.api.loops.saveDraft({
						siteId,
						loopId: loop.id,
						query: { postTypes: ["posts"], limit: marker === "before" ? 5 : 9 },
					});
					return { kind: "loop", id: loop.id };
				},
				publish: () => staff.api.loops.publish({ siteId, loopId: loop.id }),
			},
			{
				name: "Filter",
				save: async (marker) => {
					await staff.api.filters.saveDraft({ siteId, filterId: filter.id, applyLabel: marker });
					return { kind: "filter", id: filter.id };
				},
				publish: () => staff.api.filters.publish({ siteId, filterId: filter.id }),
			},
			{
				name: "Form",
				save: async (marker) => {
					await staff.api.forms.saveDraft({ siteId, formId: form.id, form: { submitLabel: marker } });
					return { kind: "form", id: form.id };
				},
				publish: () => staff.api.forms.publish({ siteId, formId: form.id }),
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
				publish: () => staff.api.forms.publishEmails({ siteId, formId: form.id }),
			},
		];
		for (const kind of kinds) {
			const item = await kind.save("before");
			await kind.publish(item);
			const revision = await newestRevision(staff.api, siteId, item);
			await install.clock.advance(MINUTE);
			await kind.save("after");
			const changed = await staff.api.history.compare({ siteId, item, copy: { type: "revision", id: revision.id } });
			expect({ kind: kind.name, changes: changed.changes > 0 }).toEqual({ kind: kind.name, changes: true });

			await staff.api.history.restore({ siteId, item, copy: { type: "revision", id: revision.id } });
			const back = await staff.api.history.compare({ siteId, item, copy: { type: "revision", id: revision.id } });
			expect({ kind: kind.name, changes: back.changes }).toEqual({ kind: kind.name, changes: 0 });
		}
	});
});
