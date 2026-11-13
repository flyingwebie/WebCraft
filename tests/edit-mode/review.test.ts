// Review in Edit mode: an Author submits the page's changes (its Entry and the Globals it shows) for
// Review from the editing bar, with a note, sees them In review, and can withdraw them; a page sent
// back shows its comment. The people who may publish hear of the page once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: null,
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = {
	siteId: string;
	entryId: string;
	author: TestBrowser;
	editor: TestBrowser;
	editorEmail: string;
};

/** A live Site whose pages show a Global, with a published Blog post at /blog/fresh-bread, an Author and an Editor. */
async function bakery(): Promise<Bakery> {
	const slug = `review-bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await staff.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await staff.api.globals.publish({ siteId });
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>{{ site.tagline }}</p></header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const author = await install.createMember({ workspaceId, role: "author", sites: [siteId], name: "Aidan Author" });
	const editor = await install.createMember({ workspaceId, role: "editor", sites: [siteId], name: "Erin Editor" });
	return {
		siteId,
		entryId: entry.id,
		author: author.browser,
		editor: editor.browser,
		editorEmail: editor.account.email,
	};
}

type PageReview = {
	item: string;
	status: "inReview" | "sentBack";
	by: { name: string; you: boolean } | null;
	note: string | null;
	comment: string | null;
	canWithdraw: boolean;
	changedSinceSubmitted: boolean;
};

type PageState = { canPublish: boolean; changes: { item: string }[]; reviews: PageReview[] };

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

async function stateOf(editing: EditModeBrowser, path: string): Promise<PageState> {
	const response = await editing.edit("state", { path });
	expect(response.status).toBe(200);
	return (await json(response)) as unknown as PageState;
}

const path = "/blog/fresh-bread";

describe("submitting the page", () => {
	test("an Author submits the page's changes with a note: they show In review, and reviewers hear of the page once", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, site.author, site.siteId, path);
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });
		await editing.edit("save", { item: "globals", field: "tagline", value: "Baked twice daily" });
		install.mail.clear();

		const response = await editing.edit("review/submit", { path, note: "New tagline too." });

		expect(response.status).toBe(200);
		const state = (await json(response)) as unknown as PageState;
		expect(state.reviews).toMatchObject([
			{
				item: `entry:${site.entryId}`,
				status: "inReview",
				by: { name: "Aidan Author", you: true },
				note: "New tagline too.",
				canWithdraw: true,
			},
			{ item: "globals", status: "inReview", note: "New tagline too.", canWithdraw: true },
		]);
		await install.drainJobs();
		const told = install.mail.sent.filter((email) => email.to === site.editorEmail);
		expect(told.map((email) => email.subject)).toEqual([
			"Aidan Author submitted “Fresh bread” and the Globals for review",
		]);
		expect(told[0]?.text).toContain(`/sites/${site.siteId}`);
		const { reviews } = await site.editor.api.reviews.list({ siteId: site.siteId });
		expect(reviews.map((review) => review.item.kind)).toEqual(["entry", "globals"]);
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(entries.find((entry) => entry.action === "review.submit")).toMatchObject({ via: { kind: "editMode" } });

		// The Editor sees it In review in Edit mode too, and can't withdraw it.
		const reviewing = await openEditMode(install, site.editor, site.siteId, path);
		expect((await stateOf(reviewing, path)).reviews).toMatchObject([
			{ status: "inReview", by: { name: "Aidan Author", you: false }, canWithdraw: false },
			{ status: "inReview", canWithdraw: false },
		]);
	});

	test("the Author withdraws the page's Reviews; a page with nothing changed has nothing to submit", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, site.author, site.siteId, path);
		const nothing = await editing.edit("review/submit", { path });
		expect(nothing.status).toBe(400);
		expect(await json(nothing)).toMatchObject({ code: "REVIEW_INVALID", data: { reason: "nothingToReview" } });

		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });
		await editing.edit("review/submit", { path });
		const withdrawn = await editing.edit("review/withdraw", { path });

		expect(withdrawn.status).toBe(200);
		expect(((await json(withdrawn)) as unknown as PageState).reviews).toEqual([]);
		expect((await site.editor.api.reviews.list({ siteId: site.siteId })).reviews).toEqual([]);
	});

	test("a page sent back shows its comment to the Author until they submit it again", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, site.author, site.siteId, path);
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });
		await editing.edit("review/submit", { path });
		const [review] = (await site.editor.api.reviews.list({ siteId: site.siteId })).reviews;
		await site.editor.api.reviews.sendBack({
			siteId: site.siteId,
			reviewId: review?.id as string,
			comment: "Say when it comes out.",
		});

		const sentBack = await stateOf(editing, path);
		expect(sentBack.reviews).toMatchObject([
			{
				item: `entry:${site.entryId}`,
				status: "sentBack",
				by: { name: "Erin Editor", you: false },
				comment: "Say when it comes out.",
				canWithdraw: false,
			},
		]);
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Out at seven" });
		await editing.edit("review/submit", { path });
		expect((await stateOf(editing, path)).reviews).toMatchObject([{ status: "inReview", comment: null }]);
	});
});
