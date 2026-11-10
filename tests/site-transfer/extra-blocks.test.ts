import { expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";

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
	} finally {
		await source.close();
		await target.close();
	}
});
