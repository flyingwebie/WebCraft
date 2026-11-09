// Publish all (ADR 0014): one action that publishes every Draft of a Site the person may publish,
// after showing them the list and letting them untick items. Content (Entries, the Globals, the
// Consent banner's words) for Editors and Owners; Structure (Templates, Components, Loops, scripts,
// Forms, the Design system) for Staff only, shown to Members but never theirs to tick. A change spread
// over several items goes live together or not at all: one transaction, in the order the items need
// each other, one page cache clear, then one Audit log entry, Webhook delivery and Module event per
// item. Like every destructive procedure, it takes two calls: a preview with a confirmation id, then
// the confirmation. Publishing one item on its own still works as before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let staffId: string;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const created = await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.browser;
	staffId = created.personId;
	install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; pagesId: string; postTypeId: string; live: string };

/** A live Site with a Blog Post Type (`/blog/{slug}`), its published Entry template, and nothing else changed. */
async function newSite(): Promise<TestSite> {
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `publish-all-${++sites}` })).id;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "posts",
		urlPattern: "/blog/{slug}",
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")
		?.id as string;
	return { siteId, pagesId, postTypeId: postType.id, live: await goLive(install, siteId) };
}

/** The id a Publish all preview asked to confirm. */
function confirmationOf(answer: unknown): string | undefined {
	return (answer as { confirmation?: { id: string } }).confirmation?.id;
}

/** An item's id, for the kinds that have one. */
function idOf(item: { kind: string }): string | undefined {
	return (item as { id?: string }).id;
}

/** Publish all's two calls, as the admin makes them: the preview, then its confirmation. */
async function publishAll(
	browser: TestBrowser,
	siteId: string,
	items: { kind: string; id?: string }[],
): Promise<Awaited<ReturnType<TestBrowser["api"]["publishing"]["publishAll"]>>> {
	const preview = await browser.api.publishing.publishAll({ siteId, items: items as never });
	const confirmation = confirmationOf(preview);
	if (preview.published || !confirmation) throw new Error("Publish all published without a confirmation.");
	return browser.api.publishing.publishAll({ siteId, items: items as never, confirmation });
}

