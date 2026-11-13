import { expect, test } from "bun:test";
import { createTestInstall } from "../harness/index.ts";
import { galleryArchive, importGallery } from "../harness/module-contracts.ts";

test("retained missing-Module Component names stay reserved on their imported Site", async () => {
	const archive = await galleryArchive();
	const install = await createTestInstall({ modules: [] });
	try {
		const { admin, workspaceId, siteId, postTypeId, componentId } = await importGallery(
			install,
			archive.bytes,
			"reserved-source-names",
		);
		const taken = {
			code: "COMPONENT_NAME_TAKEN",
			data: { name: "Gallery", by: { kind: "module", moduleId: "extra-blocks" } },
		};
		await expect(admin.api.components.create({ siteId, name: "Gallery" })).rejects.toMatchObject(taken);
		const local = await admin.api.components.create({ siteId, name: "LocalGallery" });
		await expect(
			admin.api.components.rename({ siteId, componentId: local.component.id, name: "Gallery" }),
		).rejects.toMatchObject(taken);
		expect((await admin.api.components.get({ siteId, componentId: local.component.id })).component.name).toBe(
			"LocalGallery",
		);
		const query = { siteId, postTypeId };
		const before = await admin.api.templates.getEntryTemplateMarkup(query);
		expect(before.markup?.draft).toContain("<Gallery");
		await admin.api.templates.saveEntryTemplate({
			...query,
			tree: JSON.parse(JSON.stringify(before.template?.draft).replace("Original lead", "Other lead")),
		});
		const markup = (await admin.api.templates.getEntryTemplateMarkup(query)).markup?.draft ?? "";
		expect(markup).toContain("<Gallery");
		expect(markup).not.toContain("<extra-blocks:Gallery");
		const saved = await admin.api.templates.saveEntryTemplateMarkup({
			...query,
			markup: markup.replace("Other lead", "Another lead"),
		});
		expect(saved.markup).toContain("Another lead");
		const fixed = await admin.api.components.getMarkup({ siteId, componentId });
		const component = await admin.api.components.saveMarkup({
			siteId,
			componentId,
			markup: fixed.markup.draft.replace("Original note", "Other note"),
		});
		expect(component.markup).toContain("<Gallery");
		expect(component.markup).toContain("Other note");
		// The retained name belongs to this Site, not every Site sharing its Workspace or Install.
		const sameWorkspace = await install.createSite(workspaceId, { slug: "independent-names" });
		const independent = await admin.api.components.create({ siteId: sameWorkspace.id, name: "Gallery" });
		expect(independent.component.name).toBe("Gallery");
		const otherWorkspace = await install.createWorkspace("Other contracts");
		const otherSite = await install.createSite(otherWorkspace.id, { slug: "other-names" });
		const other = await admin.api.components.create({ siteId: otherSite.id, name: "Gallery" });
		expect(other.component.name).toBe("Gallery");
	} finally {
		await install.close();
	}
});
