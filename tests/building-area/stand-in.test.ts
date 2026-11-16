// The building area's documents (ADR 0037 › Addresses): every form of address opens its document in
// the shell, and a Template or Component that no page shows is drawn on the stand-in,
// `/_webcraft/build/stand-in/<document>`: the visual builder's preview as a document of the Site's
// address, with the page agent first and the Design system Draft's stylesheet, and none of the Site's
// scripts. Only someone in the building area who may change Structure gets it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { type BuildingAreaBrowser, openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { headOf } from "../harness/code-mode.ts";
import { openEditMode, withoutBuildingAreaCookie } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let otherComponentId: string;
let componentId: string;
let placedId: string;
let postTypeId: string;
let firstId: string;
let secondId: string;
let building: BuildingAreaBrowser;
const origin = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const { api } = staff;

	await api.designSystem.createClass({ siteId, name: "quote", styles: "font-style: italic;" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entryTemplate = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	for (const title of ["Rye", "Spelt"]) {
		const { entry } = await api.entries.create({ siteId, postTypeId, title });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (title === "Rye") firstId = entry.id;
		else secondId = entry.id;
	}
	// A Search results template, with no search page to show it on.
	await api.templates.saveSearchTemplateMarkup({ siteId, markup: "<h1>Found for you</h1>" });

	// A Component no page shows, and one the Site template places.
	const { component } = await api.components.create({ siteId, name: "CustomerQuote" });
	componentId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId,
		markup: '<blockquote class="quote">Best rye in Cork.</blockquote>',
	});
	const { component: placed } = await api.components.create({ siteId, name: "OpeningHours" });
	placedId = placed.id;
	await api.components.saveMarkup({ siteId, componentId: placedId, markup: "<p>Open at seven</p>" });
	await api.components.publish({ siteId, componentId: placedId });
	const withPlacement = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p><OpeningHours /></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: withPlacement.template.id });

	// A Site script, which the stand-in never runs.
	const { script } = await api.scripts.saveDraft({ siteId, entryId: null, code: "window.site = true;" });
	await api.scripts.publish({ siteId, scriptId: script.id });

	// Another Site of the same Workspace, with its own Component.
	const otherId = (await install.createSite(workspaceId, { name: "Other", slug: "other" })).id;
	otherComponentId = (await api.components.create({ siteId: otherId, name: "Elsewhere" })).component.id;

	building = await openBuildingArea(install, staff, siteId);
});

afterAll(async () => {
	await install.close();
});

/** A document's body without the builder's tags (`data-wc-code`, its comments), to read what it shows. */
function textOf(html: string): string {
	const body = html.slice(html.indexOf("<body"));
	return body.replaceAll(/ data-wc-code="[^"]*"/g, "").replaceAll(/<!--wc-code-[^>]*-->/g, "");
}

/** The stand-in as the shell's frame asks for it. */
function standIn(document: string, as: BuildingAreaBrowser = building, destination = "iframe") {
	return as.page(`/_webcraft/build/stand-in${document}`, destination as "iframe");
}

describe("the shell's addresses", () => {
	test("each form of address opens the shell at its document", async () => {
		for (const address of [
			"/page/",
			"/page/blog/rye",
			"/site-template",
			"/search-template",
			`/entry-template/${postTypeId}`,
			`/entry-template/${postTypeId}?entry=${secondId}`,
			`/archive-template/${postTypeId}`,
			`/component/${componentId}`,
			`/form/${componentId}`,
		]) {
			const response = await building.shell(`/_webcraft/build${address}`);
			expect([address, response.status]).toEqual([address, 200]);
			const config = shellConfigIn(await response.text());
			expect(config?.page).toBe(address === "/page/" ? "/" : address === "/page/blog/rye" ? "/blog/rye" : null);
		}
	});

	test("keeps the shell's own parameters off the page's query", async () => {
		const response = await building.shell("/_webcraft/build/page/blog?page=2&wc-place=media&wc-select=content%23abc");

		expect(shellConfigIn(await response.text())?.page).toBe("/blog?page=2");
	});

	test("an address that names nothing of the Site still gets the shell, as a 404", async () => {
		for (const address of [
			"/elsewhere",
			"/component/not-an-id",
			`/component/${componentId}/more`,
			`/entry-template/${postTypeId}?entry=nope`,
			`/archive-template/${postTypeId}?entry=${firstId}`,
			"/page//evil.example",
			"/page/_webcraft/build/page/",
			"/page/_media/photo.jpg",
		]) {
			const response = await building.shell(`/_webcraft/build${address}`);
			expect([address, response.status]).toEqual([address, 404]);
			// The shell itself, which says there is nothing to open.
			expect(shellConfigIn(await response.text())).toMatchObject({ page: null });
		}
	});

	test("the admin's way in opens a Template or Component directly", async () => {
		const opened = await openBuildingArea(install, staff, siteId, { open: `/component/${componentId}` });
		expect(opened.landed).toBe(`/_webcraft/build/component/${componentId}`);

		const entry = await openBuildingArea(install, staff, siteId, {
			open: `/entry-template/${postTypeId}?entry=${firstId}`,
		});
		expect(entry.landed).toBe(`/_webcraft/build/entry-template/${postTypeId}?entry=${firstId}`);

		await expect(staff.api.editMode.open({ siteId, open: "/component/not-an-id" })).rejects.toMatchObject({
			status: 400,
		});
	});
});

