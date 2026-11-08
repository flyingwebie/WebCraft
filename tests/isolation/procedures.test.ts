// Workspace isolation (ADR 0007): every procedure that takes a Workspace or a Site refuses another
// Workspace's data. Each procedure gets one line here; the last test fails when one is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { traverseContractProcedures } from "@orpc/server";
import { type ApiClient, apiRouter } from "@webcraft/api";
import type { ModuleApi } from "@webcraft/module-sdk";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type IsolationTarget, workspaceIsolation } from "../harness/isolation.ts";
import { element, tree, value } from "../harness/trees.ts";
import { sampleBoard } from "../modules/sample/board.ts";
import { sample } from "../modules/sample/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample, sampleBoard] });
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

	expect(scoped.length).toBeGreaterThan(0);
	expect(scoped.filter((procedure) => !isolation.covered.has(procedure))).toEqual([]);
});