describe("the list of Drafts", () => {
	test("lists every Draft of the Site, Content then Structure, each with what changed and who changed it last", async () => {
		const site = await newSite();
		const editor = await install.createMember({
			workspaceId,
			role: "editor",
			sites: [site.siteId],
			name: "Eve Editor",
		});
		const post = await editor.browser.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		const about = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "About us" });
		await staff.api.entries.publish({ siteId: site.siteId, entryId: about.entry.id });
		await install.clock.advance(60_000);
		await editor.browser.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: about.entry.id,
			title: "About the bakery",
		});
		await staff.api.globals.setFields({
			siteId: site.siteId,
			fields: [{ key: "phone", label: "Phone", type: "text" }],
		});
		await editor.browser.api.globals.saveDraft({ siteId: site.siteId, fields: { phone: "021 555 0100" } });
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { padding: 2rem; }" });
		const { component } = await staff.api.components.create({ siteId: site.siteId, name: "Notice" });
		const siteTemplate = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><Notice /></header><main>{{@outlet}}</main>",
		});

		const { drafts, count } = await staff.api.publishing.drafts({ siteId: site.siteId });
		expect(count).toBe(drafts.length);
		expect(
			drafts.map(({ item, group, name, status, changes, changedBy, canPublish }) => ({
				item,
				group,
				name,
				status,
				changes,
				changedBy: changedBy?.name ?? null,
				canPublish,
			})),
		).toEqual([
			{
				item: { kind: "entry", id: about.entry.id },
				group: "content",
				name: "About the bakery",
				status: "changed",
				changes: [{ key: "title", label: null }],
				changedBy: "Eve Editor",
				canPublish: true,
			},
			{
				item: { kind: "entry", id: post.entry.id },
				group: "content",
				name: "Spring menu",
				status: "new",
				changes: [],
				changedBy: "Eve Editor",
				canPublish: true,
			},
			{
				item: { kind: "globals" },
				group: "content",
				name: null,
				status: "new",
				changes: [{ key: "phone", label: "Phone" }],
				changedBy: "Eve Editor",
				canPublish: true,
			},
			{
				item: { kind: "designSystem" },
				group: "structure",
				name: null,
				status: "new",
				changes: [{ key: "customCss", label: null }],
				changedBy: "Ada Staff",
				canPublish: true,
			},
			{
				item: { kind: "component", id: component.id },
				group: "structure",
				name: "Notice",
				status: "new",
				changes: [],
				changedBy: "Ada Staff",
				canPublish: true,
			},
			{
				item: { kind: "template", id: siteTemplate.template.id },
				group: "structure",
				name: null,
				status: "new",
				changes: [],
				changedBy: "Ada Staff",
				canPublish: true,
			},
		]);
		const page = drafts.find((draft) => idOf(draft.item) === about.entry.id);
		expect(page).toMatchObject({ postType: { id: site.pagesId }, path: "/about-us", templateKind: null });
		expect(drafts.find((draft) => idOf(draft.item) === siteTemplate.template.id)).toMatchObject({
			templateKind: "site",
		});
	});

	test("Members see Structure Drafts they can't publish; their count holds only what they may publish", async () => {
		const site = await newSite();
		const editor = (await install.createMember({ workspaceId, role: "editor", sites: [site.siteId] })).browser;
		await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Spring menu" });
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { padding: 2rem; }" });

		const { drafts, count } = await editor.api.publishing.drafts({ siteId: site.siteId });
		expect(drafts.map((draft) => [draft.item.kind, draft.canPublish])).toEqual([
			["entry", true],
			["designSystem", false],
		]);
		expect(count).toBe(1);
		expect((await editor.api.publishing.count({ siteId: site.siteId })).count).toBe(1);
		expect((await staff.api.publishing.count({ siteId: site.siteId })).count).toBe(2);
	});

	test("Authors may publish nothing", async () => {
		const site = await newSite();
		const author = (await install.createMember({ workspaceId, role: "author", sites: [site.siteId] })).browser;
		await author.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Spring menu" });
		const { drafts, count } = await author.api.publishing.drafts({ siteId: site.siteId });
		expect(drafts.map((draft) => draft.canPublish)).toEqual([false]);
		expect(count).toBe(0);
	});

	test("a published item whose Draft is the same as what is published isn't a Draft; nothing is left once everything is published", async () => {
		const site = await newSite();
		await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Spring menu" });
		const { component } = await staff.api.components.create({ siteId: site.siteId, name: "Notice" });
		await staff.api.components.saveMarkup({ siteId: site.siteId, componentId: component.id, markup: "<p>Hi</p>" });
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { padding: 2rem; }" });
		const { script } = await staff.api.scripts.saveDraft({
			siteId: site.siteId,
			entryId: null,
			code: "console.log(1);",
		});
		const { loop } = await staff.api.loops.create({
			siteId: site.siteId,
			name: "latest",
			source: "query",
			query: { postTypes: ["posts"] },
		});
		const { form } = await staff.api.forms.create({ siteId: site.siteId, name: "Contact", key: "contact" });
		await staff.api.consentBanner.saveDraft({ siteId: site.siteId, fields: { heading: "Cookies" } });

		const { drafts } = await staff.api.publishing.drafts({ siteId: site.siteId });
		expect(drafts.map((draft) => draft.item.kind as string).sort()).toEqual(
			["component", "consentBanner", "designSystem", "entry", "form", "loop", "script"].sort(),
		);
		expect(idOf(drafts.find((draft) => draft.item.kind === "script")?.item ?? { kind: "" })).toBe(script.id);
		expect(idOf(drafts.find((draft) => draft.item.kind === "loop")?.item ?? { kind: "" })).toBe(loop.id);
		expect(idOf(drafts.find((draft) => draft.item.kind === "form")?.item ?? { kind: "" })).toBe(form.id);

		await publishAll(
			staff,
			site.siteId,
			drafts.map((draft) => draft.item),
		);
		expect(await staff.api.publishing.drafts({ siteId: site.siteId })).toEqual({ drafts: [], count: 0 });
	});
});

