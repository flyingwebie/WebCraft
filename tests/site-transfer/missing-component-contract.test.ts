import { expect, test } from "bun:test";
import { component } from "@webcraft/module-sdk";
import { createTestInstall } from "../harness/index.ts";
import { downloadExport, exportSite, importArchive } from "../harness/site-transfer.ts";
import { sample } from "../modules/sample/index.ts";

test("export refuses stored Module Props when the source Module disappeared before declarations were retained", async () => {
	const install = await createTestInstall({ modules: [sample] });
	try {
		let admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
		const workspaceId = (await install.createWorkspace("Unknown Component contract")).id;
		const siteId = (await install.createSite(workspaceId, { slug: "unknown-component" })).id;
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			key: "stories",
			urlPattern: "/stories/{slug}",
		});
		await admin.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<NoteCard body="123e4567-e89b-42d3-a456-426614174000"/>',
		});
		await install.restart({ modules: [] });
		admin = await install.superadmin();
		const exported = await exportSite(install, admin, siteId);
		expect(exported.status).toBe("failed");
		expect(exported.download).toBeNull();
		expect(install.logs.filter((line) => line.msg === "A Site export failed").map((line) => line.level)).toEqual([
			"warn",
		]);
	} finally {
		await install.close();
	}
});

test("an unavailable Module's Component with no stored Props can still move losslessly", async () => {
	const install = await createTestInstall({
		modules: [
			{
				...sample,
				components: [
					component({
						name: "EmptyCard",
						label: { en: "Empty card", it: "Scheda vuota" },
						markup: "<aside>Empty</aside>",
					}),
				],
			},
		],
	});
	try {
		let admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
		const workspaceId = (await install.createWorkspace("Empty Component Props")).id;
		const siteId = (await install.createSite(workspaceId, { slug: "empty-component" })).id;
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			key: "stories",
			urlPattern: "/stories/{slug}",
		});
		await admin.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup: "<EmptyCard/>" });
		await install.restart({ modules: [] });
		admin = await install.superadmin();
		const exported = await exportSite(install, admin, siteId);
		expect(exported.status).toBe("done");
		expect(exported.download).not.toBeNull();
		const archive = new Uint8Array(await (await downloadExport(install, admin, exported)).arrayBuffer());
		const imported = await importArchive(install, admin, workspaceId, archive, {
			name: "Empty copy",
			slug: "empty-copy",
		});
		expect(imported.status).toBe("done");
		const destination = imported.site?.id ?? "";
		const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
			(type) => type.key === "stories",
		);
		const { template } = await admin.api.templates.getEntryTemplate({
			siteId: destination,
			postTypeId: copiedType?.id ?? "",
		});
		expect(template?.draft.nodes[0]).toMatchObject({ type: "component", component: "sample:EmptyCard", props: [] });
	} finally {
		await install.close();
	}
});
