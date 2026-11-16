// The code panes' edit requests in the building area (BA-11; ADR 0037 › 1.7). The HTML pane previews
// markup being typed through Code mode's `code/preview`: in the building area the page it answers is
// the frame's own page (both kinds of tags, the page agent, never the editing bar or Code mode's
// script), with the markup in place of its source's Draft, and nothing is saved. Markup that can't be
// read is refused with each problem's line and column. A Member may not preview Structure at all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let postTypeId: string;
const path = "/blog/fresh-bread";
const MARKUP =
	'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><p data-wc-id="lead">Baked by hand.</p></article>';

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<main data-wc-id="main">{{@outlet}}</main>',
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: MARKUP });
	await staff.api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await staff.api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: post.id });
});

afterAll(async () => {
	await install.close();
});

describe("the HTML pane's preview in the building area", () => {
	let building: BuildingAreaBrowser;

	beforeAll(async () => {
		building = await openBuildingArea(install, staff, siteId, { path });
	});

	test("is the frame's page with the markup typed, both kinds of tags and the page agent, and saves nothing", async () => {
		const answer = await building.edit("code/preview", {
			path,
			markup: { ref: "content", text: MARKUP.replace("Baked by hand.", "Previewed, not saved.") },
		});
		expect(answer.status).toBe(200);
		const { html, stylesheet } = (await answer.json()) as { html: string; stylesheet: { css: string } };
		expect(html).toContain("Previewed, not saved.");
		// The title is an editable region and an element of the Entry template, in one tag.
		expect(html).toMatch(
			/<h1 data-wc-item="entry:[0-9a-f-]+" data-wc-field="title"[^>]* data-wc-code="content#title">/,
		);
		expect(html).toMatch(/<script src="\/_webcraft\/edit\/assets\/agent-[0-9a-f]+\.js"/);
		expect(html).not.toContain("/_webcraft/edit/assets/code-");
		expect(html).not.toMatch(/\/_webcraft\/edit\/assets\/(bar|code)-/);
		expect(typeof stylesheet.css).toBe("string");
		const saved = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
		expect(saved.markup?.draft).not.toContain("Previewed");
	});

	test("refuses markup that can't be read, with each problem's line and column", async () => {
		const answer = await building.edit("code/preview", {
			path,
			markup: { ref: "content", text: '<article data-wc-id="article">\n<h1>{{ title }}</h2>\n</article>' },
		});
		expect(answer.status).toBe(400);
		const refusal = (await answer.json()) as {
			code: string;
			data: { problems: { line: number; column: number; message: string }[] };
		};
		expect(refusal.code).toBe("TEMPLATE_MARKUP_INVALID");
		expect(refusal.data.problems.length).toBeGreaterThan(0);
		for (const problem of refusal.data.problems) {
			expect(problem.line).toBeGreaterThanOrEqual(1);
			expect(problem.column).toBeGreaterThanOrEqual(1);
			expect(problem.message.length).toBeGreaterThan(0);
		}
	});

	test("is refused to a Member, who may not change Structure", async () => {
		const member = await openBuildingArea(install, editor, siteId, { path });
		const answer = await member.edit("code/preview", { path, markup: { ref: "content", text: MARKUP } });
		expect(answer.status).toBe(403);
	});
});
