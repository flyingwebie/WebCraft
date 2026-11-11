import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";

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
