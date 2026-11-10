import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install?.close();
});

async function setup(slug: string) {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace(slug)).id;
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Pages",
		key: "pages",
		urlPattern: "/{slug}",
	});
	return { admin, workspaceId, siteId, postType };
}

async function page(siteId: string) {
	const origin = await goLive(install, siteId);
	return expectSafePage(await install.request(`${origin}/example`));
}

test("multiple fixed Relationship Props keep their targets when the Site moves", async () => {
	const { admin, workspaceId, siteId, postType } = await setup("relationships-source");
	const { entry: first } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "First",
		slug: "first",
	});
	const { entry: second } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Second",
		slug: "second",
	});
	await admin.api.entries.publish({ siteId, entryId: first.id });
	await admin.api.entries.publish({ siteId, entryId: second.id });
	const { component } = await admin.api.components.create({
		siteId,
		name: "RelatedPages",
		props: [{ key: "related", label: "Related", type: "relationship", postTypes: ["pages"], multiple: true }],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<p>{{ props.related.title }}</p>",
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<RelatedPages related="${first.id}, ${second.id}"/>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	expect(await page(siteId)).toContain("<p>First, Second</p>");
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Relationships copy",
		slug: "relationships-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	await publishEverything(admin, destination);
	expect(await page(destination)).toContain("<p>First, Second</p>");
});

test("a Media Prop removed from the Component Draft survives with its former live Revision", async () => {
	const { admin, workspaceId, siteId, postType } = await setup("history-source");
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "picture.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { component } = await admin.api.components.create({
		siteId,
		name: "HistoryPhoto",
		props: [{ key: "picture", label: "Picture", type: "media" }],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<img src="{{ props.picture }}" alt="Historical">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<HistoryPhoto picture="media:${media.id}"/>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		props: [],
		markup: "<p>Changed Draft</p>",
	});
	const originalUrl = (await admin.api.media.get({ siteId, mediaId: media.id })).media.url;
	expect(await page(siteId)).toContain(`src="${originalUrl}"`);
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "History copy",
		slug: "history-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const [copyComponent] = (await admin.api.components.list({ siteId: destination })).components;
	const item = { kind: "component" as const, id: copyComponent?.id ?? "" };
	const history = await admin.api.history.list({ siteId: destination, item });
	const revision = history.copies.find((copy) => copy.type === "revision");
	await admin.api.history.restore({
		siteId: destination,
		item,
		copy: { type: "revision", id: revision?.id ?? "" },
	});
	await publishEverything(admin, destination);
	const [copiedMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const copiedUrl = (await admin.api.media.get({ siteId: destination, mediaId: copiedMedia?.id ?? "" })).media.url;
	expect(await page(destination)).toContain(`src="${copiedUrl}"`);
});

