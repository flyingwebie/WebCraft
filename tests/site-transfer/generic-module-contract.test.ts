import { expect, test } from "bun:test";
import type { ComponentProp, ModuleDefinition } from "@webcraft/module-sdk";
import extraBlocks from "../../modules/extra-blocks/src/index.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall } from "../harness/index.ts";
import type { ComponentBlock } from "../harness/module-contracts.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";

for (const nested of [false, true]) {
	test(`the generic Module contract fence catches ${nested ? "Group/Repeater" : "top-level"} same-key type changes`, async () => {
		const label = { en: "Value", it: "Valore" };
		const definition = (changed: boolean): ModuleDefinition => {
			const leaves: ComponentProp[] = [
				{ key: "asset", label, type: changed ? "text" : "media" },
				{ key: "literal", label, type: changed ? "media" : "text" },
			];
			const props: ComponentProp[] = nested
				? [
						{
							key: "bundle",
							label,
							type: "group",
							fields: [
								{
									key: "items",
									label,
									type: "repeater",
									fields: leaves,
								},
							],
						},
					]
				: leaves;
			return {
				manifest: { ...extraBlocks.manifest, id: "contract-fields", version: changed ? "2.0.0" : "1.0.0" },
				components: [{ name: "Sample", label, props, markup: `<p>${changed ? "Current" : "Source"} type</p>` }],
			};
		};
		const props = (media: string, literal: string) =>
			nested
				? [{ name: "bundle", value: JSON.stringify({ items: [{ asset: media, literal }] }) }]
				: [
						{ name: "asset", value: `media:${media}` },
						{ name: "literal", value: `media:${literal}` },
					];
		const source = await createTestInstall({ modules: [definition(false)] });
		const target = await createTestInstall({ modules: [definition(true)] });
		try {
			const admin = await source.superadmin();
			await admin.api.modules.approve({ moduleId: "contract-fields", version: "1.0.0" });
			const workspace = await source.createWorkspace("Source");
			const { id: siteId } = await source.createSite(workspace.id, { slug: "source" });
			const { media } = await admin.api.media.upload({
				siteId,
				file: upload(await photo({ width: 20, height: 20 }), "asset.jpg"),
			});
			await source.drainJobs();
			const { postType } = await admin.api.postTypes.create({
				siteId,
				name: "Stories",
				key: "stories",
				urlPattern: "/stories/{slug}",
				fields: [{ key: "body", label: "Body", type: "body", components: ["contract-fields:Sample"] }],
			});
			await admin.api.entries.create({
				siteId,
				postTypeId: postType.id,
				title: "Source",
				fields: {
					body: [
						{ id: "stable", type: "component", component: "contract-fields:Sample", props: props(media.id, media.id) },
					],
				},
			});
			const receiver = await target.superadmin();
			await receiver.api.modules.approve({ moduleId: "contract-fields", version: "2.0.0" });
			const destination = await target.createWorkspace("Destination");
			const copy = await importArchive(target, receiver, destination.id, await exportedArchive(source, admin, siteId), {
				name: "Copy",
				slug: "copy",
			});
			expect(copy.status).toBe("done");
			const copiedSite = copy.site?.id ?? "";
			const type = (await receiver.api.postTypes.list({ siteId: copiedSite })).postTypes.find(
				(p) => p.key === "stories",
			);
			const copiedType = type?.id ?? "";
			const entry = (await receiver.api.entries.list({ siteId: copiedSite, postTypeId: copiedType })).entries[0];
			const block = ((entry?.draft.fields.body ?? []) as ComponentBlock[])[0];
			if (!entry || !block) throw new Error("Imported Sample is missing");
			const value = block.props[0]?.value ?? "";
			const remapped = nested ? JSON.parse(value).items[0].asset : value.slice("media:".length);
			expect(remapped).not.toBe(media.id);
			const mixed = { ...block, props: props(remapped, remapped) };
			await expect(
				receiver.api.entries.create({
					siteId: copiedSite,
					postTypeId: copiedType,
					title: "Mixed",
					fields: { body: [mixed] },
				}),
			).rejects.toMatchObject({ code: "ENTRY_INVALID" });
			await expect(
				receiver.api.entries.saveDraft({ siteId: copiedSite, entryId: entry.id, fields: { body: [mixed] } }),
			).rejects.toMatchObject({ code: "ENTRY_INVALID" });
			expect(
				(await receiver.api.entries.bodyComponents({ siteId: copiedSite, postTypeId: copiedType })).components,
			).toEqual([]);
			const kept = await receiver.api.entries.saveDraft({
				siteId: copiedSite,
				entryId: entry.id,
				title: "Other edit",
				fields: { body: [block] },
			});
			expect(kept.entry.draft.fields.body).toEqual([block]);
		} finally {
			await source.close();
			await target.close();
		}
	});
}
