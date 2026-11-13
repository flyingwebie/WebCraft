import { expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, rewritten, uploadArchive } from "../harness/site-transfer.ts";

test("Extra blocks cross Installs: allowances and declarations survive, real Media remaps, literal UUID text does not", async () => {
	const source = await createTestInstall();
	const target = await createTestInstall();
	try {
		const admin = await source.superadmin();
		await admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const ws = await source.createWorkspace("Source");
		const site = await source.createSite(ws.id, { slug: "source-extra" });
		const { media } = await admin.api.media.upload({
			siteId: site.id,
			file: upload(await photo({ width: 40, height: 30 }), "transfer.jpg"),
		});
		await source.drainJobs();
		const { postType } = await admin.api.postTypes.create({
			siteId: site.id,
			name: "Stories",
			key: "stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Gallery", "extra-blocks:Tabs"] }],
		});
		const { entry } = await admin.api.entries.create({
			siteId: site.id,
			postTypeId: postType.id,
			title: "Gallery",
			fields: {
				body: [
					{
						id: "stable-gallery",
						type: "component",
						component: "extra-blocks:Gallery",
						props: [
							{
								name: "images",
								value: JSON.stringify([
									{ image: media.id, alt: media.id, caption: `Literal ${media.id}`, decorative: false },
								]),
							},
						],
					},
				],
			},
		});
		await admin.api.entries.publish({ siteId: site.id, entryId: entry.id });
		const bytes = await exportedArchive(source, admin, site.id);
		const receiving = await target.superadmin();
		await receiving.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const destination = await target.createWorkspace("Destination");
		const result = await importArchive(target, receiving, destination.id, bytes, {
			name: "Extra copy",
			slug: "extra-copy",
		});
		expect(result.failure).toBeNull();
		expect(result.status).toBe("done");
		const siteId = result.site?.id ?? "";
		const copied = (await receiving.api.postTypes.list({ siteId })).postTypes.find((p) => p.key === "stories");
		expect(copied?.fields[0]).toMatchObject({ components: ["extra-blocks:Gallery", "extra-blocks:Tabs"] });
		const read = (await receiving.api.entries.list({ siteId, postTypeId: copied?.id ?? "" })).entries[0];
		const block = (
			(read?.draft.fields.body ?? []) as { id: string; component: string; props: { name: string; value: string }[] }[]
		)[0];
		expect(block).toMatchObject({ id: "stable-gallery", component: "extra-blocks:Gallery" });
		const image = JSON.parse(block?.props[0]?.value ?? "[]")[0];
		expect(image.image).not.toBe(media.id);
		expect(image.alt).toBe(media.id);
		expect(image.caption).toBe(`Literal ${media.id}`);
		expect((await receiving.api.media.get({ siteId, mediaId: image.image })).media.id).toBe(image.image);
		// A contract cannot silently omit stored keys: without their types an import cannot distinguish
		// a real Media reference from literal text. Missing and incomplete declarations fail atomically.
		for (const missing of ["component", "prop", "nested"] as const) {
			const damaged = rewritten(bytes, {
				manifest: (manifest) => {
					const gallery = manifest.moduleComponents.find(
						(component: { id: string }) => component.id === "extra-blocks:Gallery",
					);
					if (missing === "component")
						manifest.moduleComponents = manifest.moduleComponents.filter(
							(component: { id: string }) => component.id !== gallery.id,
						);
					else if (missing === "prop") gallery.props = [];
					else
						gallery.props[0].fields = gallery.props[0].fields.filter((field: { key: string }) => field.key !== "image");
				},
			});
			const refused = await importArchive(target, receiving, destination.id, damaged, {
				name: missing,
				slug: `missing-${missing}`,
			});
			expect(refused.status).toBe("failed");
			expect(refused.failure?.reason).toBe("damaged");
			expect(refused.site).toBeNull();
		}
		const invalid = rewritten(bytes, {
			manifest: (manifest) => {
				manifest.moduleComponents[0].props = [null];
			},
		});
		await expect(uploadArchive(receiving, destination.id, invalid)).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "not-an-export" },
		});
		// Intermediate unpublished layouts can recover exact-version contracts from the current build.
		for (const formatVersion of [1, 2]) {
			const legacy = rewritten(bytes, {
				manifest: (manifest) => {
					manifest.formatVersion = formatVersion;
					delete manifest.moduleComponents;
				},
			});
			const imported = await importArchive(target, receiving, destination.id, legacy, {
				name: "Legacy",
				slug: `legacy-${formatVersion}`,
			});
			expect(imported.status).toBe("done");
		}
	} finally {
		await source.close();
		await target.close();
	}
});