test("reusing a removed Prop key as text preserves current literals and historical Media references", async () => {
	const { admin, workspaceId, siteId, postType } = await setup("reused-prop");
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "former-picture.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { component } = await admin.api.components.create({
		siteId,
		name: "ChangingProp",
		props: [{ key: "value", label: "Value", type: "media" }],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<img src="{{ props.value }}" alt="Former picture">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<ChangingProp value="media:${media.id}"/>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await install.clock.advance(60_000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		props: [],
		markup: "<p>Removed</p>",
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(60_000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		props: [{ key: "value", label: "Value", type: "text" }],
		markup: "<p>{{ props.value }}</p>",
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<ChangingProp value="media:${media.id}"/>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Reused Prop copy",
		slug: "reused-prop-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	await publishEverything(admin, destination);
	expect(await page(destination)).toContain(`<p>media:${media.id}</p>`);
	const [copyComponent] = (await admin.api.components.list({ siteId: destination })).components;
	// As on the original Site, remove the new type before restoring the old declaration.
	await admin.api.components.saveMarkup({
		siteId: destination,
		componentId: copyComponent?.id ?? "",
		props: [],
		markup: "<p>Removed again</p>",
	});
	await admin.api.components.publish({ siteId: destination, componentId: copyComponent?.id ?? "" });
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
		(type) => type.key === postType.key,
	);
	const copyTemplate = await admin.api.templates.getEntryTemplate({
		siteId: destination,
		postTypeId: copiedType?.id ?? "",
	});
	for (const item of [
		{ kind: "component" as const, id: copyComponent?.id ?? "" },
		{ kind: "template" as const, id: copyTemplate.template?.id ?? "" },
	]) {
		const { copies } = await admin.api.history.list({ siteId: destination, item });
		const oldest = copies.filter((copy) => copy.type === "revision").at(-1);
		await admin.api.history.restore({ siteId: destination, item, copy: { type: "revision", id: oldest?.id ?? "" } });
	}
	await publishEverything(admin, destination);
	const [copiedMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const copiedUrl = (await admin.api.media.get({ siteId: destination, mediaId: copiedMedia?.id ?? "" })).media.url;
	expect(await page(destination)).toContain(`src="${copiedUrl}"`);
});

test("nested Group and Repeater Props remap typed references while preserving literal UUIDs", async () => {
	const { admin, workspaceId, siteId, postType } = await setup("nested-props");
	await admin.api.languages.add({ siteId, code: "it" });
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "nested-picture.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { component } = await admin.api.components.create({
		siteId,
		name: "NestedMedia",
		props: [
			{
				key: "gallery",
				label: "Gallery",
				type: "group",
				fields: [
					{
						key: "images",
						label: "Images",
						type: "repeater",
						fields: [
							{ key: "image", label: "Image", type: "media" },
							{ key: "alt", label: "Alt", type: "text" },
							{ key: "caption", label: "Caption", type: "text" },
							{ key: "related", label: "Related", type: "relationship", postTypes: [postType.key], multiple: true },
							{ key: "more", label: "More", type: "link" },
							{ key: "rich", label: "Rich", type: "richText" },
						],
					},
				],
			},
			{ key: "more", label: "More", type: "link" },
			{ key: "rich", label: "Rich", type: "richText" },
		],
	});
	await admin.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<aside>Gallery</aside>" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	await admin.api.postTypes.update({
		siteId,
		postTypeId: postType.id,
		fields: [{ key: "body", label: "Body", type: "body", components: [component.id] }],
	});
	const { entry: target } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Related",
		slug: "related",
	});
	const more = { url: `https://assets.example/${media.id}`, text: media.id };
	const rich = `<p><a href="media:${media.id}">${media.id}</a></p>`;
	const gallery = {
		images: [{ image: media.id, alt: media.id, caption: `media:${media.id}`, related: [target.id], more, rich }],
	};
	const props = [
		{ name: "gallery", value: JSON.stringify(gallery) },
		{ name: "more", value: JSON.stringify(more) },
		{ name: "rich", value: rich },
	];
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<NestedMedia gallery='${JSON.stringify(gallery)}' more='${JSON.stringify(more)}' rich='${rich}'/>{{ body }}`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const body = [{ type: "component", component: component.id, props }];
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
		fields: { body },
	});
	await admin.api.entries.saveDraft({ siteId, entryId: entry.id, language: "it", fields: { body } });
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Nested copy",
		slug: "nested-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const [copiedMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
		(type) => type.key === postType.key,
	);
	const { entries } = await admin.api.entries.list({ siteId: destination, postTypeId: copiedType?.id ?? "" });
	const copyEntry = entries.find((entry) => entry.draft.slug === "example");
	const copyTarget = entries.find((entry) => entry.draft.slug === "related");
	const expectedMore = more;
	const expectedRich = `<p><a href="media:${copiedMedia?.id}">${media.id}</a></p>`;
	const expectedProps = [
		{
			name: "gallery",
			value: JSON.stringify({
				images: [
					{
						image: copiedMedia?.id,
						alt: media.id,
						caption: `media:${media.id}`,
						related: [copyTarget?.id],
						more: expectedMore,
						rich: expectedRich,
					},
				],
			}),
		},
		{ name: "more", value: JSON.stringify(expectedMore) },
		{ name: "rich", value: expectedRich },
	];
	for (const language of ["en", "it"]) {
		const { entry } = await admin.api.entries.get({ siteId: destination, entryId: copyEntry?.id ?? "", language });
		expect(entry.draft.fields.body).toMatchObject([{ type: "component", props: expectedProps }]);
	}
	const copiedTemplate = await admin.api.templates.getEntryTemplate({
		siteId: destination,
		postTypeId: copiedType?.id ?? "",
	});
	expect(copiedTemplate.template?.draft.nodes[0]).toMatchObject({
		type: "component",
		props: expectedProps.map((prop) => ({ name: prop.name, value: [{ type: "text", text: prop.value }] })),
	});
	const item = { kind: "entry" as const, id: copyEntry?.id ?? "" };
	const { copies } = await admin.api.history.list({ siteId: destination, item });
	const revision = copies.find((copy) => copy.type === "revision");
	await admin.api.history.restore({ siteId: destination, item, copy: { type: "revision", id: revision?.id ?? "" } });
	const restored = await admin.api.entries.get({ siteId: destination, entryId: copyEntry?.id ?? "" });
	expect(restored.entry.draft.fields.body).toMatchObject([{ type: "component", props: expectedProps }]);
});
