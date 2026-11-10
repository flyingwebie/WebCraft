/** Public transfer fixtures: a Gallery's source contract differs from the installed version. */
import { expect } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import extraBlocks from "../../modules/extra-blocks/src/index.ts";
import { photo, upload } from "./images.ts";
import { createTestInstall, type TestInstall } from "./index.ts";
import { exportedArchive, importArchive } from "./site-transfer.ts";

/** A Component Block as the public Entry API returns it. */
export type ComponentBlock = {
	id: string;
	type: "component";
	component: string;
	props: { name: string; value: string }[];
	source?: { id: string; by: string; was: Record<string, DocumentJson> };
};

export const changedGallery: ModuleDefinition = {
	manifest: { ...extraBlocks.manifest, version: "2.0.0" },
	siteScript: { code: "document.documentElement.dataset.contract = 'v2';", whenUsed: ["Gallery"] },
	blockTypes: [
		{
			name: "Gallery",
			label: { en: "Gallery", it: "Galleria" },
			markup: "<p>Incompatible Gallery</p>",
			props: [
				{
					key: "images",
					label: { en: "Images", it: "Immagini" },
					type: "repeater",
					fields: [
						{ key: "image", label: { en: "Literal", it: "Testo" }, type: "text" },
						{ key: "alt", label: { en: "Media", it: "Media" }, type: "media" },
						{ key: "caption", label: { en: "Caption", it: "Didascalia" }, type: "text" },
						{ key: "decorative", label: { en: "Decorative", it: "Decorativo" }, type: "boolean" },
					],
				},
			],
		},
	],
};

export function galleryBlock(image: string, alt = "Original alt", caption = "Original caption"): ComponentBlock {
	return {
		id: "gallery",
		type: "component",
		component: "extra-blocks:Gallery",
		props: [
			{
				name: "images",
				value: JSON.stringify([{ image, alt, caption, decorative: false }]),
			},
		],
	};
}

export function galleryImage(block: ComponentBlock): {
	image: string;
	alt: string;
	caption: string;
	decorative: boolean;
} {
	return JSON.parse(block.props[0]?.value ?? "[]")[0];
}

export async function galleryArchive(
	options: { module?: ModuleDefinition; altIsMedia?: boolean } = {},
): Promise<{ bytes: Uint8Array; originalMedia: string }> {
	const module = options.module ?? extraBlocks;
	const source = await createTestInstall({ modules: [module] });
	try {
		const admin = await source.superadmin();
		await admin.api.modules.approve({ moduleId: "extra-blocks", version: module.manifest.version });
		const workspace = await source.createWorkspace("Gallery source");
		const { id: siteId } = await source.createSite(workspace.id, { slug: "source-gallery" });
		const { media } = await admin.api.media.upload({
			siteId,
			file: upload(await photo({ width: 40, height: 30 }), "gallery.jpg"),
		});
		await source.drainJobs();
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			key: "stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Gallery"] }],
		});
		const alt = options.altIsMedia ? media.id : "Original alt";
		const block = galleryBlock(media.id, alt, `Literal ${media.id}`);
		const { entry } = await admin.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Retained gallery",
			slug: "kept",
			fields: { body: [block, { id: "paragraph", type: "paragraph", text: "Original paragraph" }] },
		});
		await admin.api.entries.publish({ siteId, entryId: entry.id });
		const markup = (caption: string) =>
			`<article><h1>{{ title }}</h1><p data-wc-id="lead">Original lead</p><Gallery data-wc-id="fixed" images='${galleryBlock(media.id, alt, caption).props[0]?.value}' /><div>{{ body }}</div></article>`;
		const { template } = await admin.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: markup("Earlier caption"),
		});
		await admin.api.templates.publish({ siteId, templateId: template.id });
		await source.clock.advance(60_000);
		await admin.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: markup(`Literal ${media.id}`),
		});
		await admin.api.templates.publish({ siteId, templateId: template.id });
		const { component } = await admin.api.components.create({ siteId, name: "FixedGallery" });
		await admin.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: `<section><p data-wc-id="note">Original note</p><Gallery data-wc-id="nested" images='${block.props[0]?.value}' /></section>`,
		});
		await admin.api.components.publish({ siteId, componentId: component.id });
		return { bytes: await exportedArchive(source, admin, siteId), originalMedia: media.id };
	} finally {
		await source.close();
	}
}

export async function importGallery(install: TestInstall, bytes: Uint8Array, slug: string) {
	const admin = await install.superadmin();
	const workspace = await install.createWorkspace(slug);
	const result = await importArchive(install, admin, workspace.id, bytes, { name: slug, slug });
	expect(result.status).toBe("done");
	const siteId = result.site?.id ?? "";
	const postType = (await admin.api.postTypes.list({ siteId })).postTypes.find((p) => p.key === "stories");
	const postTypeId = postType?.id ?? "";
	const entry = (await admin.api.entries.list({ siteId, postTypeId })).entries[0];
	const component = (await admin.api.components.list({ siteId })).components.find((c) => c.name === "FixedGallery");
	const { template } = await admin.api.templates.getEntryTemplate({ siteId, postTypeId });
	const block = ((entry?.draft.fields.body ?? []) as ComponentBlock[]).find((block) => block.type === "component");
	if (!entry || !block) throw new Error("The imported Gallery Entry is missing");
	return {
		admin,
		workspaceId: workspace.id,
		siteId,
		postTypeId,
		entryId: entry?.id ?? "",
		componentId: component?.id ?? "",
		templateId: template?.id ?? "",
		block,
		mediaId: galleryImage(block).image,
	};
}
