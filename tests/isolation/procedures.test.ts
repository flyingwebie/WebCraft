// Workspace isolation (ADR 0007): every procedure that takes a Workspace or a Site refuses another
// Workspace's data. Each procedure gets one line here; the last test fails when one is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { traverseContractProcedures } from "@orpc/server";
import { type ApiClient, apiRouter } from "@webcraft/api";
import type { ModuleApi, ModuleDefinition, ModuleProcedures } from "@webcraft/module-sdk";

import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type IsolationTarget, workspaceIsolation } from "../harness/isolation.ts";
import { TEST_MODULES } from "../harness/modules.ts";
import { element, outlet, text, tree, value } from "../harness/trees.ts";
import type { sampleBoard } from "../modules/sample/board.ts";
import type { sample } from "../modules/sample/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ modules: TEST_MODULES });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "sample-board", version: "1.0.0" });
});

afterAll(async () => {
	await install.close();
});

const isolation = workspaceIsolation(() => install);

/** A slug no other call has used. */
let slugs = 0;
const newSlug = () => `isolation-${++slugs}`;

/** Content in a target's Site, made once by the Superadmin: a Post Type, its Entry template and an Entry. */
const contents = new Map<string, Promise<{ postTypeId: string; templateId: string; entryId: string }>>();
function contentIn(target: IsolationTarget) {
	let content = contents.get(target.siteId);
	if (!content) {
		content = (async () => {
			const { api } = await install.superadmin();
			const { siteId } = target;
			const { postType } = await api.postTypes.create({ siteId, name: "Posts", urlPattern: "/posts/{slug}" });
			const { template } = await api.templates.saveEntryTemplate({
				siteId,
				postTypeId: postType.id,
				tree: tree(element("h1", [value("title")])),
			});
			const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Hello" });
			return { postTypeId: postType.id, templateId: template.id, entryId: entry.id };
		})();
		contents.set(target.siteId, content);
	}
	return content;
}

/** An email address no other call has used. */
let addresses = 0;
const newAddress = () => `isolation-${++addresses}@client.example`;

/** A pending Member invite in the Workspace, made by the Superadmin, who reaches every Workspace. */
async function inviteIn(workspaceId: string): Promise<string> {
	const admin = await install.superadmin();
	const { invite } = await admin.api.members.invite({ workspaceId, email: newAddress(), role: "author", sites: "all" });
	return invite.id;
}

/** A Member of the Workspace, made the way people become one. */
async function memberOf(workspaceId: string): Promise<string> {
	return (await install.createMember({ workspaceId, role: "author" })).personId;
}

describe("Workspaces", () => {
	isolation.refuses("workspaces.get", (api, { workspaceId }) => api.workspaces.get({ workspaceId }), {
		as: ["staff", "owner", "author"],
	});
});

describe("Sites", () => {
	isolation.refuses("sites.list", (api, { workspaceId }) => api.sites.list({ workspaceId }), {
		as: ["staff", "editor"],
	});
	isolation.refuses("sites.get", (api, { siteId }) => api.sites.get({ siteId }), { as: ["staff", "author"] });
	isolation.refuses("sites.create", (api, { workspaceId }) =>
		api.sites.create({ workspaceId, name: "Leaked Site", slug: newSlug() }),
	);
});

