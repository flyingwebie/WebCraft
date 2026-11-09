// Links never break: when a published path changes (a new slug, a Page that moves with the Pages
// under it, a Post Type's new URL pattern, a new Default language), the Redirects Module adds a rule
// from the old path to the new one. It does so after the change, as a background job, so publishing
// never waits for it; chains collapse into one hop, and a rule it made never hides a page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

const rules = () => moduleApi<typeof redirects>(editor, "redirects").rules;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;
type TestSite = { siteId: string; origin: string; pagesId: string; blogId: string };

/** A Site with a Blog Post Type at `/blog/{slug}` (its Entry template published) and its Pages. */
async function newSite(): Promise<TestSite> {
	const slug = `moving-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const pagesId = (await editor.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id;
	return { siteId, origin: `https://${slug}.live.test`, pagesId: pagesId ?? "", blogId: postType.id };
}

/** Publishing takes a moment: each change happens later than the one before, as it does for people. */
async function publish(
	site: TestSite,
	postTypeId: string,
	title: string,
	more: { parentId?: string; slug?: string } = {},
) {
	await install.clock.advance(1000);
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, title, ...more });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function republish(site: TestSite, entryId: string, change: { slug?: string; parentId?: string | null }) {
	await install.clock.advance(1000);
	await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, ...change });
	await editor.api.entries.publish({ siteId: site.siteId, entryId });
}

/** Where a path sends visitors: `[status, location]`. */
async function at(site: TestSite, path: string): Promise<[number, string | null]> {
	const response = await install.request(`${site.origin}${path}`);
	return [response.status, response.headers.get("location")];
}

async function drained() {
	expect((await install.drainJobs()).failed).toEqual([]);
}

describe("a published slug that changes", () => {
	test("gets a rule from its old path to the new one, once the publish is saved", async () => {
		const site = await newSite();
		const post = await publish(site, site.blogId, "Fresh bread");

		await republish(site, post, { slug: "daily-bread" });
		// The rule comes after the publish, as a background job.
		expect(await at(site, "/blog/fresh-bread")).toEqual([404, null]);
		await drained();

		expect(await at(site, "/blog/fresh-bread")).toEqual([301, "/blog/daily-bread"]);
		const [rule] = (await rules().list({ siteId: site.siteId })).rules;
		expect(rule).toMatchObject({ from: "/blog/fresh-bread", to: "/blog/daily-bread", status: 301, automatic: true });
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "redirects.rules.follow",
			via: { kind: "module", name: "redirects" },
			details: { reason: "publish", added: 1 },
		});
	});

	test("a Page that moves takes the Pages under it along: each old path gets its rule", async () => {
		const site = await newSite();
		const about = await publish(site, site.pagesId, "About");
		const company = await publish(site, site.pagesId, "Company");
		const team = await publish(site, site.pagesId, "Team", { parentId: about });
		await publish(site, site.pagesId, "Bakers", { parentId: team });

		await republish(site, team, { parentId: company, slug: "people" });
		await drained();

		expect(await at(site, "/about/team")).toEqual([301, "/company/people"]);
		expect(await at(site, "/about/team/bakers")).toEqual([301, "/company/people/bakers"]);
		expect((await at(site, "/company/people/bakers"))[0]).toBe(200);
	});

	test("chains collapse: a rule to the old path, a person's included, now sends visitors to the new one", async () => {
		const site = await newSite();
		const post = await publish(site, site.blogId, "Rye");
		await rules().add({ siteId: site.siteId, from: "/rye-bread", to: "/blog/rye", status: 302 });

		await republish(site, post, { slug: "dark-rye" });
		await drained();
		await republish(site, post, { slug: "light-rye" });
		await drained();

		expect(await at(site, "/blog/rye")).toEqual([301, "/blog/light-rye"]);
		expect(await at(site, "/blog/dark-rye")).toEqual([301, "/blog/light-rye"]);
		expect(await at(site, "/rye-bread")).toEqual([302, "/blog/light-rye"]);
		const listed = (await rules().list({ siteId: site.siteId })).rules.map((rule) => [rule.from, rule.to]);
		expect(listed.sort()).toEqual([
			["/blog/dark-rye", "/blog/light-rye"],
			["/blog/rye", "/blog/light-rye"],
			["/rye-bread", "/blog/light-rye"],
		]);
	});

	test("going back to an old slug takes away the rule from it, which would only go round in a circle", async () => {
		const site = await newSite();
		const post = await publish(site, site.blogId, "Scones");
		await republish(site, post, { slug: "fruit-scones" });
		await drained();

		await republish(site, post, { slug: "scones" });
		await drained();

		expect((await at(site, "/blog/scones"))[0]).toBe(200);
		expect(await at(site, "/blog/fruit-scones")).toEqual([301, "/blog/scones"]);
		const listed = (await rules().list({ siteId: site.siteId })).rules.map((rule) => [rule.from, rule.to]);
		expect(listed).toEqual([["/blog/fruit-scones", "/blog/scones"]]);
	});

	test("a rule the Module made never hides a page published at its old path later", async () => {
		const site = await newSite();
		const first = await publish(site, site.blogId, "Buns");
		await republish(site, first, { slug: "sweet-buns" });
		await drained();
		expect(await at(site, "/blog/buns")).toEqual([301, "/blog/sweet-buns"]);

		await publish(site, site.blogId, "Buns", { slug: "buns" });
		// The page shows at once, before the Module tidies its rule away.
		expect((await at(site, "/blog/buns"))[0]).toBe(200);
		await drained();
		expect((await rules().list({ siteId: site.siteId })).rules).toEqual([]);
	});

	test("a person's rule at the old path stays as they made it", async () => {
		const site = await newSite();
		const post = await publish(site, site.blogId, "Tarts");
		await rules().add({ siteId: site.siteId, from: "/blog/tarts-old", to: "/about", status: 302 });
		await republish(site, post, { slug: "tarts-old" });
		await drained();

		await republish(site, post, { slug: "tarts-new" });
		await drained();

		expect(await at(site, "/blog/tarts-old")).toEqual([302, "/about"]);
	});

	test("where the Module is switched off, publishing adds no rule", async () => {
		const site = await newSite();
		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "redirects", on: false });
		const post = await publish(site, site.blogId, "Pretzels");
		await republish(site, post, { slug: "salted-pretzels" });
		await drained();
		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "redirects", on: true });

		expect((await rules().list({ siteId: site.siteId })).rules).toEqual([]);
		expect(await at(site, "/blog/pretzels")).toEqual([404, null]);
	});
});

