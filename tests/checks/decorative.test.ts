import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let mediaId: string;
beforeAll(async () => {
	install = await createTestInstall();
	const workspace = await install.createWorkspace();
	siteId = (await install.createSite(workspace.id, { slug: "checks" })).id;
	staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	await goLive(install, siteId);
	mediaId = (await staff.api.media.upload({ siteId, file: upload(await photo({ width: 32, height: 32 }), "leaf.jpg") }))
		.media.id;
	await install.drainJobs();
});
afterAll(async () => {
	await install.close();
});

test("Decorative belongs to each Body image, survives JSON and Markdown, and never changes reused Media", async () => {
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
		fields: [{ key: "body", label: "Body", type: "body" }],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>{{ body }}",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Leaves",
		fields: {
			body: [
				{ type: "image", media: mediaId, decorative: true },
				{ type: "image", media: mediaId },
			],
		},
	});
	expect(entry.draft.fields.body).toMatchObject([{ decorative: true }, {}]);
	expect(entry.checks.filter((c) => c.check === "missingAlt").map((c) => c.at)).toEqual(["fields.body[1]"]);
	const markdown = (await staff.api.entries.get({ siteId, entryId: entry.id, bodyFormat: "markdown" })).entry.draft
		.fields.body;
	expect(markdown).toContain(`::image{media="${mediaId}" decorative="true"}`);
	const saved = await staff.api.entries.saveDraft({
		siteId,
		entryId: entry.id,
		bodyFormat: "markdown",
		fields: { body: markdown },
	});
	expect(saved.entry.draft.fields.body).toMatchObject([{ decorative: true }, {}]);
	await staff.api.media.update({ siteId, mediaId, alt: "A green leaf" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const html = await expectSafePage(await install.request("https://checks.live.test/stories/leaves"));
	expect(html.match(/alt=""/g)?.length).toBe(1);
	expect(html).toContain('alt="A green leaf"');
	expect((await staff.api.media.get({ siteId, mediaId })).media.alt).toBe("A green leaf");
});

test("Template markup preserves Decorative on Media and External image placements", async () => {
	const { component } = await staff.api.components.create({ siteId, name: "Leaves", props: [] });
	const { component: saved } = await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: `<div><img src="media:${mediaId}" data-wc-decorative><img src="https://images.example.com/leaf.jpg" alt="Ignored" data-wc-decorative></div>`,
	});
	expect(JSON.stringify(saved.draft.tree)).toContain('"decorative":true');
	const markup = await staff.api.components.getMarkup({ siteId, componentId: component.id });
	expect(JSON.stringify(markup)).toContain("data-wc-decorative");
	const opened = await staff.api.builder.open({ siteId, target: { kind: "component", componentId: component.id } });
	const preview = await staff.api.builder.preview({
		siteId,
		target: { kind: "component", componentId: component.id },
		tree: opened.tree,
	});
	expect(preview.html.match(/alt=""/g)?.length).toBe(2);
	expect(preview.html).not.toContain('alt="Ignored"');
});

test("translated Blocks keep Decorative placement settings through translation and Markdown editing", async () => {
	const { translatedSite } = await import("../translation/support.ts");
	const site = await translatedSite(install, { it: "automatic" });
	const media = (
		await site.staff.api.media.upload({
			siteId: site.siteId,
			file: upload(await photo({ width: 32, height: 32 }), "branch.jpg"),
		})
	).media;
	await install.drainJobs();
	const { entry } = await site.owner.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title: "Branch",
		fields: {
			body: [
				{ id: "decorative", type: "image", media: media.id, decorative: true },
				{ id: "meaningful", type: "image", media: media.id },
				{ id: "copy", type: "paragraph", text: "A branch in spring." },
			],
		},
	});
	await site.owner.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	await install.drainJobs();
	const translated = (await site.owner.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" }))
		.entry;
	expect(translated.draft.fields.body).toMatchObject([
		{ id: "decorative", decorative: true },
		{ id: "meaningful" },
		{ id: "copy", text: [{ text: "[it] A branch in spring." }] },
	]);
	expect(translated.checks.filter((c) => c.check === "missingAlt").map((c) => c.at)).toEqual(["fields.body[1]"]);
	const markdown = (
		await site.owner.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it", bodyFormat: "markdown" })
	).entry.draft.fields.body;
	const edited = await site.owner.api.entries.saveDraft({
		siteId: site.siteId,
		entryId: entry.id,
		language: "it",
		bodyFormat: "markdown",
		fields: { body: markdown },
	});
	expect(edited.entry.draft.fields.body).toMatchObject([{ decorative: true }, {}, {}]);
	expect((await site.staff.api.media.get({ siteId: site.siteId, mediaId: media.id })).media.alt).toBeNull();
});