describe("Post Types", () => {
	isolation.refuses("postTypes.list", (api, { siteId }) => api.postTypes.list({ siteId }), { as: ["staff", "author"] });
	isolation.refuses(
		"postTypes.get",
		async (api, target) =>
			api.postTypes.get({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses("postTypes.create", (api, { siteId }) =>
		api.postTypes.create({ siteId, name: "Leaked", key: newSlug(), urlPattern: `/${newSlug()}/{slug}` }),
	);
	isolation.refuses("postTypes.update", async (api, target) =>
		api.postTypes.update({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId, name: "Renamed" }),
	);
	isolation.refuses("postTypes.data", async (api, target) =>
		api.postTypes.data({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
	);
});

describe("Entries", () => {
	isolation.refuses(
		"entries.list",
		async (api, target) =>
			api.entries.list({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"entries.get",
		async (api, target) => api.entries.get({ siteId: target.siteId, entryId: (await contentIn(target)).entryId }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"entries.create",
		async (api, target) =>
			api.entries.create({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId, title: "Leaked" }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"entries.saveDraft",
		async (api, target) =>
			api.entries.saveDraft({ siteId: target.siteId, entryId: (await contentIn(target)).entryId, title: "Changed" }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"entries.publish",
		async (api, target) => api.entries.publish({ siteId: target.siteId, entryId: (await contentIn(target)).entryId }),
		{ as: ["staff", "editor", "owner"] },
	);
	// Without a confirmation it only answers what deleting would do.
	isolation.refuses(
		"entries.delete",
		async (api, target) => api.entries.delete({ siteId: target.siteId, entryId: (await contentIn(target)).entryId }),
		{ as: ["staff", "editor"] },
	);
});

describe("Globals", () => {
	isolation.refuses("globals.get", (api, { siteId }) => api.globals.get({ siteId }), { as: ["staff", "author"] });
	isolation.refuses("globals.setFields", (api, { siteId }) =>
		api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] }),
	);
	isolation.refuses("globals.data", (api, { siteId }) => api.globals.data({ siteId }));
	isolation.refuses("globals.saveDraft", (api, { siteId }) => api.globals.saveDraft({ siteId, fields: {} }), {
		as: ["staff", "author"],
	});
	isolation.refuses("globals.publish", (api, { siteId }) => api.globals.publish({ siteId }), {
		as: ["staff", "editor"],
	});
});

describe("Templates", () => {
	isolation.refuses("templates.getEntryTemplate", async (api, target) =>
		api.templates.getEntryTemplate({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
	);
	isolation.refuses("templates.saveEntryTemplate", async (api, target) =>
		api.templates.saveEntryTemplate({
			siteId: target.siteId,
			postTypeId: (await contentIn(target)).postTypeId,
			tree: tree(element("h2", [value("title")])),
		}),
	);
	isolation.refuses("templates.getEntryTemplateMarkup", async (api, target) =>
		api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
	);
	isolation.refuses("templates.saveEntryTemplateMarkup", async (api, target) =>
		api.templates.saveEntryTemplateMarkup({
			siteId: target.siteId,
			postTypeId: (await contentIn(target)).postTypeId,
			markup: "<h2>{{ title }}</h2>",
		}),
	);
	isolation.refuses("templates.publish", async (api, target) =>
		api.templates.publish({ siteId: target.siteId, templateId: (await contentIn(target)).templateId }),
	);
	isolation.refuses("templates.getSiteTemplate", (api, { siteId }) => api.templates.getSiteTemplate({ siteId }));
	isolation.refuses("templates.saveSiteTemplate", (api, { siteId }) =>
		api.templates.saveSiteTemplate({ siteId, tree: tree(element("main", [outlet()])) }),
	);
	isolation.refuses("templates.getSiteTemplateMarkup", (api, { siteId }) =>
		api.templates.getSiteTemplateMarkup({ siteId }),
	);
	isolation.refuses("templates.saveSiteTemplateMarkup", (api, { siteId }) =>
		api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" }),
	);
	isolation.refuses("templates.getArchiveTemplate", async (api, target) =>
		api.templates.getArchiveTemplate({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
	);
	isolation.refuses("templates.saveArchiveTemplate", async (api, target) =>
		api.templates.saveArchiveTemplate({
			siteId: target.siteId,
			postTypeId: (await contentIn(target)).postTypeId,
			tree: tree(element("h2", [text("All posts")])),
		}),
	);
	isolation.refuses("templates.getArchiveTemplateMarkup", async (api, target) =>
		api.templates.getArchiveTemplateMarkup({ siteId: target.siteId, postTypeId: (await contentIn(target)).postTypeId }),
	);
	isolation.refuses("templates.saveArchiveTemplateMarkup", async (api, target) =>
		api.templates.saveArchiveTemplateMarkup({
			siteId: target.siteId,
			postTypeId: (await contentIn(target)).postTypeId,
			markup: "<h2>All posts</h2>",
		}),
	);
});

describe("Components", () => {
	/** A name no other call has used. */
	let names = 0;
	const newName = () => `Card${++names}`;
	/** A new Component in a target's Site, made by the Superadmin. */
	const componentIn = async (target: IsolationTarget) => {
		const { api } = await install.superadmin();
		return (await api.components.create({ siteId: target.siteId, name: newName() })).component.id;
	};

	isolation.refuses("components.list", (api, { siteId }) => api.components.list({ siteId }));
	isolation.refuses("components.get", async (api, target) =>
		api.components.get({ siteId: target.siteId, componentId: await componentIn(target) }),
	);
	isolation.refuses("components.create", (api, { siteId }) => api.components.create({ siteId, name: newName() }));
	isolation.refuses("components.saveDraft", async (api, target) =>
		api.components.saveDraft({
			siteId: target.siteId,
			componentId: await componentIn(target),
			tree: tree(element("p")),
		}),
	);
	isolation.refuses("components.getMarkup", async (api, target) =>
		api.components.getMarkup({ siteId: target.siteId, componentId: await componentIn(target) }),
	);
	isolation.refuses("components.saveMarkup", async (api, target) =>
		api.components.saveMarkup({ siteId: target.siteId, componentId: await componentIn(target), markup: "<p>Hi</p>" }),
	);
	isolation.refuses("components.publish", async (api, target) =>
		api.components.publish({ siteId: target.siteId, componentId: await componentIn(target) }),
	);
	isolation.refuses("components.rename", async (api, target) =>
		api.components.rename({ siteId: target.siteId, componentId: await componentIn(target), name: newName() }),
	);
	isolation.refuses("components.delete", async (api, target) =>
		api.components.delete({ siteId: target.siteId, componentId: await componentIn(target) }),
	);
});

describe("Loops", () => {
	/** A name no other call has used. */
	let names = 0;
	const newName = () => `loop-${++names}`;
	/** A new Loop of its own items in a target's Site, made by the Superadmin. */
	const loopIn = async (target: IsolationTarget) => {
		const { api } = await install.superadmin();
		const fields = [{ key: "label", label: "Label", type: "text" as const }];
		return (await api.loops.create({ siteId: target.siteId, name: newName(), source: "items", fields })).loop.id;
	};

	isolation.refuses("loops.list", (api, { siteId }) => api.loops.list({ siteId }));
	isolation.refuses("loops.get", async (api, target) =>
		api.loops.get({ siteId: target.siteId, loopId: await loopIn(target) }),
	);
	isolation.refuses("loops.create", (api, { siteId }) =>
		api.loops.create({ siteId, name: newName(), source: "query" }),
	);
	isolation.refuses("loops.saveDraft", async (api, target) =>
		api.loops.saveDraft({ siteId: target.siteId, loopId: await loopIn(target), query: { limit: 5 } }),
	);
	isolation.refuses("loops.saveItems", async (api, target) =>
		api.loops.saveItems({ siteId: target.siteId, loopId: await loopIn(target), items: [{ label: "One" }] }),
	);
	isolation.refuses("loops.data", async (api, target) =>
		api.loops.data({ siteId: target.siteId, loopId: await loopIn(target) }),
	);
	isolation.refuses("loops.publish", async (api, target) =>
		api.loops.publish({ siteId: target.siteId, loopId: await loopIn(target) }),
	);
});

describe("Design system", () => {
	/** A new Class in a target's Site's Design system, made by the Superadmin. */
	const classIn = async (target: IsolationTarget) => {
		const { api } = await install.superadmin();
		return (await api.designSystem.createClass({ siteId: target.siteId, name: `card-${newSlug()}` })).class.id;
	};

	isolation.refuses("designSystem.get", (api, { siteId }) => api.designSystem.get({ siteId }));
	isolation.refuses("designSystem.saveDraft", (api, { siteId }) =>
		api.designSystem.saveDraft({ siteId, customCss: "p { margin: 0; }" }),
	);
	isolation.refuses("designSystem.createClass", (api, { siteId }) =>
		api.designSystem.createClass({ siteId, name: `leaked-${newSlug()}` }),
	);
	isolation.refuses("designSystem.updateClass", async (api, target) =>
		api.designSystem.updateClass({ siteId: target.siteId, classId: await classIn(target), styles: "color: red;" }),
	);
	isolation.refuses("designSystem.deleteClass", async (api, target) =>
		api.designSystem.deleteClass({ siteId: target.siteId, classId: await classIn(target) }),
	);
	isolation.refuses("designSystem.publish", (api, { siteId }) => api.designSystem.publish({ siteId }));
	isolation.refuses("designSystem.exportTokens", (api, { siteId }) => api.designSystem.exportTokens({ siteId }));
	isolation.refuses("designSystem.importTokens", (api, { siteId }) =>
		api.designSystem.importTokens({ siteId, tokens: { width: { content: { $value: { value: 70, unit: "rem" } } } } }),
	);
});

describe("Pages", () => {
	/** A Page in a target's Site, made by the Superadmin. */
	const pageIn = async (target: IsolationTarget) => {
		const { api } = await install.superadmin();
		const { postTypes } = await api.postTypes.list({ siteId: target.siteId });
		const pages = postTypes.find((postType) => postType.builtIn === "page");
		const { entry } = await api.entries.create({ siteId: target.siteId, postTypeId: pages?.id ?? "", title: "Page" });
		return entry.id;
	};

	isolation.refuses("pages.settings", (api, { siteId }) => api.pages.settings({ siteId }), {
		as: ["staff", "author"],
	});
	isolation.refuses("pages.setHomePage", async (api, target) =>
		api.pages.setHomePage({ siteId: target.siteId, pageId: await pageIn(target) }),
	);
	isolation.refuses("pages.setNotFoundPage", async (api, target) =>
		api.pages.setNotFoundPage({ siteId: target.siteId, pageId: await pageIn(target) }),
	);
});

describe("Languages", () => {
	isolation.refuses("languages.list", (api, { siteId }) => api.languages.list({ siteId }), {
		as: ["staff", "author"],
	});
	isolation.refuses("languages.add", (api, { siteId }) => api.languages.add({ siteId, code: "fr" }));
	isolation.refuses("languages.update", (api, { siteId }) =>
		api.languages.update({ siteId, code: "en", name: "Inglese" }),
	);
	// Without a confirmation it only answers what the change would do.
	isolation.refuses("languages.setDefault", async (api, target) => {
		const admin = await install.superadmin();
		await admin.api.languages.add({ siteId: target.siteId, code: "fr" }).catch(() => undefined);
		return api.languages.setDefault({ siteId: target.siteId, code: "fr" });
	});
	isolation.refuses("languages.remove", async (api, target) => {
		const admin = await install.superadmin();
		await admin.api.languages.add({ siteId: target.siteId, code: "de" }).catch(() => undefined);
		return api.languages.remove({ siteId: target.siteId, code: "de" });
	});
	isolation.refuses("languages.setBrowserRedirect", (api, { siteId }) =>
		api.languages.setBrowserRedirect({ siteId, browserLanguageRedirect: true }),
	);
});

describe("Edit mode", () => {
	isolation.refuses("editMode.open", (api, { siteId }) => api.editMode.open({ siteId, path: "/" }), {
		as: ["staff", "author"],
	});
});

describe("Members", () => {
	isolation.refuses("members.list", (api, { workspaceId }) => api.members.list({ workspaceId }), {
		as: ["staff", "owner"],
	});
	isolation.refuses(
		"members.invite",
		(api, { workspaceId }) => api.members.invite({ workspaceId, email: newAddress(), role: "author", sites: "all" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.resendInvite",
		async (api, { workspaceId }) => api.members.resendInvite({ workspaceId, inviteId: await inviteIn(workspaceId) }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.revokeInvite",
		async (api, { workspaceId }) => api.members.revokeInvite({ workspaceId, inviteId: await inviteIn(workspaceId) }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.changeAccess",
		async (api, { workspaceId }) =>
			api.members.changeAccess({ workspaceId, personId: await memberOf(workspaceId), role: "editor", sites: "all" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"members.remove",
		async (api, { workspaceId }) => api.members.remove({ workspaceId, personId: await memberOf(workspaceId) }),
		{ as: ["staff", "owner"] },
	);
});

/** A file in a target's Media library and a folder, made by the Superadmin. */
async function mediaIn(target: IsolationTarget): Promise<{ mediaId: string; folderId: string }> {
	const { api } = await install.superadmin();
	const { media } = await api.media.upload({ siteId: target.siteId, file: upload(pdf(), "isolation.pdf") });
	const { folder } = await api.media.folders.create({ siteId: target.siteId, name: `Folder ${newSlug()}` });
	return { mediaId: media.id, folderId: folder.id };
}

describe("Media", () => {
	isolation.refuses("media.list", (api, { siteId }) => api.media.list({ siteId }), { as: ["staff", "author"] });
	isolation.refuses(
		"media.get",
		async (api, target) => api.media.get({ siteId: target.siteId, mediaId: (await mediaIn(target)).mediaId }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"media.upload",
		(api, { siteId }) => api.media.upload({ siteId, file: upload(pdf(), "leaked.pdf") }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"media.update",
		async (api, target) =>
			api.media.update({ siteId: target.siteId, mediaId: (await mediaIn(target)).mediaId, alt: "Changed" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("media.folders.list", (api, { siteId }) => api.media.folders.list({ siteId }), {
		as: ["staff", "author"],
	});
	isolation.refuses(
		"media.folders.create",
		(api, { siteId }) => api.media.folders.create({ siteId, name: `Leaked ${newSlug()}` }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"media.folders.rename",
		async (api, target) =>
			api.media.folders.rename({
				siteId: target.siteId,
				folderId: (await mediaIn(target)).folderId,
				name: `Renamed ${newSlug()}`,
			}),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"media.folders.delete",
		async (api, target) =>
			api.media.folders.delete({ siteId: target.siteId, folderId: (await mediaIn(target)).folderId }),
		{ as: ["staff", "editor"] },
	);
});

/** A Module's procedures, from the person's Management API (`m.<module id>`). */
function moduleOf<Definition extends typeof sample | typeof sampleBoard>(api: ApiClient, moduleId: string) {
	return (api as unknown as { m: Record<string, ModuleApi<Definition>> }).m[moduleId] as ModuleApi<Definition>;
}

/** Switches the sample board on in the Workspace, as the Superadmin. */
async function boardOn(workspaceId: string): Promise<void> {
	const admin = await install.superadmin();
	await admin.api.modules.setOnWorkspace({ workspaceId, moduleId: "sample-board", on: true });
}

describe("Modules", () => {
	isolation.refuses("modules.siteList", (api, { siteId }) => api.modules.siteList({ siteId }));
	isolation.refuses("modules.workspaceList", (api, { workspaceId }) => api.modules.workspaceList({ workspaceId }));
	isolation.refuses("modules.setOnSite", (api, { siteId }) =>
		api.modules.setOnSite({ siteId, moduleId: "sample", on: true }),
	);
	isolation.refuses("modules.setOnWorkspace", (api, { workspaceId }) =>
		api.modules.setOnWorkspace({ workspaceId, moduleId: "sample-board", on: false }),
	);
	isolation.refuses("modules.removeSiteData", (api, { siteId }) =>
		api.modules.removeSiteData({ siteId, moduleId: "sample" }),
	);
	isolation.refuses("modules.removeWorkspaceData", (api, { workspaceId }) =>
		api.modules.removeWorkspaceData({ workspaceId, moduleId: "sample-board" }),
	);
	isolation.refuses(
		"m.sample.notes.list",
		(api, { siteId }) => moduleOf<typeof sample>(api, "sample").notes.list({ siteId }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"m.sample.notes.add",
		(api, { siteId }) => moduleOf<typeof sample>(api, "sample").notes.add({ siteId, body: "Ours" }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"m.sample.notes.share",
		async (api, { siteId }) => {
			const notes = moduleOf<typeof sample>(api, "sample").notes;
			const { note } = await notes.add({ siteId, body: "To share" });
			return notes.share({ siteId, noteId: note.id, email: "someone@client.example" });
		},
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"m.sample.notes.remind",
		async (api, { siteId }) => {
			const notes = moduleOf<typeof sample>(api, "sample").notes;
			const { note } = await notes.add({ siteId, body: "To remember" });
			return notes.remind({ siteId, noteId: note.id, delaySeconds: 60 });
		},
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("m.sample.settings.checkHook", (api, { siteId }) =>
		moduleOf<typeof sample>(api, "sample").settings.checkHook({ siteId }),
	);
	isolation.refuses("m.sample.settings.setHookToken", (api, { siteId }) =>
		moduleOf<typeof sample>(api, "sample").settings.setHookToken({ siteId, token: "our-hook-token" }),
	);
	isolation.refuses("m.sample.probe", (api, { siteId }) =>
		moduleOf<typeof sample>(api, "sample").probe({ siteId, attempt: "undeclared-host" }),
	);
	isolation.refuses(
		"m.sample.broken",
		// It always fails where the Module runs (500); another Workspace's Site is refused before that.
		(api, { siteId }) =>
			moduleOf<typeof sample>(api, "sample")
				.broken({ siteId })
				.catch((error: { status?: number }) => {
					if (error.status !== 500) throw error;
				}),
		{ as: ["author"] },
	);
	isolation.refuses(
		"m.sample-board.pins.list",
		async (api, { workspaceId }) => {
			await boardOn(workspaceId);
			return moduleOf<typeof sampleBoard>(api, "sample-board").pins.list({ workspaceId });
		},
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"m.sample-board.pins.add",
		async (api, { workspaceId }) => {
			await boardOn(workspaceId);
			return moduleOf<typeof sampleBoard>(api, "sample-board").pins.add({ workspaceId, text: "Ours" });
		},
		{ as: ["staff", "owner"] },
	);
});

test("every procedure that takes a Workspace or a Site has an isolation test above", async () => {
	const scoped: string[] = [];
	await traverseContractProcedures({ router: apiRouter, path: [] }, ({ contract, path }) => {
		const shape = (contract["~orpc"].inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
		if ("workspaceId" in shape || "siteId" in shape) scoped.push(path.join("."));
	});
	// Every Module procedure takes its Site or Workspace: `m.<module id>.<name>`.
	for (const module of TEST_MODULES) scoped.push(...moduleProcedureNames(module));

	expect(scoped.length).toBeGreaterThan(0);
	expect(scoped.filter((procedure) => !isolation.covered.has(procedure))).toEqual([]);
});

/** A Module's procedures as the Management API names them: `m.sample.notes.list`. */
function moduleProcedureNames(module: ModuleDefinition): string[] {
	const names: string[] = [];
	const walk = (group: ModuleProcedures, path: readonly string[]) => {
		for (const [name, entry] of Object.entries(group)) {
			if ("run" in entry && "input" in entry) names.push([...path, name].join("."));
			else walk(entry as ModuleProcedures, [...path, name]);
		}
	};
	walk(module.procedures ?? {}, ["m", module.manifest.id]);
	return names;
}
