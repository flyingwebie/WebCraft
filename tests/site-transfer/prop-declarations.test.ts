import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("format3 retains declaration identities and remaps pending Prop contracts and historical defaults", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId, { slug: "declaration-source" })).id;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "photo.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { component } = await admin.api.components.create({ siteId, name: "Photo" });
	const original = await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: `{{@props}}\nimage: media id="${media.id}" default="media:${media.id}" exposed\nheading: text\nobsolete: text\n{{/props}}\n<img src="{{ props.image }}" alt="Picture"><p>{{ props.heading }}</p>`,
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<Photo image="media:${media.id}" heading="Keep these words" obsolete="Remove on publish" />`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: `{{@props}}\nimage: text id="${original.component.draft.props[0]?.id}" default="${media.id}"\ntitle: text id="${original.component.draft.props[1]?.id}"\n{{/props}}\n<p>{{ props.image }} {{ props.title }}</p>`,
	});
	await admin.api.history.leave({ siteId, item: { kind: "component", id: component.id } });
	expect(
		(await admin.api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.published,
	).toContain('heading="Keep these words"');
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Copy",
		slug: "declaration-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const [copy] = (await admin.api.components.list({ siteId: destination })).components;
	const [newMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((t) => t.key === "stories");
	const text = await admin.api.templates.getEntryTemplateMarkup({ siteId: destination, postTypeId: type?.id ?? "" });
	expect(text.markup?.draft).toContain(`media:${newMedia?.id}`);
	expect(text.markup?.draft).toContain('title="Keep these words"');
	expect(text.markup?.draft).toContain('obsolete="Remove on publish"');
	// Site import deliberately publishes nothing; the published contract is retained in history.
	expect(text.markup?.published).toBeNull();
	expect(copy?.draft.props[0]).toMatchObject({ id: original.component.draft.props[0]?.id, default: media.id });
	expect(copy?.draft.propBaseline?.[0]).toMatchObject({ type: "media", default: newMedia?.id });
	const target = { siteId: destination, componentId: copy?.id ?? "" };
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(1);
	const history = await admin.api.history.list({
		siteId: destination,
		item: { kind: "component", id: target.componentId },
	});
	const revision = history.copies.find((c) => c.type === "revision");
	const checkpoint = history.copies.find((c) => c.type === "checkpoint" && c.reason === "left");
	const kept = await admin.api.history.get({
		siteId: destination,
		item: { kind: "component", id: target.componentId },
		copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
	});
	expect(kept.content).toMatchObject({
		propBaseline: [
			expect.objectContaining({ type: "media", default: newMedia?.id }),
			expect.anything(),
			expect.anything(),
		],
	});
	await admin.api.history.restore({
		siteId: destination,
		item: { kind: "component", id: target.componentId },
		copy: { type: "revision", id: revision?.id ?? "" },
	});
	const restored = await admin.api.components.getMarkup(target);
	expect(restored.component.draft.props[0]).toMatchObject({
		id: original.component.draft.props[0]?.id,
		default: newMedia?.id,
		exposed: true,
	});
	expect(restored.propImpact.placements).toBe(0);
	await admin.api.components.saveMarkup({ ...target, markup: restored.markup.draft });
	expect((await admin.api.components.getMarkup(target)).markup.draft).toBe(restored.markup.draft);
	// Restoring the checkpoint reapplies all pending changes using retained, remapped declarations.
	await admin.api.history.restore({
		siteId: destination,
		item: { kind: "component", id: target.componentId },
		copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
	});
	const pending = await admin.api.components.getMarkup(target);
	expect(pending.component.draft.props.map((p) => p.key)).toEqual(["image", "title"]);
	expect(pending.component.draft.propBaseline?.[0]).toMatchObject({ type: "media", default: newMedia?.id });
	expect(pending.propImpact.placements).toBe(1);
	const beforePublish = await admin.api.templates.getEntryTemplateMarkup({
		siteId: destination,
		postTypeId: type?.id ?? "",
	});
	expect(beforePublish.markup?.draft).toContain('title="Keep these words"');
	expect(beforePublish.markup?.draft).toContain(`media:${newMedia?.id}`);
	expect(beforePublish.markup?.published).toBeNull();
	await admin.api.components.publish(target);
	const afterPublish = await admin.api.templates.getEntryTemplateMarkup({
		siteId: destination,
		postTypeId: type?.id ?? "",
	});
	expect(afterPublish.markup?.draft).toContain('title="Keep these words"');
	expect(afterPublish.markup?.draft).not.toContain("image=");
	expect(afterPublish.markup?.draft).not.toContain("obsolete=");
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
});

test("name reuse transfers distinct retained Media and Entry identities and restores them from history", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "retained.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
	});
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Linked" });
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\na: media\nb: text\ncard: group fields=[{"key":"a","label":"A","type":"relationship","postTypes":["stories"]},{"key":"b","label":"B","type":"text"}]\n{{/props}}\n<p>{{ props.b }} {{ props.card.b }}</p>',
	});
	await admin.api.components.publish(target);
	const holder = { siteId, postTypeId: postType.id };
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `<Card a="media:${media.id}" b="${media.id}" card='${JSON.stringify({ a: entry.id, b: entry.id })}' />`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const props = structuredClone(original.component.draft.props);
	const b = props[1];
	const card = props[2];
	if (!b || !card || !("fields" in card) || !card.fields[1]) throw new Error("Missing declarations");
	card.fields = [{ ...card.fields[1], key: "a" }];
	await admin.api.components.saveDraft({ ...target, props: [{ ...b, key: "a" }, card] });
	await admin.api.history.leave({ siteId, item: { kind: "component", id: component.id } });
	const archive = await exportedArchive(install, admin, siteId);
	const copied = await importArchive(install, admin, workspaceId, archive, {
		name: "Retention",
		slug: "retention-copy",
	});
	const damaged = rewritten(archive, {
		rows: (table, rows) =>
			table === "public.templates"
				? rows.map((row) =>
						JSON.parse(JSON.stringify(row).replaceAll('"retained":', '"extra":"unsupported","retained":')),
					)
				: rows,
	});
	const refused = await importArchive(install, admin, workspaceId, damaged, {
		name: "Damaged retention",
		slug: "damaged-retention",
	});
	expect(refused).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
	const malformedParts = rewritten(archive, {
		rows: (table, rows) =>
			table === "public.templates"
				? rows.map((row) => JSON.parse(JSON.stringify(row).replaceAll(`"text":"media:${media.id}"`, '"text":42')))
				: rows,
	});
	const invalidParts = await importArchive(install, admin, workspaceId, malformedParts, {
		name: "Invalid retained parts",
		slug: "invalid-retained-parts",
	});
	expect(invalidParts).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });

	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const [copy] = (await admin.api.components.list({ siteId: destination })).components;
	const [newMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((t) => t.key === "stories");
	const copiedHolder = { siteId: destination, postTypeId: type?.id ?? "" };
	const copiedTarget = { siteId: destination, componentId: copy?.id ?? "" };
	const before = await admin.api.templates.getEntryTemplateMarkup(copiedHolder);
	// UUID-looking live text must remain text, while the other identity still denotes Media/Entry.
	expect(before.markup?.draft).toContain(`a="${media.id}"`);
	await admin.api.templates.saveEntryTemplateMarkup({ ...copiedHolder, markup: before.markup?.draft ?? "" });
	const history = await admin.api.history.list({
		siteId: destination,
		item: { kind: "component", id: copiedTarget.componentId },
	});
	const revision = history.copies.find((c) => c.type === "revision");
	const checkpoint = history.copies.find((c) => c.type === "checkpoint" && c.reason === "left");
	await admin.api.history.restore({
		siteId: destination,
		item: { kind: "component", id: copiedTarget.componentId },
		copy: { type: "revision", id: revision?.id ?? "" },
	});
	const restored = await admin.api.templates.getEntryTemplateMarkup(copiedHolder);
	expect(restored.markup?.draft).toContain(`a="media:${newMedia?.id}"`);
	expect(restored.markup?.draft).toContain(`b="${media.id}"`);
	const placed = restored.template?.draft.nodes[0];
	const part = placed?.type === "component" ? placed.props.find((p) => p.name === "card")?.value[0] : undefined;
	if (part?.type !== "text") throw new Error("Missing Group");
	const values = JSON.parse(part.text);
	expect(values.a).not.toBe(entry.id);
	expect(values.b).toBe(entry.id);
	expect((await admin.api.entries.get({ siteId: destination, entryId: values.a })).entry.draft.title).toBe("Linked");
	expect((await admin.api.components.getMarkup(copiedTarget)).propImpact.placements).toBe(0);
	await admin.api.history.restore({
		siteId: destination,
		item: { kind: "component", id: copiedTarget.componentId },
		copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
	});
	expect((await admin.api.components.getMarkup(copiedTarget)).propImpact.placements).toBe(1);
	await admin.api.components.publish(copiedTarget);
	const final = await admin.api.templates.getEntryTemplateMarkup(copiedHolder);
	expect(final.markup?.draft).toContain(`a="${media.id}"`);
	expect(final.markup?.draft).not.toContain(newMedia?.id ?? "missing");
	expect(final.markup?.draft).not.toContain(values.a);
});

test("separate source deletions survive translated typed transfer and restoration before publish", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), "bound.jpg"),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
	});
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Linked" });
	const declarations =
		'{{@props}}\ncard: group fields=[{"key":"a","label":"A","type":"media"},{"key":"b","label":"B","type":"text"}]\nrows: repeater fields=[{"key":"a","label":"A","type":"relationship","postTypes":["stories"]},{"key":"b","label":"B","type":"text"}]\n{{/props}}\n';
	const { component: inner } = await admin.api.components.create({ siteId, name: "Inner" });
	await admin.api.components.saveMarkup({
		siteId,
		componentId: inner.id,
		markup: `${declarations}<img src="{{ props.card.a }}" alt="Original"><p>{{ props.card.b }}</p>{{@loop props.rows as row}}<p>{{ row.b }}</p>{{/loop}}`,
	});
	await admin.api.components.publish({ siteId, componentId: inner.id });
	const { component: outer } = await admin.api.components.create({ siteId, name: "Outer" });
	const target = { siteId, componentId: outer.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup: `${declarations}<Inner card="{{ props.card }}" rows="{{ props.rows }}" />`,
	});
	await admin.api.components.publish(target);
	const card = JSON.stringify({ a: media.id, b: media.id });
	const rows = JSON.stringify([
		{ a: entry.id, b: entry.id },
		{ a: entry.id, b: "Second" },
	]);
	const italian = JSON.stringify([
		{ a: entry.id, b: entry.id },
		{ a: entry.id, b: "Secondo" },
	]);
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<Outer card='{{ ${JSON.stringify(card)} it: ${JSON.stringify(card)} }}' rows='{{ ${JSON.stringify(rows)} it: ${JSON.stringify(italian)} }}' />`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const props = structuredClone(original.component.draft.props);
	for (const prop of props) {
		if (!("fields" in prop) || !prop.fields[1]) throw new Error("Missing declarations");
		prop.fields = [prop.fields[1]];
	}
	await admin.api.components.saveDraft({ ...target, props });
	const deleted = await admin.api.components.getMarkup(target);
	await admin.api.components.saveMarkup({ ...target, markup: deleted.markup.draft });
	for (const prop of props) if ("fields" in prop && prop.fields[0]) prop.fields[0].key = "a";
	await admin.api.components.saveDraft({ ...target, props });
	await admin.api.history.leave({ siteId, item: { kind: "component", id: outer.id } });
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Bound retention",
		slug: "bound-retention",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const components = (await admin.api.components.list({ siteId: destination })).components;
	const copiedOuter = components.find((c) => c.name === "Outer");
	const copiedTarget = { siteId: destination, componentId: copiedOuter?.id ?? "" };
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((t) => t.key === "stories");
	const holder = { siteId: destination, postTypeId: type?.id ?? "" };
	const [newMedia] = (await admin.api.media.list({ siteId: destination })).items;
	const [newEntry] = (await admin.api.entries.list(holder)).entries;
	if (!newMedia || !newEntry) throw new Error("Missing transferred references");
	const item = { kind: "component" as const, id: copiedTarget.componentId };
	const { copies } = await admin.api.history.list({ siteId: destination, item });
	const revision = copies.find((c) => c.type === "revision");
	const checkpoint = copies.find((c) => c.type === "checkpoint" && c.reason === "left");
	// Restoring both copies must keep identity metadata and typed retained values composable.
	for (const copy of [revision, checkpoint, revision]) {
		if (!copy) throw new Error("Missing historical contract");
		await admin.api.history.restore({ siteId: destination, item, copy: { type: copy.type, id: copy.id } });
	}
	const restored = await admin.api.components.getMarkup(copiedTarget);
	await admin.api.components.saveMarkup({ ...copiedTarget, markup: restored.markup.draft });
	const placement = (await admin.api.templates.getEntryTemplate(holder)).template?.draft.nodes[0];
	if (placement?.type !== "component") throw new Error("Missing restored Placement");
	const [group, repeater] = placement.props.map((prop) => prop.value[0]);
	if (group?.type !== "text" || repeater?.type !== "text") throw new Error("Missing translated values");
	for (const value of [group.text, group.translations?.it ?? ""])
		expect(JSON.parse(value)).toEqual({ a: newMedia.id, b: media.id });
	expect(JSON.parse(repeater.text)).toEqual([
		{ a: newEntry.id, b: entry.id },
		{ a: newEntry.id, b: "Second" },
	]);
	expect(JSON.parse(repeater.translations?.it ?? "")).toEqual([
		{ a: newEntry.id, b: entry.id },
		{ a: newEntry.id, b: "Secondo" },
	]);
	expect(restored.propImpact.placements).toBe(0);
	await publishEverything(admin, destination);
	const origin = await goLive(install, destination);
	const html = await install.request(`${origin}/stories/linked`).then(expectSafePage);
	const url = (await admin.api.media.get({ siteId: destination, mediaId: newMedia.id })).media.url;
	expect(html).toContain(`src="${url}"`);
	expect(html).toContain(`${media.id}</p>`);
	expect(html).toContain(`${entry.id}</p>`);
	expect(html).toContain("Second</p>");
	expect(html).not.toContain("data-wc-bindings");
});
