// Workspace isolation (ADR 0007): every procedure that takes a Workspace or a Site refuses another
// Workspace's data. Each procedure gets one line here; the last test fails when one is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { traverseContractProcedures } from "@orpc/server";
import { type ApiClient, apiRouter } from "@webcraft/api";
import type forms from "@webcraft/module-forms";
import type redirects from "@webcraft/module-redirects";
import type { ModuleApi, ModuleDefinition, ModuleProcedures } from "@webcraft/module-sdk";
import type siteAnalytics from "@webcraft/module-site-analytics";
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
	await admin.api.modules.approve({ moduleId: "forms", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
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

describe("API tokens", () => {
	isolation.refuses(
		"apiTokens.create",
		(api, { workspaceId }) => api.apiTokens.create({ workspaceId, name: "Isolation" }),
		{ as: ["staff", "author"] },
	);
});

describe("Workspaces", () => {
	isolation.refuses("workspaces.get", (api, { workspaceId }) => api.workspaces.get({ workspaceId }), {
		as: ["staff", "owner", "author"],
	});
	isolation.refuses("workspaces.storage", (api, { workspaceId }) => api.workspaces.storage({ workspaceId }), {
		as: ["staff", "author"],
	});
	isolation.refuses("workspaces.setQuota", (api, { workspaceId }) =>
		api.workspaces.setQuota({ workspaceId, quotaBytes: 1024 * 1024 * 1024 }),
	);
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
	isolation.refuses("templates.getSearchTemplate", (api, { siteId }) => api.templates.getSearchTemplate({ siteId }));
	isolation.refuses("templates.saveSearchTemplate", (api, { siteId }) =>
		api.templates.saveSearchTemplate({ siteId, tree: { version: 1, nodes: [] } }),
	);
	isolation.refuses("templates.getSearchTemplateMarkup", (api, { siteId }) =>
		api.templates.getSearchTemplateMarkup({ siteId }),
	);
	isolation.refuses("templates.saveSearchTemplateMarkup", (api, { siteId }) =>
		api.templates.saveSearchTemplateMarkup({ siteId, markup: "<p>Search</p>" }),
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

describe("Scripts", () => {
	/** The Site script of a target's Site, made once by the Superadmin. */
	const siteScripts = new Map<string, Promise<string>>();
	const siteScriptIn = (target: IsolationTarget) => {
		let made = siteScripts.get(target.siteId);
		if (!made) {
			made = (async () => {
				const { api } = await install.superadmin();
				return (await api.scripts.saveDraft({ siteId: target.siteId, entryId: null, code: "1;" })).script.id;
			})();
			siteScripts.set(target.siteId, made);
		}
		return made;
	};
	isolation.refuses("scripts.get", (api, { siteId }) => api.scripts.get({ siteId, entryId: null }));
	isolation.refuses("scripts.saveDraft", async (api, target) =>
		api.scripts.saveDraft({ siteId: target.siteId, entryId: (await contentIn(target)).entryId, code: "1;" }),
	);
	isolation.refuses("scripts.publish", async (api, target) =>
		api.scripts.publish({ siteId: target.siteId, scriptId: await siteScriptIn(target) }),
	);
});

describe("SEO", () => {
	isolation.refuses("seoSettings.get", (api, { siteId }) => api.seoSettings.get({ siteId }), {
		as: ["staff", "author"],
	});
	isolation.refuses("seoSettings.update", (api, { siteId }) => api.seoSettings.update({ siteId, separator: "|" }));
});

describe("Site script safety", () => {
	isolation.refuses("consentBanner.get", (api, { siteId }) => api.consentBanner.get({ siteId }), {
		as: ["staff", "author"],
	});
	isolation.refuses("consentBanner.setSettings", (api, { siteId }) =>
		api.consentBanner.setSettings({ siteId, mode: "optOut", layout: "box" }),
	);
	isolation.refuses(
		"consentBanner.saveDraft",
		(api, { siteId }) => api.consentBanner.saveDraft({ siteId, fields: { heading: "Choices" } }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses("consentBanner.publish", (api, { siteId }) => api.consentBanner.publish({ siteId }), {
		as: ["staff", "editor"],
	});
	/** A Consent record in a target's Site, as a visitor's choice on its banner leaves one. */
	const consentRecords = new Map<string, Promise<string>>();
	const consentRecordIn = (target: IsolationTarget) => {
		let made = consentRecords.get(target.siteId);
		if (!made) {
			made = (async () => {
				const { stagingUrl } = await (await install.superadmin()).api.sites.get({ siteId: target.siteId });
				const origin = stagingUrl as string;
				const answer = await install.request(`${origin}/_wc/consent`, {
					method: "POST",
					headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
					body: JSON.stringify({
						choices: { analytics: true, marketing: true, media: true },
						version: 1,
						language: "en",
					}),
				});
				return ((await answer.json()) as { id: string }).id;
			})();
			consentRecords.set(target.siteId, made);
		}
		return made;
	};
	isolation.refuses(
		"consentBanner.record",
		async (api, target) => api.consentBanner.record({ siteId: target.siteId, recordId: await consentRecordIn(target) }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses("csp.get", (api, { siteId }) => api.csp.get({ siteId }));
	isolation.refuses("csp.setMode", (api, { siteId }) => api.csp.setMode({ siteId, mode: "relaxed" }));
	isolation.refuses("csp.addHost", (api, { siteId }) => api.csp.addHost({ siteId, host: "tags.example.com" }));
	isolation.refuses("csp.removeHost", (api, { siteId }) => api.csp.removeHost({ siteId, host: "tags.example.com" }));

	const outside = {
		name: "Chat widget",
		placement: "bodyEnd" as const,
		consentCategory: "marketing" as const,
		source: { kind: "url" as const, url: "https://widgets.example.com/chat.js" },
	};
	/** An outside script on a target's Site, added by the Superadmin. */
	const outsideScriptIn = async (target: IsolationTarget) => {
		const { api } = await install.superadmin();
		return (await api.outsideScripts.add({ siteId: target.siteId, ...outside })).outsideScript.id;
	};
	isolation.refuses("outsideScripts.list", (api, { siteId }) => api.outsideScripts.list({ siteId }));
	isolation.refuses("outsideScripts.add", (api, { siteId }) => api.outsideScripts.add({ siteId, ...outside }));
	isolation.refuses("outsideScripts.update", async (api, target) =>
		api.outsideScripts.update({ siteId: target.siteId, outsideScriptId: await outsideScriptIn(target), ...outside }),
	);
	isolation.refuses("outsideScripts.remove", async (api, target) =>
		api.outsideScripts.remove({ siteId: target.siteId, outsideScriptId: await outsideScriptIn(target) }),
	);

	/** A Library by address (the fake outgoing HTTP answers it). */
	const libraryUrl = "https://cdn.example.org/slider.js";
	const library = { source: "url" as const, url: libraryUrl };
	const prepared = () => {
		install.dns.answer("cdn.example.org", ["93.184.215.14"]);
		install.http.respond("GET", libraryUrl, { body: "window.slider = {};" });
	};
	/** A Library on a target's Site, added by the Superadmin. */
	const libraryIn = async (target: IsolationTarget) => {
		prepared();
		const { api } = await install.superadmin();
		return (await api.libraries.add({ siteId: target.siteId, library })).library.id;
	};
	isolation.refuses("libraries.list", (api, { siteId }) => api.libraries.list({ siteId }));
	isolation.refuses("libraries.add", (api, { siteId }) => {
		prepared();
		return api.libraries.add({ siteId, library });
	});
	isolation.refuses("libraries.checkUpdates", (api, { siteId }) => api.libraries.checkUpdates({ siteId }));
	isolation.refuses("libraries.update", async (api, target) =>
		api.libraries.update({ siteId: target.siteId, libraryId: await libraryIn(target) }),
	);
	isolation.refuses("libraries.remove", async (api, target) =>
		api.libraries.remove({ siteId: target.siteId, libraryId: await libraryIn(target) }),
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

describe("Forms", () => {
	let keys = 0;
	/** A new Form in a target's Site, made by the Superadmin. */
	const formIn = async (target: IsolationTarget) => {
		const { api } = await install.superadmin();
		return (await api.forms.create({ siteId: target.siteId, name: `Form ${++keys}` })).form.id;
	};

	isolation.refuses("forms.list", (api, { siteId }) => api.forms.list({ siteId }));
	isolation.refuses("forms.get", async (api, target) =>
		api.forms.get({ siteId: target.siteId, formId: await formIn(target) }),
	);
	isolation.refuses("forms.create", (api, { siteId }) => api.forms.create({ siteId, name: `Ours ${++keys}` }));
	isolation.refuses("forms.saveDraft", async (api, target) =>
		api.forms.saveDraft({
			siteId: target.siteId,
			formId: await formIn(target),
			form: { fields: [{ key: "email", type: "email", label: "Email" }] },
		}),
	);
	isolation.refuses("forms.publish", async (api, target) =>
		api.forms.publish({ siteId: target.siteId, formId: await formIn(target) }),
	);
	isolation.refuses("forms.rename", async (api, target) =>
		api.forms.rename({ siteId: target.siteId, formId: await formIn(target), name: "Renamed" }),
	);
	isolation.refuses("forms.delete", async (api, target) =>
		api.forms.delete({ siteId: target.siteId, formId: await formIn(target) }),
	);
	isolation.refuses("forms.captcha.get", (api, { siteId }) => api.forms.captcha.get({ siteId }));
	isolation.refuses("forms.captcha.set", (api, { siteId }) => api.forms.captcha.set({ siteId, captcha: null }));
	isolation.refuses(
		"m.forms.submissions.list",
		(api, { siteId }) => moduleOf<typeof forms>(api, "forms").submissions.list({ siteId }),
		{ as: ["staff", "editor"] },
	);
});

describe("Redirect rules and the 404 log", () => {
	let paths = 0;
	const redirectsOf = (api: ApiClient) => moduleOf<typeof redirects>(api, "redirects");
	/** A Redirect rule in a target's Site, made by the Superadmin. */
	async function ruleIn(target: IsolationTarget) {
		const admin = await install.superadmin();
		const from = `/isolation-${++paths}`;
		return (await redirectsOf(admin.api).rules.add({ siteId: target.siteId, from, to: "/", status: 301 })).rule.id;
	}
	/** A path of a target's 404 log: a visitor's browser asked for it. */
	async function missIn(target: IsolationTarget) {
		const admin = await install.superadmin();
		const { stagingUrl } = await admin.api.sites.get({ siteId: target.siteId });
		const path = `/missing-${++paths}`;
		const userAgent = "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0";
		await install.request(new Request(`${stagingUrl}${path}`, { headers: { "user-agent": userAgent } }));
		await install.drainJobs();
		const { misses } = await redirectsOf(admin.api).notFound.list({ siteId: target.siteId });
		const miss = misses.find((each) => each.path === path);
		if (!miss) throw new Error(`${path} should be in the 404 log.`);
		return miss.id;
	}
	isolation.refuses("m.redirects.rules.list", (api, { siteId }) => redirectsOf(api).rules.list({ siteId }), {
		as: ["staff", "editor"],
	});
	isolation.refuses(
		"m.redirects.rules.add",
		(api, { siteId }) => redirectsOf(api).rules.add({ siteId, from: `/ours-${++paths}`, to: "/", status: 302 }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("m.redirects.rules.update", async (api, target) =>
		redirectsOf(api).rules.update({ siteId: target.siteId, ruleId: await ruleIn(target), status: 302 }),
	);
	isolation.refuses("m.redirects.rules.remove", async (api, target) =>
		redirectsOf(api).rules.remove({ siteId: target.siteId, ruleId: await ruleIn(target) }),
	);
	isolation.refuses("m.redirects.notFound.list", (api, { siteId }) => redirectsOf(api).notFound.list({ siteId }), {
		as: ["staff", "editor"],
	});
	isolation.refuses("m.redirects.notFound.ignore", async (api, target) =>
		redirectsOf(api).notFound.ignore({ siteId: target.siteId, missId: await missIn(target) }),
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
	isolation.refuses("pages.setSearchPage", async (api, target) =>
		api.pages.setSearchPage({ siteId: target.siteId, pageId: await pageIn(target) }),
	);
});

describe("Languages", () => {
	isolation.refuses("languages.list", (api, { siteId }) => api.languages.list({ siteId }), {
		as: ["staff", "author"],
	});
	// Each call adds a language the Site doesn't have yet.
	const newLanguages = ["nl", "sv", "da", "fi", "pl", "cs"];
	isolation.refuses("languages.add", (api, { siteId }) =>
		api.languages.add({ siteId, code: newLanguages.shift() ?? "el" }),
	);
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

/** The Primary domain of a target's Site (waiting for DNS), added by the Superadmin when it has none. */
async function domainIn(target: IsolationTarget): Promise<string> {
	const { api } = await install.superadmin();
	const { domains } = await api.domains.list({ siteId: target.siteId });
	const primary = domains.find((domain) => domain.role === "primary");
	if (primary) return primary.id;
	const added = await api.domains.add({ siteId: target.siteId, name: `${newSlug()}.example` });
	return added.domains[0]?.id ?? "";
}

describe("Domains", () => {
	isolation.refuses("domains.list", (api, { siteId }) => api.domains.list({ siteId }), { as: ["staff", "owner"] });
	isolation.refuses("domains.add", (api, { siteId }) => api.domains.add({ siteId, name: `${newSlug()}.example` }));
	isolation.refuses("domains.setCdn", (api, { siteId }) => api.domains.setCdn({ siteId, cdn: "cloudflare" }));
	isolation.refuses("domains.check", async (api, target) =>
		api.domains.check({ siteId: target.siteId, domainId: await domainIn(target) }),
	);
	// Without a confirmation it only answers what removing would do.
	isolation.refuses("domains.remove", async (api, target) =>
		api.domains.remove({ siteId: target.siteId, domainId: await domainIn(target) }),
	);
	// Making the Primary domain the Primary domain again changes nothing, but must still be allowed.
	isolation.refuses("domains.makePrimary", async (api, target) =>
		api.domains.makePrimary({ siteId: target.siteId, domainId: await domainIn(target) }),
	);
});

/** A Webhook of a target's Site, added by the Superadmin, whose receiver refuses everything (410). */
async function webhookIn(target: IsolationTarget): Promise<string> {
	const { api } = await install.superadmin();
	install.dns.answer("hooks.isolation.example", ["93.184.216.34"]);
	install.http.respond("POST", /^https:\/\/hooks\.isolation\.example\//, { status: 410 });
	const { webhook } = await api.webhooks.add({
		siteId: target.siteId,
		url: `https://hooks.isolation.example/${newSlug()}`,
		events: ["publish"],
	});
	return webhook.id;
}

/** A Webhook of a target's Site with one failed delivery. */
async function failedDeliveryIn(target: IsolationTarget): Promise<{ webhookId: string; deliveryId: string }> {
	const { api } = await install.superadmin();
	const webhookId = await webhookIn(target);
	await api.globals.publish({ siteId: target.siteId });
	await install.drainJobs();
	const { deliveries } = await api.webhooks.deliveries({ siteId: target.siteId, webhookId });
	return { webhookId, deliveryId: deliveries[0]?.id ?? "" };
}

describe("Webhooks", () => {
	const webhook = { url: "https://hooks.isolation.example/added", events: ["publish" as const] };
	isolation.refuses("webhooks.list", (api, { siteId }) => api.webhooks.list({ siteId }), { as: ["staff", "owner"] });
	isolation.refuses("webhooks.add", (api, { siteId }) => api.webhooks.add({ siteId, ...webhook }));
	isolation.refuses("webhooks.update", async (api, target) =>
		api.webhooks.update({ siteId: target.siteId, webhookId: await webhookIn(target), ...webhook }),
	);
	isolation.refuses("webhooks.changeSecret", async (api, target) =>
		api.webhooks.changeSecret({ siteId: target.siteId, webhookId: await webhookIn(target) }),
	);
	isolation.refuses("webhooks.setEnabled", async (api, target) =>
		api.webhooks.setEnabled({ siteId: target.siteId, webhookId: await webhookIn(target), enabled: false }),
	);
	// Without a confirmation it only answers what removing would do.
	isolation.refuses("webhooks.remove", async (api, target) =>
		api.webhooks.remove({ siteId: target.siteId, webhookId: await webhookIn(target) }),
	);
	isolation.refuses(
		"webhooks.deliveries",
		async (api, target) => api.webhooks.deliveries({ siteId: target.siteId, webhookId: await webhookIn(target) }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("webhooks.test", async (api, target) =>
		api.webhooks.test({ siteId: target.siteId, webhookId: await webhookIn(target) }),
	);
	isolation.refuses("webhooks.redeliver", async (api, target) =>
		api.webhooks.redeliver({ siteId: target.siteId, ...(await failedDeliveryIn(target)) }),
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

/** A file in a target's Trash, put there by the Superadmin. */
async function trashedIn(target: IsolationTarget): Promise<string> {
	const { api } = await install.superadmin();
	const { mediaId } = await mediaIn(target);
	const asked = await api.media.delete({ siteId: target.siteId, mediaId });
	if (!asked.trashed) await api.media.delete({ siteId: target.siteId, mediaId, confirmation: asked.confirmation.id });
	return mediaId;
}

/** An Import in a target's Site, made once by the Superadmin, with one run that ended. */
const importsIn = new Map<string, Promise<{ importId: string; runId: string; settings: CsvImportSettings }>>();
type CsvImportSettings = {
	postTypeId: string;
	language: string | null;
	match: string;
	columns: { column: string; to: string | null }[];
};
function importIn(target: IsolationTarget) {
	let found = importsIn.get(target.siteId);
	if (!found) {
		found = (async () => {
			const { api } = await install.superadmin();
			const { siteId } = target;
			const { postType } = await api.postTypes.create({ siteId, name: "Imported", urlPattern: "/imported/{slug}" });
			const settings: CsvImportSettings = {
				postTypeId: postType.id,
				language: null,
				match: "title",
				columns: [{ column: "name", to: "title" }],
			};
			const { import: created } = await api.imports.create({ siteId, name: "Isolated", source: "csv", settings });
			const { file } = await api.imports.uploadCsv({ siteId, file: csvFile() });
			const { run } = await api.imports.start({ siteId, importId: created.id, fileId: file.id });
			await install.drainJobs();
			return { importId: created.id, runId: run.id, settings };
		})();
		importsIn.set(target.siteId, found);
	}
	return found;
}

const csvFile = () => upload("name\nRye\n", "isolation.csv", "text/csv");

/**
 * A CSV file the caller uploaded to the target's Site. They can't upload to another Workspace's Site,
 * so a made-up id stands in there: the call is refused for the Site before the file is looked for.
 */
async function csvFileIn(api: ApiClient, target: IsolationTarget): Promise<string> {
	try {
		return (await api.imports.uploadCsv({ siteId: target.siteId, file: csvFile() })).file.id;
	} catch {
		return crypto.randomUUID();
	}
}

describe("Imports", () => {
	isolation.refuses("imports.uploadCsv", (api, { siteId }) => api.imports.uploadCsv({ siteId, file: csvFile() }), {
		as: ["staff", "editor"],
	});
	isolation.refuses(
		"imports.preview",
		async (api, target) =>
			api.imports.preview({
				siteId: target.siteId,
				fileId: await csvFileIn(api, target),
				settings: (await importIn(target)).settings,
			}),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("imports.list", (api, { siteId }) => api.imports.list({ siteId }), { as: ["staff", "editor"] });
	isolation.refuses(
		"imports.get",
		async (api, target) => api.imports.get({ siteId: target.siteId, importId: (await importIn(target)).importId }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"imports.create",
		async (api, target) =>
			api.imports.create({
				siteId: target.siteId,
				name: "Leaked",
				source: "csv",
				settings: (await importIn(target)).settings,
			}),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"imports.update",
		async (api, target) =>
			api.imports.update({ siteId: target.siteId, importId: (await importIn(target)).importId, name: "Renamed" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"imports.start",
		async (api, target) => {
			// A new Import each time: one run of an Import at a time, and this one is never drained.
			const { settings } = await importIn(target);
			const { api: admin } = await install.superadmin();
			const { import: created } = await admin.imports.create({
				siteId: target.siteId,
				name: "Start",
				source: "csv",
				settings,
			});
			return api.imports.start({ siteId: target.siteId, importId: created.id, fileId: await csvFileIn(api, target) });
		},
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"imports.stop",
		async (api, target) => api.imports.stop({ siteId: target.siteId, runId: (await importIn(target)).runId }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"imports.report",
		async (api, target) => api.imports.report({ siteId: target.siteId, runId: (await importIn(target)).runId }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"imports.undo",
		async (api, target) => api.imports.undo({ siteId: target.siteId, runId: (await importIn(target)).runId }),
		{ as: ["staff", "editor"] },
	);
});

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
	isolation.refuses("media.overview", (api, { siteId }) => api.media.overview({ siteId }), { as: ["staff", "author"] });
	isolation.refuses(
		"media.importUrl",
		(api, { siteId }) => {
			install.dns.answer("files.isolation.example", ["93.184.216.34"]);
			install.http.respond("GET", "https://files.isolation.example/menu.pdf", { body: pdf("Imported") });
			return api.media.importUrl({ siteId, url: "https://files.isolation.example/menu.pdf" });
		},
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"media.replace",
		async (api, target) =>
			api.media.replace({
				siteId: target.siteId,
				mediaId: (await mediaIn(target)).mediaId,
				file: upload(pdf("Replaced"), "replaced.pdf"),
			}),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"media.suggestAltText",
		// The file is a document, so it is refused where it is (400); another Workspace's Site before that.
		async (api, target) =>
			api.media
				.suggestAltText({ siteId: target.siteId, mediaId: (await mediaIn(target)).mediaId })
				.catch((error: { code?: string }) => {
					if (error.code !== "ALT_TEXT_UNAVAILABLE") throw error;
				}),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"media.usage",
		async (api, target) => api.media.usage({ siteId: target.siteId, mediaId: (await mediaIn(target)).mediaId }),
		{ as: ["staff", "author"] },
	);
	isolation.refuses(
		"media.delete",
		async (api, target) => api.media.delete({ siteId: target.siteId, mediaId: (await mediaIn(target)).mediaId }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"media.restore",
		async (api, target) => api.media.restore({ siteId: target.siteId, mediaId: await trashedIn(target) }),
		{ as: ["staff", "editor"] },
	);
	isolation.refuses(
		"media.deleteForever",
		async (api, target) => api.media.deleteForever({ siteId: target.siteId, mediaId: await trashedIn(target) }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("media.emptyTrash", (api, { siteId }) => api.media.emptyTrash({ siteId }), {
		as: ["staff", "editor"],
	});
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

describe("Site analytics", () => {
	const day = { from: new Date("2026-03-02T00:00:00Z"), to: new Date("2026-03-03T00:00:00Z") };
	/** Site analytics' procedures, on a Site where the Superadmin switched it on (it is off by default). */
	const analytics = async (api: ApiClient, siteId: string) => {
		await (await install.superadmin()).api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: true });
		return moduleOf<typeof siteAnalytics>(api, "site-analytics");
	};
	isolation.refuses(
		"m.site-analytics.stats.totals",
		async (api, { siteId }) => (await analytics(api, siteId)).stats.totals({ siteId, ...day }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"m.site-analytics.stats.series",
		async (api, { siteId }) => (await analytics(api, siteId)).stats.series({ siteId, ...day, interval: "hour" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"m.site-analytics.stats.breakdown",
		async (api, { siteId }) => (await analytics(api, siteId)).stats.breakdown({ siteId, ...day, dimension: "page" }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses(
		"m.site-analytics.stats.coverage",
		async (api, { siteId }) => (await analytics(api, siteId)).stats.coverage({ siteId }),
		{ as: ["staff", "owner"] },
	);
	isolation.refuses("m.site-analytics.settings.get", async (api, { siteId }) =>
		(await analytics(api, siteId)).settings.get({ siteId }),
	);
	isolation.refuses("m.site-analytics.settings.update", async (api, { siteId }) =>
		(await analytics(api, siteId)).settings.update({ siteId, excludedRanges: ["203.0.113.0/24"] }),
	);
});

/** A Module's procedures, from the person's Management API (`m.<module id>`). */
function moduleOf<
	Definition extends typeof sample | typeof sampleBoard | typeof forms | typeof siteAnalytics | typeof redirects,
>(api: ApiClient, moduleId: string) {
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
