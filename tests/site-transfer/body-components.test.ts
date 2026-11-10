// #79's allowed Components and Component Blocks cross Installs with every version and language.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "./support.ts";

let source: TestInstall;
let target: TestInstall;
let admin: TestBrowser;
let siteId: string;
let postTypeId: string;
let entryId: string;
let componentId: string;
let unusedId: string;
let oldComponentId: string;
let oldUnusedId: string;
let sourceOrigin: string;
let liveRevisionId: string;
const words = {
	en: { live: "Live words", draft: "Draft words" },
	it: { live: "Parole pubblicate", draft: "Parole in bozza" },
};

function body(component: string, text: string) {
	return [{ type: "component", component, props: [{ name: "text", value: text }] }];
}
function article(html: string) {
	return /<article>([\s\S]*?)<\/article>/.exec(html)?.[1] ?? "";
}

beforeAll(async () => {
	source = await createTestInstall();
	const staff = await source.superadmin();
	const workspaceId = (await source.createWorkspace("Original")).id;
	const originalId = (await source.createSite(workspaceId, { name: "Body Components", slug: "source-body" })).id;
	sourceOrigin = await goLive(source, originalId);
	await staff.api.languages.add({ siteId: originalId, code: "it" });
	const make = async (name: string) => {
		const { component } = await staff.api.components.create({
			siteId: originalId,
			name,
			props: [{ key: "text", label: "Text", type: "text", required: true }],
		});
		await staff.api.components.saveMarkup({
			siteId: originalId,
			componentId: component.id,
			markup: "<aside>{{ props.text }}</aside>",
		});
		await staff.api.components.publish({ siteId: originalId, componentId: component.id });
		return component.id;
	};
	oldComponentId = await make("Note");
	oldUnusedId = await make("AlsoAllowed");
	const { postType } = await staff.api.postTypes.create({
		siteId: originalId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: [oldComponentId, oldUnusedId] }],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: originalId,
		postTypeId: postType.id,
		markup: "<article>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId: originalId, templateId: template.id });
	const { entry } = await staff.api.entries.create({
		siteId: originalId,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
		fields: { body: body(oldComponentId, "First words") },
	});
	await staff.api.entries.publish({ siteId: originalId, entryId: entry.id });
	for (const [language, text] of Object.entries(words))
		await staff.api.entries.saveDraft({
			siteId: originalId,
			entryId: entry.id,
			language,
			fields: { body: body(oldComponentId, text.live) },
		});
	await staff.api.entries.publish({ siteId: originalId, entryId: entry.id });
	for (const [language, text] of Object.entries(words))
		await staff.api.entries.saveDraft({
			siteId: originalId,
			entryId: entry.id,
			language,
			fields: { body: body(oldComponentId, text.draft) },
		});
	const archive = await exportedArchive(source, staff, originalId);
	target = await createTestInstall();
	admin = await target.superadmin();
	const destination = (await target.createWorkspace("Destination")).id;
	const imported = await importArchive(target, admin, destination, archive, { name: "Body copy", slug: "copy-body" });
	expect(imported.failure).toBeNull();
	expect(imported.status).toBe("done");
	siteId = imported.site?.id ?? "";
	const { components } = await admin.api.components.list({ siteId });
	componentId = components.find((component) => component.name === "Note")?.id ?? "";
	unusedId = components.find((component) => component.name === "AlsoAllowed")?.id ?? "";
	const { postTypes } = await admin.api.postTypes.list({ siteId });
	postTypeId = postTypes.find((type) => type.key === "stories")?.id ?? "";
	entryId = (await admin.api.entries.list({ siteId, postTypeId })).entries[0]?.id ?? "";
});

afterAll(async () => {
	await target?.close();
	await source?.close();
});

test("the Body field keeps all allowed Components under their new IDs", async () => {
	const { postType } = await admin.api.postTypes.get({ siteId, postTypeId });
	expect(componentId).not.toBe(oldComponentId);
	expect(unusedId).not.toBe(oldUnusedId);
	expect(postType.fields[0]).toMatchObject({ type: "body", components: [componentId, unusedId] });
});

for (const [language, text] of Object.entries(words))
	test(`the ${language} Draft keeps its Component Block and fixed Props`, async () => {
		const { entry } = await admin.api.entries.get({ siteId, entryId, language });
		expect(entry.published).toBeNull();
		expect(entry.draft.fields.body).toEqual([
			{
				id: expect.any(String),
				type: "component",
				component: componentId,
				props: [{ name: "text", value: text.draft }],
			},
		]);
	});

test("Revisions keep the earlier and former live Blocks in every language with remapped IDs", async () => {
	const item = { kind: "entry" as const, id: entryId };
	const { copies } = await admin.api.history.list({ siteId, item });
	const saved: string[] = [];
	for (const copy of copies.filter((copy) => copy.type === "revision")) {
		const revision = await admin.api.history.get({ siteId, item, copy: { type: "revision", id: copy.id } });
		const text = JSON.stringify(revision.content);
		expect(text).toContain(componentId);
		expect(text).not.toContain(oldComponentId);
		saved.push(text);
		if (text.includes(words.en.live)) liveRevisionId = copy.id;
	}
	expect(saved.join("\n")).toContain("First words");
	expect(saved.join("\n")).toContain(words.en.live);
	expect(saved.join("\n")).toContain(words.it.live);
	expect(liveRevisionId).toBeTruthy();
});

test("publishing the Draft and restoring the former live Revision render the right fixed Props", async () => {
	await publishEverything(admin, siteId);
	const origin = await goLive(target, siteId);
	for (const [language, text] of Object.entries(words)) {
		const path = `${language === "en" ? "" : `/${language}`}/stories/example`;
		const response = await target.request(`${origin}${path}`);
		expect(response.status).toBe(200);
		expect(article(await response.text())).toBe(`<aside>${text.draft}</aside>`);
	}
	await admin.api.history.restore({
		siteId,
		item: { kind: "entry", id: entryId },
		copy: { type: "revision", id: liveRevisionId },
	});
	await admin.api.entries.publish({ siteId, entryId });
	for (const [language, text] of Object.entries(words)) {
		const path = `${language === "en" ? "" : `/${language}`}/stories/example`;
		const original = await source.request(`${sourceOrigin}${path}`);
		const copied = await target.request(`${origin}${path}`);
		expect(original.status).toBe(200);
		expect(copied.status).toBe(200);
		const copiedArticle = article(await copied.text());
		expect(copiedArticle).toBe(article(await original.text()));
		expect(copiedArticle).toBe(`<aside>${text.live}</aside>`);
	}
});