describe("published paths that change without a publish", () => {
	test("a Post Type's new URL pattern moves every Entry's address: each old one gets a rule", async () => {
		const site = await newSite();
		await staff.api.languages.add({ siteId: site.siteId, code: "fr" });
		const post = await publish(site, site.blogId, "Fresh bread");
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: post,
			language: "fr",
			title: "Pain frais",
			slug: "pain-frais",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: post });

		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.blogId, urlPattern: "/news/{slug}" });
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "postType.update",
			details: {
				pathChanges: expect.arrayContaining([
					{ entryId: post, language: "en", from: "/blog/fresh-bread", to: "/news/fresh-bread" },
					{ entryId: post, language: "fr", from: "/fr/blog/pain-frais", to: "/fr/news/pain-frais" },
				]),
			},
		});
		await drained();

		expect(await at(site, "/blog/fresh-bread")).toEqual([301, "/news/fresh-bread"]);
		expect(await at(site, "/fr/blog/pain-frais")).toEqual([301, "/fr/news/pain-frais"]);
	});

	test("a new Default language: each address that moved gets a rule, except where another page now is", async () => {
		const site = await newSite();
		await staff.api.languages.add({ siteId: site.siteId, code: "fr" });
		const bread = await publish(site, site.blogId, "Fresh bread");
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: bread, language: "fr", slug: "pain-frais" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: bread });
		// Rolls has one slug in both languages: its old English path is the French page's new one.
		await publish(site, site.blogId, "Rolls");

		const asked = await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr" });
		if (asked.changed) throw new Error("It should ask first.");
		await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr", confirmation: asked.confirmation.id });
		await drained();

		expect(await at(site, "/blog/fresh-bread")).toEqual([301, "/en/blog/fresh-bread"]);
		expect(await at(site, "/fr/blog/pain-frais")).toEqual([301, "/blog/pain-frais"]);
		expect((await at(site, "/blog/rolls"))[0]).toBe(200);
		const froms = (await rules().list({ siteId: site.siteId })).rules.map((rule) => rule.from).sort();
		// Publishing the French slug had moved /fr/blog/fresh-bread already: its rule follows the new move.
		expect(froms).toEqual(["/blog/fresh-bread", "/fr/blog/fresh-bread", "/fr/blog/pain-frais", "/fr/blog/rolls"]);
		expect(await at(site, "/fr/blog/fresh-bread")).toEqual([301, "/blog/pain-frais"]);
	});

	test("rules that would go round in a circle are never followed: the page answers, and the Module log says so", async () => {
		const site = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Notes",
			urlPattern: "/notes/{slug}",
		});
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: postType.id,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		await publish(site, postType.id, "Plan");
		await rules().add({ siteId: site.siteId, from: "/drafts/*", to: "/notes/*", status: 301 });

		// The Notes move to /drafts: the Module's rule sends /notes/plan there, and the person's back.
		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: postType.id, urlPattern: "/drafts/{slug}" });
		await drained();

		const response = await install.request(`${site.origin}/drafts/plan`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<h1>Plan</h1>");
		const { lines } = await admin.api.modules.log({ moduleId: "redirects", limit: 5 });
		expect(lines.map((line) => line.message)).toContain(
			"Redirect rules go round in a circle; the Site's page answered instead.",
		);
	});
});
