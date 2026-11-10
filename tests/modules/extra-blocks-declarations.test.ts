import { expect, test } from "bun:test";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import extraBlocks from "../../modules/extra-blocks/src/index.ts";
import { createTestInstall } from "../harness/index.ts";

const first = extraBlocks.blockTypes?.[0];
if (!first) throw new Error("Extra blocks must declare Gallery.");
const invalid: [string, ModuleDefinition][] = [
	["missing translated labels", { ...extraBlocks, blockTypes: [{ ...first, label: { en: "Gallery" } }] }],
	[
		"unsupported Field types",
		{
			...extraBlocks,
			blockTypes: [{ ...first, props: [{ key: "body", type: "body" as never, label: { en: "Body", it: "Corpo" } }] }],
		},
	],
	[
		"executable Template markup",
		{ ...extraBlocks, blockTypes: [{ ...first, markup: '<script>alert("bad")</script>' }] },
	],
	["duplicate Component and Block names", { ...extraBlocks, components: [first] }],
	["missing script Consent category", { ...extraBlocks, manifest: { ...extraBlocks.manifest, siteScript: undefined } }],
	[
		"unknown usage-gated names",
		{ ...extraBlocks, siteScript: { code: "void 0;", whenUsed: ["NotDeclared"] as never } },
	],
];
for (const [what, definition] of invalid) {
	test(`declarative Blocks cannot run with ${what}`, async () => {
		const install = await createTestInstall({ modules: [definition] });
		try {
			const admin = await install.superadmin();
			const { modules } = await admin.api.modules.list();
			expect(modules).toHaveLength(1);
			expect(modules[0]?.status).toBe("cannot-run");
			expect(modules[0]?.problem).toBeTruthy();
			await expect(admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" })).rejects.toMatchObject({
				code: "MODULE_CANNOT_RUN",
			});
		} finally {
			await install.close();
		}
	});
}

test("absent and malformed Modules retain allowances, JSON and Markdown while other Blocks remain editable", async () => {
	const install = await createTestInstall({ modules: [extraBlocks] });
	try {
		const admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const workspace = await install.createWorkspace("Unavailable Blocks");
		const site = await install.createSite(workspace.id, { slug: "unavailable" });
		const siteId = site.id;
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Accordion"] }],
		});
		const original = {
			id: "kept",
			type: "component",
			component: "extra-blocks:Accordion",
			props: [{ name: "items", value: JSON.stringify([{ heading: "Still here", text: "Unchanged" }]) }],
		};
		const { entry } = await admin.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Kept",
			fields: { body: [original] },
		});
		for (const modules of [[], [invalid[0]?.[1] as ModuleDefinition]]) {
			await install.restart({ modules });
			expect((await admin.api.entries.bodyComponents({ siteId, postTypeId: postType.id })).components).toEqual([]);
			await admin.api.postTypes.update({ siteId, postTypeId: postType.id, fields: postType.fields });
			const { entry: saved } = await admin.api.entries.saveDraft({
				siteId,
				entryId: entry.id,
				fields: { body: [original, { id: "plain", type: "paragraph", text: "Still editable" }] },
			});
			expect((saved.draft.fields.body as unknown[])[0]).toEqual(original);
			await admin.api.entries.publish({ siteId, entryId: entry.id });
			const markdown = (await admin.api.entries.get({ siteId, entryId: entry.id, bodyFormat: "markdown" })).entry.draft
				.fields.body;
			expect(markdown).toContain("<Accordion");
			expect(markdown).toContain("Unchanged");
			await expect(
				admin.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { body: [{ ...original, props: [] }] } }),
			).rejects.toMatchObject({ code: "ENTRY_INVALID" });
			await expect(
				admin.api.entries.saveDraft({ siteId, entryId: entry.id, bodyFormat: "markdown", fields: { body: markdown } }),
			).rejects.toMatchObject({ code: "ENTRY_INVALID" });
			expect((await admin.api.entries.get({ siteId, entryId: entry.id })).entry.draft.fields.body).toEqual(
				saved.draft.fields.body,
			);
		}
	} finally {
		await install.close();
	}
});

test("missing declarations leave Block translation pending until the Module returns", async () => {
	const { translatedSite } = await import("../translation/support.ts");
	const install = await createTestInstall({ modules: [extraBlocks] });
	try {
		await (await install.superadmin()).api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const site = await translatedSite(install, { it: "automatic" });
		await site.staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Tabs"] }],
		});
		const block = {
			id: "tabs",
			type: "component",
			component: "extra-blocks:Tabs",
			props: [
				{ name: "label", value: "Details" },
				{ name: "items", value: JSON.stringify([{ heading: "First", text: "One" }]) },
			],
		};
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Restored translation",
			fields: { body: [block] },
		});
		await install.restart({ modules: [] });
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		expect((await install.drainJobs()).failed).toEqual([]);
		const pending = (await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" }))
			.entry;
		expect(pending.draft.fields.body).toEqual([block]);
		await install.restart({ modules: [extraBlocks] });
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		expect((await install.drainJobs()).failed).toEqual([]);
		const translated = (await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" }))
			.entry;
		expect(JSON.stringify(translated.draft.fields.body)).toContain("[it] Details");
	} finally {
		await install.close();
	}
});

test("Markdown refuses an ambiguous Module/Site Component name instead of changing Block identity", async () => {
	const install = await createTestInstall({ modules: [] });
	try {
		const admin = await install.superadmin();
		const workspace = await install.createWorkspace("Before Module install");
		const { id: siteId } = await install.createSite(workspace.id, { slug: "same-name" });
		const { component } = await admin.api.components.create({ siteId, name: "Gallery" });
		await admin.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<aside>Site gallery</aside>" });
		await admin.api.components.publish({ siteId, componentId: component.id });
		await install.restart({ modules: [extraBlocks] });
		await admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "body", label: "Body", type: "body", components: [component.id, "extra-blocks:Gallery"] }],
		});
		const { entry } = await admin.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Names",
			fields: { body: [{ id: "module", type: "component", component: "extra-blocks:Gallery", props: [] }] },
		});
		const markdown = (await admin.api.entries.get({ siteId, entryId: entry.id, bodyFormat: "markdown" })).entry.draft
			.fields.body;
		await expect(
			admin.api.entries.saveDraft({ siteId, entryId: entry.id, bodyFormat: "markdown", fields: { body: markdown } }),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });
		expect((await admin.api.entries.get({ siteId, entryId: entry.id })).entry.draft.fields.body).toEqual(
			entry.draft.fields.body,
		);
		// The same refusal protects retained data after its Module disappears and Staff remove its allowance.
		await install.restart({ modules: [] });
		await admin.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: [{ key: "body", label: "Body", type: "body", components: [component.id] }],
		});
		await expect(
			admin.api.entries.saveDraft({ siteId, entryId: entry.id, bodyFormat: "markdown", fields: { body: markdown } }),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });
		expect((await admin.api.entries.get({ siteId, entryId: entry.id })).entry.draft.fields.body).toEqual(
			entry.draft.fields.body,
		);
	} finally {
		await install.close();
	}
});
