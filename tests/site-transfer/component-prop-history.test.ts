import { afterEach, beforeEach, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, TEST_PASSWORD, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "./support.ts";

let install: TestInstall;
beforeEach(async () => {
	install = await createTestInstall();
});
afterEach(async () => {
	await install?.close();
});
async function setup(slug: string) {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace(slug)).id;
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "picture.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Pages", key: "pages", urlPattern: "/{slug}" });
	return { admin, workspaceId, siteId, media, postType };
}
async function main(siteId: string) {
	const origin = await goLive(install, siteId);
	const html = await expectSafePage(await install.request(`${origin}/example`));
	return html.match(/<main[^>]*>([\s\S]*)<\/main>/)?.[1] ?? "";
}
test("retained Template Revision keeps Media after the Component history was pruned", async () => {
	let { admin, workspaceId, siteId, media, postType } = await setup("pruned-props");
	await admin.api.install.history.update({ revisionDays: 1, revisionsKept: 1, checkpointDays: 1 });
	const { component } = await admin.api.components.create({
		siteId,
		name: "StablePhoto",
		props: [{ key: "image", label: "Image", type: "media" }],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<img src="{{ props.image }}" alt="First">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<StablePhoto image="media:${media.id}"/>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await install.clock.advance(60000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<img src="{{ props.image }}" alt="Second">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(2 * 24 * 60 * 60 * 1000);
	await install.drainJobs();
	admin = await install.superadmin();
	const componentHistory = await admin.api.history.list({ siteId, item: { kind: "component", id: component.id } });
	const templateHistory = await admin.api.history.list({ siteId, item: { kind: "template", id: template.id } });
	expect(componentHistory.copies.filter((x) => x.type === "revision")).toHaveLength(1);
	expect(templateHistory.copies.filter((x) => x.type === "revision")).toHaveLength(1);
	const originalUrl = (await admin.api.media.get({ siteId, mediaId: media.id })).media.url;
	expect(await main(siteId)).toContain(`src="${originalUrl}"`);
	await admin.api.session.confirmIdentity({ password: TEST_PASSWORD });
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Pruned copy",
		slug: "pruned-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((x) => x.key === "pages");
	const copyTemplate = (
		await admin.api.templates.getEntryTemplate({ siteId: destination, postTypeId: copiedType?.id ?? "" })
	).template;
	const item = { kind: "template" as const, id: copyTemplate?.id ?? "" };
	const hist = await admin.api.history.list({ siteId: destination, item });
	const rev = hist.copies.find((x) => x.type === "revision");
	await admin.api.history.restore({ siteId: destination, item, copy: { type: "revision", id: rev?.id ?? "" } });
	await publishEverything(admin, destination);
	const [copiedMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const newUrl = (await admin.api.media.get({ siteId: destination, mediaId: copiedMedia?.id ?? "" })).media.url;
	const copiedHtml = await main(destination);
	expect(copiedHtml).toContain(`src="${newUrl}"`);
});
test("a Template Checkpoint uses newer published text declarations ahead of older Draft schemas", async () => {
	const { admin, workspaceId, siteId, media, postType } = await setup("checkpoint-order");
	const { component } = await admin.api.components.create({
		siteId,
		name: "CheckpointProp",
		props: [{ key: "value", label: "Value", type: "media" }],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<img src="{{ props.value }}" alt="Original">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<img src="{{ props.value }}" alt="Draft">',
	});
	await admin.api.history.leave({ siteId, item: { kind: "component", id: component.id } });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({ siteId, componentId: component.id, props: [], markup: "<p>Removed</p>" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		props: [{ key: "value", label: "Value", type: "text" }],
		markup: "<p>{{ props.value }}</p>",
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<CheckpointProp value="media:${media.id}"/>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	await install.clock.advance(1000);
	await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<CheckpointProp value="media:${media.id}"/><p>Checkpoint words</p>`,
	});
	await admin.api.history.leave({ siteId, item: { kind: "template", id: template.id } });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<span>{{ props.value }}</span>",
	});
	const sourceCopies = await admin.api.history.list({ siteId, item: { kind: "template", id: template.id } });
	const sourceCheckpoint = sourceCopies.copies.find((x) => x.type === "checkpoint");
	const sourceContent = await admin.api.history.get({
		siteId,
		item: { kind: "template", id: template.id },
		copy: { type: "checkpoint", id: sourceCheckpoint?.id ?? "" },
	});
	expect(JSON.stringify(sourceContent.content)).toContain(`media:${media.id}`);
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Order copy",
		slug: "order-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((x) => x.key === "pages");
	const copyTemplate = (
		await admin.api.templates.getEntryTemplate({ siteId: destination, postTypeId: copiedType?.id ?? "" })
	).template;
	const item = { kind: "template" as const, id: copyTemplate?.id ?? "" };
	const copies = await admin.api.history.list({ siteId: destination, item });
	const checkpoint = copies.copies.find((x) => x.type === "checkpoint");
	const full = await admin.api.history.get({
		siteId: destination,
		item,
		copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
	});
	expect(JSON.stringify(full.content)).toContain(`media:${media.id}`);
});

test("published Template history does not use an obsolete Draft type after revision pruning", async () => {
	let { admin, workspaceId, siteId, media, postType } = await setup("pruned-draft-schema");
	await admin.api.install.history.update({ revisionDays: 1, revisionsKept: 1, checkpointDays: 30 });
	const { component } = await admin.api.components.create({
		siteId,
		name: "ChangedPhoto",
		props: [{ key: "image", label: "Image", type: "text" }],
	});
	await admin.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<p>{{ props.image }}</p>" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<span>{{ props.image }}</span>",
	});
	await admin.api.history.leave({ siteId, item: { kind: "component", id: component.id } });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({ siteId, componentId: component.id, props: [], markup: "<p>Removed</p>" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(1000);
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		props: [{ key: "image", label: "Image", type: "media" }],
		markup: '<img src="{{ props.image }}" alt="First">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<ChangedPhoto image="media:${media.id}"/>`,
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
		markup: '<img src="{{ props.image }}" alt="Second">',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	await install.clock.advance(2 * 24 * 60 * 60 * 1000);
	expect((await install.drainJobs()).failed).toEqual([]);
	admin = await install.superadmin();
	const { copies } = await admin.api.history.list({ siteId, item: { kind: "component", id: component.id } });
	expect(copies.filter((x) => x.type === "revision")).toHaveLength(1);
	expect(copies.some((x) => x.type === "checkpoint")).toBe(true);
	const originalUrl = (await admin.api.media.get({ siteId, mediaId: media.id })).media.url;
	expect(await main(siteId)).toContain(`src="${originalUrl}"`);
	await admin.api.session.confirmIdentity({ password: TEST_PASSWORD });
	const imported = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Pruned copy",
		slug: "pruned-copy",
	});
	expect(imported.status).toBe("done");
	const destination = imported.site?.id ?? "";
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((x) => x.key === "pages");
	const copiedTemplate = (
		await admin.api.templates.getEntryTemplate({ siteId: destination, postTypeId: copiedType?.id ?? "" })
	).template;
	const item = { kind: "template" as const, id: copiedTemplate?.id ?? "" };
	const hist = await admin.api.history.list({ siteId: destination, item });
	const revision = hist.copies.find((x) => x.type === "revision");
	await admin.api.history.restore({ siteId: destination, item, copy: { type: "revision", id: revision?.id ?? "" } });
	await publishEverything(admin, destination);
	const [copiedMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const newUrl = (await admin.api.media.get({ siteId: destination, mediaId: copiedMedia?.id ?? "" })).media.url;
	const html = await main(destination);
	expect(html).toContain(`src="${newUrl}"`);
});

test("transfer searches past newer missing contracts without remapping historical literal text", async () => {
	let { admin, workspaceId, siteId, postType } = await setup("contract-fallback");
	await admin.api.install.history.update({ revisionDays: 1, revisionsKept: 1, checkpointDays: 1 });
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Linked" });
	const { component } = await admin.api.components.create({ siteId, name: "HistoricalCard" });
	const target = { siteId, componentId: component.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\nreference: relationship postTypes=["pages"] id="historical:reference"\nwords: text id="historical:words"\norphan: text\n{{/props}}\n<p>Original</p>',
	});
	await admin.api.components.publish(target);
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<HistoricalCard reference="${entry.id}" words="${entry.id}" orphan="No remaining declaration" />`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	await install.clock.advance(60_000);
	await admin.api.components.saveMarkup({ ...target, markup: "{{@props}}\n{{/props}}\n<p>Removed</p>" });
	await admin.api.components.publish(target);
	await install.clock.advance(2 * 24 * 60 * 60 * 1000);
	expect((await install.drainJobs()).failed).toEqual([]);
	admin = await install.superadmin();
	// The Template Revision outlives its original Component contracts. A later matching
	// contract is still useful, but many more recent Revisions/Checkpoints lack these Props.
	await install.clock.advance(1000);
	await admin.api.components.saveDraft({ ...target, props: original.component.draft.props.slice(0, 2) });
	await admin.api.components.publish(target);
	for (let index = 0; index < 12; index++) {
		await install.clock.advance(1000);
		await admin.api.components.saveMarkup({
			...target,
			markup: `{{@props}}\n{{/props}}\n<p>Later ${index}</p>`,
		});
		await admin.api.history.leave({ siteId, item: { kind: "component", id: component.id } });
		await admin.api.components.publish(target);
	}
	const sourceHistory = await admin.api.history.list({ siteId, item: { kind: "component", id: component.id } });
	expect(sourceHistory.copies.length).toBeGreaterThan(20);
	await admin.api.session.confirmIdentity({ password: TEST_PASSWORD });
	// Legacy copies have no self-contained contracts. Keep exercising the bounded historical
	// lookup even though new copies now capture those contracts when they are created.
	const archive = rewritten(await exportedArchive(install, admin, siteId), {
		rows: (table, rows) => {
			if (table !== "public.revisions") return rows;
			return rows.map((row) => {
				if (row.item_kind !== "template") return row;
				const content = structuredClone(row.content) as { nodes: { props: { contract?: unknown }[] }[] };
				for (const node of content.nodes) for (const prop of node.props) delete prop.contract;
				return { ...row, content };
			});
		},
	});
	const imported = await importArchive(install, admin, workspaceId, archive, {
		name: "Fallback copy",
		slug: "fallback-copy",
		partBytes: 1024,
	});
	expect(imported.status).toBe("done");
	const destination = imported.site?.id ?? "";
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((p) => p.key === "pages");
	const holder = { siteId: destination, postTypeId: type?.id ?? "" };
	const [linked] = (await admin.api.entries.list(holder)).entries;
	expect(linked?.id).not.toBe(entry.id);
	const copiedTemplate = (await admin.api.templates.getEntryTemplate(holder)).template;
	const item = { kind: "template" as const, id: copiedTemplate?.id ?? "" };
	const history = await admin.api.history.list({ siteId: destination, item });
	// Select the source Revision, not import's last-live recovery copy (timestamps may tie).
	const revision = history.copies.find((c) => c.type === "revision" && c.by?.via?.kind !== "command");
	const restored = await admin.api.history.get({
		siteId: destination,
		item,
		copy: { type: "revision", id: revision?.id ?? "" },
	});
	expect(restored.content).toMatchObject({
		nodes: [
			{
				props: [
					{ name: "reference", value: [{ type: "text", text: linked?.id }] },
					{ name: "words", value: [{ type: "text", text: entry.id }] },
					{ name: "orphan", value: [{ type: "text", text: "No remaining declaration" }] },
				],
			},
		],
	});
});