describe("publishing them all", () => {
	test("takes two calls: the first previews the ticked items in the order they go live, and publishes nothing", async () => {
		const site = await newSite();
		const post = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { padding: 2rem; }" });
		const items = [{ kind: "entry", id: post.entry.id }, { kind: "designSystem" }] as const;

		const first = await staff.api.publishing.publishAll({ siteId: site.siteId, items: [...items] });
		expect(first).toEqual({
			published: false,
			preview: {
				items: [
					{ item: { kind: "designSystem" }, name: null, status: "new" },
					{ item: { kind: "entry", id: post.entry.id }, name: "Spring menu", status: "new" },
				],
			},
			confirmation: { id: expect.any(String), expiresAt: expect.any(Date) },
		});
		expect((await install.request(`${site.live}/blog/spring-menu`)).status).toBe(404);

		const second = await staff.api.publishing.publishAll({
			siteId: site.siteId,
			items: [...items],
			confirmation: confirmationOf(first),
		});
		expect(second).toMatchObject({
			published: true,
			items: [
				{ kind: "designSystem", pathChanges: [] },
				{ kind: "entry", id: post.entry.id, pathChanges: [] },
			],
		});
		expect((await install.request(`${site.live}/blog/spring-menu`)).status).toBe(200);
	});

	test("publishes only the ticked items: the unticked ones stay Drafts", async () => {
		const site = await newSite();
		const ticked = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Ticked",
		});
		const left = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Left" });

		await publishAll(staff, site.siteId, [{ kind: "entry", id: ticked.entry.id }]);

		expect((await install.request(`${site.live}/blog/ticked`)).status).toBe(200);
		expect((await install.request(`${site.live}/blog/left`)).status).toBe(404);
		const { drafts } = await staff.api.publishing.drafts({ siteId: site.siteId });
		expect(drafts.map((draft) => draft.item)).toEqual([{ kind: "entry", id: left.entry.id }]);
	});

	test("refuses a confirmation once a ticked Draft changed, or for another set of items", async () => {
		const site = await newSite();
		const post = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		const other = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Other" });
		const items = [{ kind: "entry" as const, id: post.entry.id }];

		const first = await staff.api.publishing.publishAll({ siteId: site.siteId, items });
		await staff.api.entries.saveDraft({ siteId: site.siteId, entryId: post.entry.id, title: "Summer menu" });
		await expect(
			staff.api.publishing.publishAll({ siteId: site.siteId, items, confirmation: confirmationOf(first) }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });

		const again = await staff.api.publishing.publishAll({ siteId: site.siteId, items });
		await expect(
			staff.api.publishing.publishAll({
				siteId: site.siteId,
				items: [...items, { kind: "entry", id: other.entry.id }],
				confirmation: confirmationOf(again),
			}),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });
		expect((await install.request(`${site.live}/blog/summer-menu`)).status).toBe(404);
	});

	test("refuses an item that is no Draft of the Site", async () => {
		const site = await newSite();
		const other = await newSite();
		const theirs = await staff.api.entries.create({
			siteId: other.siteId,
			postTypeId: other.postTypeId,
			title: "Theirs",
		});
		const published = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Done",
		});
		await staff.api.entries.publish({ siteId: site.siteId, entryId: published.entry.id });

		for (const item of [
			{ kind: "entry" as const, id: theirs.entry.id },
			{ kind: "entry" as const, id: published.entry.id },
			{ kind: "globals" as const },
		]) {
			await expect(staff.api.publishing.publishAll({ siteId: site.siteId, items: [item] })).rejects.toMatchObject({
				code: "PUBLISH_ALL_INVALID",
				data: { items: [item] },
			});
		}
	});

	test("Editors publish Content; ticking a Structure item is refused, and nothing is published", async () => {
		const site = await newSite();
		const editor = (await install.createMember({ workspaceId, role: "editor", sites: [site.siteId] })).browser;
		const post = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { padding: 2rem; }" });

		await expect(
			editor.api.publishing.publishAll({
				siteId: site.siteId,
				items: [{ kind: "entry", id: post.entry.id }, { kind: "designSystem" }],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "structure.edit" } });

		await publishAll(editor, site.siteId, [{ kind: "entry", id: post.entry.id }]);
		expect((await install.request(`${site.live}/blog/spring-menu`)).status).toBe(200);
		const author = (await install.createMember({ workspaceId, role: "author", sites: [site.siteId] })).browser;
		await expect(
			author.api.publishing.publishAll({ siteId: site.siteId, items: [{ kind: "designSystem" }] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("publishes what items need first: a new Page's parent, the Components a Template places, the Design system's Classes", async () => {
		const site = await newSite();
		const parent = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Team",
			slug: "team",
		});
		const child = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Bakers",
			slug: "bakers",
			parentId: parent.entry.id,
		});
		const { component: inner } = await staff.api.components.create({ siteId: site.siteId, name: "Hours" });
		await staff.api.components.saveMarkup({ siteId: site.siteId, componentId: inner.id, markup: "<p>Open 8–18</p>" });
		const { component: outer } = await staff.api.components.create({ siteId: site.siteId, name: "Notice" });
		await staff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: outer.id,
			markup: "<aside><Hours /></aside>",
		});
		const template = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><Notice /></header><main>{{@outlet}}</main>",
		});
		// Ticked in the order that would fail one at a time.
		await publishAll(staff, site.siteId, [
			{ kind: "entry", id: child.entry.id },
			{ kind: "template", id: template.template.id },
			{ kind: "component", id: outer.id },
			{ kind: "entry", id: parent.entry.id },
			{ kind: "component", id: inner.id },
		]);

		const page = await install.request(`${site.live}/team/bakers`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("<header><aside><p>Open 8–18</p></aside></header>");
	});

	test("goes live together or not at all: an item that can't be published stops all of them, naming it and why", async () => {
		const site = await newSite();
		const ready = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Ready" });
		const empty = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Soon" });
		await staff.api.entries.saveDraft({ siteId: site.siteId, entryId: empty.entry.id, title: "" });

		const items = [
			{ kind: "entry" as const, id: ready.entry.id },
			{ kind: "entry" as const, id: empty.entry.id },
		];
		const preview = await staff.api.publishing.publishAll({ siteId: site.siteId, items });
		await expect(
			staff.api.publishing.publishAll({ siteId: site.siteId, items, confirmation: confirmationOf(preview) }),
		).rejects.toMatchObject({
			code: "PUBLISH_ALL_REFUSED",
			data: {
				item: { kind: "entry", id: empty.entry.id },
				name: "",
				code: "ENTRY_INCOMPLETE",
				data: { missing: ["title"] },
			},
		});
		expect((await install.request(`${site.live}/blog/ready`)).status).toBe(404);
		expect((await staff.api.publishing.drafts({ siteId: site.siteId })).drafts).toHaveLength(2);
	});

	test("writes one Audit log entry per item and one for Publish all, sends one Webhook delivery per item, and clears the page cache once", async () => {
		const site = await newSite();
		const url = "https://hooks.agency.example/build";
		install.http.respond("POST", url, { status: 204 });
		await staff.api.webhooks.add({ siteId: site.siteId, url, events: ["publish"] });
		const first = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "First" });
		const second = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Second",
		});
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { padding: 2rem; }" });
		// A page visitors have seen, kept in the page cache.
		await install.request(`${site.live}/blog/missing`);

		await publishAll(staff, site.siteId, [
			{ kind: "entry", id: first.entry.id },
			{ kind: "entry", id: second.entry.id },
			{ kind: "designSystem" },
		]);

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		const ours = entries.filter((entry) => entry.siteId === site.siteId).slice(0, 4);
		expect(ours.map((entry) => entry.action).sort()).toEqual(
			["designSystem.publish", "entry.publish", "entry.publish", "site.publishAll"].sort(),
		);
		const umbrella = ours.find((entry) => entry.action === "site.publishAll");
		expect(umbrella).toMatchObject({
			personId: staffId,
			details: {
				count: 3,
				items: [
					{ kind: "designSystem" },
					{ kind: "entry", id: first.entry.id },
					{ kind: "entry", id: second.entry.id },
				],
			},
		});

		expect((await install.drainJobs()).failed).toEqual([]);
		const delivered = install.http.requests
			.filter((request) => request.url === url)
			.map((request) => JSON.parse(request.body).data.item.kind);
		expect(delivered.sort()).toEqual(["designSystem", "entry", "entry"]);
		expect((await install.request(`${site.live}/blog/first`)).status).toBe(200);
		expect((await install.request(`${site.live}/blog/second`)).status).toBe(200);
	});

	test("Modules hear of each item after it is published: a Draft slug change gets its Redirect rule", async () => {
		await (await install.superadmin()).api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
		const site = await newSite();
		const post = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Rye" });
		await staff.api.entries.publish({ siteId: site.siteId, entryId: post.entry.id });
		await staff.api.entries.saveDraft({ siteId: site.siteId, entryId: post.entry.id, slug: "rye-loaf" });

		await publishAll(staff, site.siteId, [{ kind: "entry", id: post.entry.id }]);
		expect((await install.drainJobs()).failed).toEqual([]);

		const old = await install.request(`${site.live}/blog/rye`);
		expect(old.status).toBe(301);
		expect(old.headers.get("location")).toBe("/blog/rye-loaf");
	});
});

describe("publishing one item", () => {
	test("still works on its own, leaving the Site's other Drafts as they are", async () => {
		const site = await newSite();
		const one = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "One" });
		const two = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Two" });

		await staff.api.entries.publish({ siteId: site.siteId, entryId: one.entry.id });

		expect((await install.request(`${site.live}/blog/one`)).status).toBe(200);
		expect((await install.request(`${site.live}/blog/two`)).status).toBe(404);
		const { drafts } = await staff.api.publishing.drafts({ siteId: site.siteId });
		expect(drafts.map((draft) => draft.item)).toEqual([{ kind: "entry", id: two.entry.id }]);
	});
});
