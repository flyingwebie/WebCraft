// Workspace isolation (ADR 0007): every procedure that takes a Workspace or a Site refuses another
// Workspace's data. Each procedure gets one line here; the last test fails when one is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { traverseContractProcedures } from "@orpc/server";
import { apiRouter } from "@webcraft/api";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type IsolationTarget, workspaceIsolation } from "../harness/isolation.ts";
import { element, outlet, tree, value } from "../harness/trees.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
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

test("every procedure that takes a Workspace or a Site has an isolation test above", async () => {
	const scoped: string[] = [];
	await traverseContractProcedures({ router: apiRouter, path: [] }, ({ contract, path }) => {
		const shape = (contract["~orpc"].inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
		if ("workspaceId" in shape || "siteId" in shape) scoped.push(path.join("."));
	});

	expect(scoped.length).toBeGreaterThan(0);
	expect(scoped.filter((procedure) => !isolation.covered.has(procedure))).toEqual([]);
});