for (const destination of ["missing", "changed"] as const) {
	test(`source Module declarations preserve typed Media and literal text across a ${destination} Module and re-export`, async () => {
		const extraBlocks = (await import("../../modules/extra-blocks/src/index.ts")).default;
		const changed: import("@webcraft/module-sdk").ModuleDefinition = {
			manifest: { ...extraBlocks.manifest, version: "2.0.0" },
			blockTypes: [
				{
					name: "Gallery",
					label: { en: "Gallery", it: "Galleria" },
					markup: "<p>New Gallery</p>",
					props: [
						{
							key: "images",
							label: { en: "Images", it: "Immagini" },
							type: "repeater",
							fields: [
								{ key: "image", label: { en: "Literal", it: "Testo" }, type: "text" },
								{ key: "alt", label: { en: "Media", it: "Media" }, type: "media" },
								{ key: "caption", label: { en: "Caption", it: "Didascalia" }, type: "text" },
							],
						},
					],
				},
			],
		};
		const source = await createTestInstall({ modules: [extraBlocks] });
		const target = await createTestInstall({ modules: destination === "missing" ? [] : [changed] });
		try {
			const admin = await source.superadmin();
			await admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
			const workspace = await source.createWorkspace("Original declarations");
			const { id: siteId } = await source.createSite(workspace.id, { slug: "original" });
			const { media } = await admin.api.media.upload({
				siteId,
				file: upload(await photo({ width: 40, height: 30 }), "typed.jpg"),
			});
			await source.drainJobs();
			const { postType } = await admin.api.postTypes.create({
				siteId,
				name: "Stories",
				key: "stories",
				urlPattern: "/stories/{slug}",
				fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Gallery"] }],
			});
			const images = [{ image: media.id, alt: media.id, caption: `Literal ${media.id}`, decorative: false }];
			await admin.api.entries.create({
				siteId,
				postTypeId: postType.id,
				title: "Kept",
				fields: {
					body: [
						{
							id: "stable",
							type: "component",
							component: "extra-blocks:Gallery",
							props: [{ name: "images", value: JSON.stringify(images) }],
						},
					],
				},
			});
			const { component } = await admin.api.components.create({ siteId, name: "FixedGallery" });
			await admin.api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: `<Gallery images='${JSON.stringify(images)}' />`,
			});
			await admin.api.components.publish({ siteId, componentId: component.id });
			let bytes = await exportedArchive(source, admin, siteId);
			let lastMedia = media.id;
			for (const [install, browser, slug] of [
				[target, await target.superadmin(), "middle"],
				[source, admin, "returned"],
			] as const) {
				if (destination === "changed" && install === target) {
					expect((await browser.api.modules.list()).modules[0]?.status).not.toBe("cannot-run");
				}
				const ws = await install.createWorkspace(slug);
				const result = await importArchive(install, browser, ws.id, bytes, { name: slug, slug });
				expect(result.status).toBe("done");
				if (install === target)
					expect(result.report?.modules.find((module) => module.id === "extra-blocks")).toMatchObject({
						version: "1.0.0",
						keptAside: true,
					});
				const copiedSite = result.site?.id ?? "";
				const pt = (await browser.api.postTypes.list({ siteId: copiedSite })).postTypes.find(
					(p) => p.key === "stories",
				);
				const entry = (await browser.api.entries.list({ siteId: copiedSite, postTypeId: pt?.id ?? "" })).entries[0];
				const block = ((entry?.draft.fields.body ?? []) as { id: string; props: { value: string }[] }[])[0];
				expect(block?.id).toBe("stable");
				const image = JSON.parse(block?.props[0]?.value ?? "[]")[0];
				expect(image.image).not.toBe(lastMedia);
				expect(image.image).not.toBe(media.id);
				expect(image.alt).toBe(media.id);
				expect(image.caption).toBe(`Literal ${media.id}`);
				expect((await browser.api.media.get({ siteId: copiedSite, mediaId: image.image })).media.id).toBe(image.image);
				const fixed = (await browser.api.components.list({ siteId: copiedSite })).components.find(
					(c) => c.name === "FixedGallery",
				);
				const markup = (await browser.api.components.getMarkup({ siteId: copiedSite, componentId: fixed?.id ?? "" }))
					.markup.draft;
				expect(markup).toContain(image.image);
				expect(markup).toContain(`Literal ${media.id}`);
				if (install === target) {
					await install.clock.advance(91 * 24 * 60 * 60 * 1000);
					await install.drainJobs();
					await expect(
						(await install.superadmin()).api.siteImports.get({ workspaceId: ws.id, importId: result.id }),
					).rejects.toMatchObject({
						code: "SITE_IMPORT_NOT_FOUND",
					});
				}
				lastMedia = image.image;
				bytes = await exportedArchive(install, await install.superadmin(), copiedSite);
			}
		} finally {
			await source.close();
			await target.close();
		}
	});
}