describe("the stand-in", () => {
	test("draws an unplaced Component as the builder previews it, with the agent first and none of the Site's scripts", async () => {
		const response = await standIn(`/component/${componentId}`);

		expect(response.status).toBe(200);
		const html = await response.text();
		const head = headOf(html);
		// The agent is the only script, first in <head>; nothing of the Site's runs.
		const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/^<script src="\/_webcraft\/edit\/assets\/agent-[0-9a-f]+\.js">$/);
		expect(head.indexOf("<script")).toBeLessThan(head.indexOf("<style"));
		expect(html).not.toContain("data-wc-script");
		expect(html).not.toContain("window.site");
		// The Component itself, tagged as the builder tags its elements, with the Draft's Classes.
		expect(textOf(html)).toContain('<blockquote class="quote">Best rye in Cork.</blockquote>');
		expect(html).toContain(".quote");
		expect(html).toMatch(/font-style:\s*italic/);
	});

	test("is served under a policy of its own: the agent, its styles by their hashes, framed by its origin only", async () => {
		const response = await standIn(`/component/${componentId}`);
		const html = await response.text();

		expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		const policy = response.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("script-src 'self'");
		expect(policy).toContain("frame-ancestors 'self'");
		expect(policy).toContain("form-action 'none'");
		expect(policy).not.toContain("unsafe-inline");
		// Exactly its style blocks are allowed, by their hashes.
		const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? "");
		expect(blocks).toHaveLength(2);
		for (const block of blocks) {
			expect(policy).toContain(`'sha256-${createHash("sha256").update(block).digest("base64")}'`);
		}
	});

	test("draws a Search results template that has no search page, with what only a page has worded", async () => {
		const search = await standIn("/search-template");
		expect(search.status).toBe(200);
		expect(textOf(await search.text())).toContain("Found for you");

		const site = await (await standIn("/site-template")).text();
		expect(site).toContain(`data-wc-builder-placeholder="outlet">Each page's content goes here</span>`);
	});

	test("previews an Entry template on the Entry it names, else its newest", async () => {
		const named = await (await standIn(`/entry-template/${postTypeId}?entry=${firstId}`)).text();
		expect(textOf(named)).toContain("<h1>Rye</h1>");

		const other = await (await standIn(`/entry-template/${postTypeId}?entry=${secondId}`)).text();
		expect(textOf(other)).toContain("<h1>Spelt</h1>");
	});

	test("opened at the top level, goes into the shell at the document it draws", async () => {
		const response = await standIn(`/entry-template/${postTypeId}?entry=${firstId}`, building, "document");

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`/_webcraft/build/entry-template/${postTypeId}?entry=${firstId}`);
	});

	test("names nothing of another Site, nor anything that isn't a Template or Component", async () => {
		for (const document of [
			`/component/${otherComponentId}`,
			`/entry-template/${postTypeId}?entry=${componentId}`,
			`/archive-template/${componentId}`,
			"/component/not-an-id",
			`/form/${componentId}`,
			"/page/",
			"",
		]) {
			expect([document, (await standIn(document)).status]).toEqual([document, 404]);
		}
	});

	test("is refused without an edit session, outside the building area, and to someone who may not change Structure", async () => {
		const visitor = install.browser({ origin });
		const anonymous = await visitor.request(`${origin}/_webcraft/build/stand-in/component/${componentId}`, {
			headers: { "sec-fetch-dest": "iframe" },
		});
		expect(anonymous.status).toBe(401);
		expect(await anonymous.text()).not.toContain("Best rye");

		// In Edit mode without the building-area cookie (a session from before it).
		const editing = await openEditMode(install, staff, siteId, "/");
		withoutBuildingAreaCookie(editing.browser);
		const plain = await editing.browser.request(`${origin}/_webcraft/build/stand-in/component/${componentId}`, {
			headers: { "sec-fetch-dest": "iframe" },
		});
		expect(plain.status).toBe(401);

		// A Member in the building area.
		const member = await openBuildingArea(install, editor, siteId);
		const refused = await standIn(`/component/${componentId}`, member);
		expect(refused.status).toBe(403);
		expect(await refused.text()).not.toContain("Best rye");
	});

	test("the placed Component is found on a page that shows it, not on the stand-in", async () => {
		const found = await staff.api.builder.destinations({
			siteId,
			target: { kind: "component", componentId: placedId },
		});
		expect(found.pages.map((page) => page.path)).toContain("/blog/rye");

		const unplaced = await staff.api.builder.destinations({ siteId, target: { kind: "component", componentId } });
		expect(unplaced).toMatchObject({ pages: [], reason: "notPlaced" });
	});
});
