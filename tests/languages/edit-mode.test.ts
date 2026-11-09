// Edit mode in each of the Site's languages: a page under a language's prefix shows that language's
// Drafts, its regions save in that language, and the editing bar lists the page in every language to
// switch to.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; entryId: string };

async function newSite(): Promise<TestSite> {
	const slug = `edit-languages-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of ["fr", "de"]) await staff.api.languages.add({ siteId, code });
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><p>{{ site.tagline }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await editor.api.entries.saveDraft({ siteId, entryId: entry.id, language: "fr", slug: "pain-frais" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, entryId: entry.id };
}

describe("Edit mode in another language", () => {
	test("the page's state is in its language and lists the page in every language", async () => {
		const site = await newSite();
		const edit = await openEditMode(install, editor, site.siteId, "/fr/blog/pain-frais");

		const state = (await (await edit.edit("state", { path: "/fr/blog/pain-frais" })).json()) as Record<string, unknown>;

		expect(state.language).toEqual({ code: "fr", name: "Français" });
		expect(state.languages).toEqual([
			{ code: "en", name: "English", path: "/blog/fresh-bread", current: false },
			{ code: "fr", name: "Français", path: "/fr/blog/pain-frais", current: true },
			{ code: "de", name: "Deutsch", path: "/de/blog/fresh-bread", current: false },
		]);
	});

	test("regions save in the page's language, leaving the others as they are", async () => {
		const site = await newSite();
		const edit = await openEditMode(install, editor, site.siteId, "/fr/blog/pain-frais");

		const saved = await edit.edit("save", {
			item: `entry:${site.entryId}`,
			field: "subtitle",
			value: "Sorti du four",
			language: "fr",
		});
		expect(saved.status).toBe(200);
		await edit.edit("save", { item: "globals", field: "tagline", value: "Cuit chaque jour", language: "fr" });

		const french = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId, language: "fr" });
		expect(french.entry.draft.fields.subtitle).toBe("Sorti du four");
		const english = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(english.entry.draft.fields.subtitle).toBe("Out of the oven");
		expect((await editor.api.globals.get({ siteId: site.siteId, language: "fr" })).globals.draft.tagline).toBe(
			"Cuit chaque jour",
		);
		expect((await editor.api.globals.get({ siteId: site.siteId })).globals.draft.tagline).toBeNull();
		const page = await (await edit.page("/fr/blog/pain-frais")).text();
		expect(page).toContain("Sorti du four");
		expect(page).toContain('<html lang="fr" dir="ltr">');

		const refused = await edit.edit("save", {
			item: `entry:${site.entryId}`,
			field: "subtitle",
			value: "Frisch",
			language: "it",
		});
		expect(refused.status).toBe(400);
	});
});
