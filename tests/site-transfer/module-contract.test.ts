import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import extraBlocks from "../../modules/extra-blocks/src/index.ts";
import { withValue } from "../co-editing/support.ts";
import { openDraft } from "../harness/co-editing.ts";
import { taggedTranslation } from "../harness/fake-ai.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import {
	type ComponentBlock,
	changedGallery,
	galleryArchive,
	galleryBlock,
	galleryImage,
	importGallery,
} from "../harness/module-contracts.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { AI_KEY } from "../translation/support.ts";

let install: TestInstall;
let archive: Awaited<ReturnType<typeof galleryArchive>>;
beforeAll(async () => {
	archive = await galleryArchive();
	install = await createTestInstall({ modules: [changedGallery] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "extra-blocks", version: "2.0.0" });
});
afterAll(async () => {
	await install?.close();
});

test("imported source Props fence incompatible same-key types while unchanged Body JSON and Markdown stay editable", async () => {
	const { admin, siteId, postTypeId, entryId, templateId, block, mediaId } = await importGallery(
		install,
		archive.bytes,
		"body-contract",
	);
	await admin.api.modules.setOnSite({ siteId, moduleId: "extra-blocks", on: true });
	const mixed = galleryBlock(mediaId, mediaId, "Written with v2");
	// The Spec repro used a new v2 Entry, while the existing Site's archive still described v1.
	await expect(
		admin.api.entries.create({ siteId, postTypeId, title: "New v2", fields: { body: [mixed] } }),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await expect(admin.api.entries.saveDraft({ siteId, entryId, fields: { body: [mixed] } })).rejects.toMatchObject({
		code: "ENTRY_INVALID",
	});
	expect((await admin.api.entries.bodyComponents({ siteId, postTypeId })).components).toEqual([]);
	const kept = await admin.api.entries.saveDraft({
		siteId,
		entryId,
		title: "Other edit",
		fields: { body: [{ id: "paragraph", type: "paragraph", text: "Unrelated paragraph" }, block] },
	});
	expect(kept.entry.draft.fields.body).toEqual([
		{ id: "paragraph", type: "paragraph", text: [{ text: "Unrelated paragraph" }] },
		block,
	]);
	const markdown = (await admin.api.entries.get({ siteId, entryId, bodyFormat: "markdown" })).entry.draft.fields
		.body as string;
	const saved = await admin.api.entries.saveDraft({
		siteId,
		entryId,
		bodyFormat: "markdown",
		fields: { body: markdown.replace("Unrelated paragraph", "Markdown paragraph") },
	});
	expect((saved.entry.draft.fields.body as unknown[])[1]).toEqual(block);
	await expect(
		admin.api.entries.saveDraft({
			siteId,
			entryId,
			bodyFormat: "markdown",
			fields: { body: markdown.replace("Original alt", "Changed alt") },
		}),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await expect(
		admin.api.entries.create({
			siteId,
			postTypeId,
			title: "New Markdown",
			bodyFormat: "markdown",
			fields: { body: markdown },
		}),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await admin.api.templates.publish({ siteId, templateId });
	const published = await admin.api.entries.publish({ siteId, entryId });
	const origin = await goLive(install, siteId);
	const html = await expectSafePage(await install.request(`${origin}/stories/${published.entry.published?.slug}`));
	expect(html).toContain("Markdown paragraph");
	expect(html).not.toContain("Incompatible Gallery");
	expect(html).not.toContain('data-wc-module="extra-blocks"');
	const copy = await importGallery(install, await exportedArchive(install, admin, siteId), "body-contract-again");
	expect(copy.mediaId).not.toBe(mediaId);
	expect(galleryImage(copy.block)).toEqual({ ...galleryImage(block), image: copy.mediaId });
	expect(galleryImage(copy.block).caption).toBe(`Literal ${archive.originalMedia}`);
	expect((await copy.admin.api.media.get({ siteId: copy.siteId, mediaId: copy.mediaId })).media.id).toBe(copy.mediaId);
});

test("fixed Template and Component Props keep their source contract through JSON, markup and history", async () => {
	const { admin, siteId, postTypeId, componentId, templateId, mediaId } = await importGallery(
		install,
		archive.bytes,
		"fixed-contract",
	);
	const query = { siteId, postTypeId };
	const target = { kind: "entryTemplate", postTypeId } as const;
	const opened = await admin.api.builder.open({ siteId, target });
	expect(opened.catalogue.components.some((component) => component.id === "extra-blocks:Gallery")).toBe(false);
	const preview = await admin.api.builder.preview({ siteId, target, tree: opened.tree });
	expect(preview.html).not.toContain("Incompatible Gallery");
	const before = await admin.api.templates.getEntryTemplateMarkup(query);
	const markup = before.markup?.draft ?? "";
	const changed = markup.replace("Original alt", mediaId);
	await expect(admin.api.templates.saveEntryTemplateMarkup({ ...query, markup: changed })).rejects.toMatchObject({
		code: "TEMPLATE_INVALID",
	});
	await expect(
		admin.api.templates.saveEntryTemplate({
			...query,
			tree: JSON.parse(JSON.stringify(before.template?.draft).replace("Original alt", mediaId)),
		}),
	).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
	await expect(
		admin.api.templates.saveEntryTemplateMarkup({
			...query,
			markup: markup.replace('data-wc-id="fixed"', 'data-wc-id="another"'),
		}),
	).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
	const saved = await admin.api.templates.saveEntryTemplateMarkup({
		...query,
		markup: markup.replace("Original lead", "Other lead"),
	});
	expect(saved.markup).toContain("Other lead");
	expect(saved.markup).toContain(mediaId);
	const componentQuery = { siteId, componentId };
	const fixed = await admin.api.components.getMarkup(componentQuery);
	await expect(
		admin.api.components.saveMarkup({ ...componentQuery, markup: fixed.markup.draft.replace("Original alt", mediaId) }),
	).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
	await expect(
		admin.api.components.saveDraft({
			...componentQuery,
			tree: JSON.parse(JSON.stringify(fixed.component.draft.tree).replace("Original alt", mediaId)),
		}),
	).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
	const unchanged = await admin.api.components.saveMarkup({
		...componentQuery,
		markup: fixed.markup.draft.replace("Original note", "Other note"),
	});
	expect(unchanged.markup).toContain("Other note");
	const item = { kind: "template", id: templateId } as const;
	const revisions = (await admin.api.history.list({ siteId, item })).copies.filter((c) => c.type === "revision");
	expect(revisions).toHaveLength(2);
	await admin.api.history.restore({ siteId, item, copy: { type: "revision", id: revisions[0]?.id ?? "" } });
	expect((await admin.api.templates.getEntryTemplateMarkup(query)).markup?.draft).toBe(markup);
	await expect(
		admin.api.history.restore({ siteId, item, copy: { type: "revision", id: revisions[1]?.id ?? "" } }),
	).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
	expect((await admin.api.templates.getEntryTemplateMarkup(query)).markup?.draft).toBe(markup);
});
for (const destination of ["changed", "missing"] as const) {
	test(`translation uses retained source Fields with a ${destination} Module, including re-translation and re-export`, async () => {
		const target = destination === "missing" ? await createTestInstall({ modules: [] }) : install;
		try {
			const { admin, workspaceId, siteId, entryId, block, mediaId } = await importGallery(
				target,
				archive.bytes,
				`translation-${destination}`,
			);
			await admin.api.languages.add({ siteId, code: "it" });
			await admin.api.translations.setMode({ siteId, language: "it", mode: "automatic" });
			await admin.api.aiKeys.setOwn({
				workspaceId,
				provider: "openai",
				model: "gpt-5-mini",
				endpoint: null,
				key: AI_KEY,
			});
			target.ai.translateWith(taggedTranslation);
			const from = target.ai.translations().length;
			await admin.api.entries.publish({ siteId, entryId });
			await admin.api.translations.translateNow({ siteId, language: "it" });
			expect((await target.drainJobs()).failed).toEqual([]);
			const read = async () => (await admin.api.entries.get({ siteId, entryId, language: "it" })).entry;
			const translated = await read();
			const translatedBlock = (translated.draft.fields.body as ComponentBlock[])[0];
			if (!translatedBlock) throw new Error("The translated Gallery is missing");
			expect(galleryImage(translatedBlock)).toEqual({
				...galleryImage(block),
				alt: "[it] Original alt",
				caption: `[it] Literal ${archive.originalMedia}`,
			});
			expect(translatedBlock.source).toMatchObject({
				id: block.id,
				by: "ai",
				was: { component: block.component, props: block.props },
			});
			const sent = target.ai
				.translations()
				.slice(from)
				.flatMap((r) => r.texts);
			expect(sent).toContain("Original alt");
			expect(sent.join("\n")).not.toContain(mediaId);
			// This is the foreground re-translate path, separate from the queued Automatic path.
			await admin.api.translations.retranslate({
				siteId,
				item: { kind: "entry", id: entryId },
				language: "it",
				at: "fields.body",
				block: block.id,
			});
			expect((await read()).draft.fields.body).toContainEqual(translatedBlock);
			await admin.api.entries.saveDraft({ siteId, entryId, language: "it", title: "Manual title" });
			const markdown = (await admin.api.entries.get({ siteId, entryId, language: "it", bodyFormat: "markdown" })).entry
				.draft.fields.body as string;
			await admin.api.entries.saveDraft({
				siteId,
				entryId,
				language: "it",
				bodyFormat: "markdown",
				fields: { body: markdown.replace("[it] Original paragraph", "Manual paragraph") },
			});
			await expect(
				admin.api.entries.saveDraft({
					siteId,
					entryId,
					language: "it",
					fields: { body: [{ ...translatedBlock, props: galleryBlock(mediaId, mediaId).props }] },
				}),
			).rejects.toMatchObject({ code: "ENTRY_INVALID" });
			const copy = await importGallery(
				target,
				await exportedArchive(target, admin, siteId),
				`translated-again-${destination}`,
			);
			const translatedCopy = (
				await copy.admin.api.entries.get({ siteId: copy.siteId, entryId: copy.entryId, language: "it" })
			).entry;
			const copiedBlock = (translatedCopy.draft.fields.body as ComponentBlock[])[0];
			if (!copiedBlock) throw new Error("The translated copy is missing");
			expect(galleryImage(copiedBlock).image).toBe(copy.mediaId);
			expect(galleryImage(copiedBlock).alt).toBe("[it] Original alt");
			expect(copiedBlock.source?.was).toMatchObject({ props: copy.block.props });
		} finally {
			if (target !== install) await target.close();
		}
	});
}

test("co-editing refuses mixed Body and fixed Props and restores the shared Draft, while unrelated edits still save", async () => {
	const { admin, siteId, postTypeId, entryId, templateId, block, mediaId } = await importGallery(
		install,
		archive.bytes,
		"shared-contract",
	);
	const entry = await openDraft(install, admin, siteId, { kind: "entry", id: entryId });
	const template = await openDraft(install, admin, siteId, { kind: "template", id: templateId });
	try {
		entry.change((draft) => withValue(draft, "body", [galleryBlock(mediaId, mediaId, "Mixed")] as DocumentJson));
		await entry.until(() => entry.refusals.length === 1, "Body's incompatible contract refusal");
		expect(entry.refusals[0]?.code).toBe("ENTRY_INVALID");
		await entry.untilDraft((draft) => JSON.stringify(draft).includes("Original alt"), "the original Block restored");
		entry.change((draft) => withValue(draft, "title", "Shared title"));
		await entry.saved();
		expect((await admin.api.entries.get({ siteId, entryId })).entry.draft.title).toBe("Shared title");
		template.change((draft) => JSON.parse(JSON.stringify(draft).replace("Original alt", mediaId)));
		await template.until(() => template.refusals.length === 1, "fixed Props' incompatible contract refusal");
		expect(template.refusals[0]?.code).toBe("TEMPLATE_INVALID");
		await template.untilDraft(
			(draft) => JSON.stringify(draft).includes("Original alt"),
			"the original Placement restored",
		);
		template.change((draft) => JSON.parse(JSON.stringify(draft).replace("Original lead", "Shared lead")));
		await template.saved();
		expect((await admin.api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft).toContain(
			"Shared lead",
		);
	} finally {
		entry.close();
		template.close();
	}
	const item = { kind: "entry", id: entryId } as const;
	const revision = (await admin.api.history.list({ siteId, item })).copies.find((c) => c.type === "revision");
	await admin.api.history.restore({ siteId, item, copy: { type: "revision", id: revision?.id ?? "" } });
	expect((await admin.api.entries.get({ siteId, entryId })).entry.draft.fields.body).toContainEqual(block);
});

test("the fence is per Site and admits another Module version with the same Prop declarations", async () => {
	const fresh = await install.createWorkspace("Fresh v2");
	const admin = await install.superadmin();
	const { id: siteId } = await install.createSite(fresh.id, { slug: "fresh-v2" });
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 20, height: 20 }), "new.jpg"),
	});
	await install.drainJobs();
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Gallery"] }],
	});
	const made = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Current contract",
		fields: { body: [galleryBlock(media.id, media.id)] },
	});
	expect(made.entry.problems).toEqual([]);
	const freshCopy = await importGallery(install, await exportedArchive(install, admin, siteId), "fresh-v2-copy");
	// v2 image is literal text; alt is Media. Fresh Sites have no v1 contract to mix into this archive.
	expect(galleryImage(freshCopy.block).image).toBe(media.id);
	expect(galleryImage(freshCopy.block).alt).not.toBe(media.id);
	const compatible = await createTestInstall({
		modules: [{ ...extraBlocks, manifest: { ...extraBlocks.manifest, version: "3.0.0" } }],
	});
	try {
		await (await compatible.superadmin()).api.modules.approve({ moduleId: "extra-blocks", version: "3.0.0" });
		const copy = await importGallery(compatible, archive.bytes, "compatible-contract");
		expect(
			(await copy.admin.api.entries.bodyComponents({ siteId: copy.siteId, postTypeId: copy.postTypeId })).components,
		).toMatchObject([{ id: "extra-blocks:Gallery" }]);
		const body = galleryBlock(copy.mediaId, "Compatible edit", "Allowed");
		const saved = await copy.admin.api.entries.saveDraft({
			siteId: copy.siteId,
			entryId: copy.entryId,
			fields: { body: [body] },
		});
		expect(saved.entry.problems).toEqual([]);
		const { entry } = await copy.admin.api.entries.create({
			siteId: copy.siteId,
			postTypeId: copy.postTypeId,
			title: "Also allowed",
			fields: { body: [body] },
		});
		expect(entry.problems).toEqual([]);
	} finally {
		await compatible.close();
	}
});
