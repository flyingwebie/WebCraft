// Edit requests: what the editing bar sends from a page in Edit mode to change the Draft. Each one is
// checked again from scratch (the edit cookie, the admin session it came from, the person's access
// to the Site) and must come from the Site's own pages with the session's header token, so no other
// site can use the cookie. Signing out of the admin, or losing access, ends Edit mode at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = { siteId: string; origin: string; entryId: string };

/** A Site with Globals and a published Blog post at /blog/fresh-bread showing its Fields. */
async function bakery(): Promise<Bakery> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await editor.api.globals.publish({ siteId });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text", maxLength: 20 },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
			{ key: "price", label: "Price", type: "number" },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			"<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div><p>{{ address.city }}</p><p>{{ site.tagline }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven", intro: "<p>Baked at seven.</p>", address: { city: "Cork" } },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, origin: `https://${slug}.live.test`, entryId: entry.id };
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("saving in Edit mode", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
	});

	test("changes the Draft; visitors still see the published page", async () => {
		const response = await editing.edit("save", {
			item: `entry:${site.entryId}`,
			field: "subtitle",
			value: "Still warm",
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await json(response)).toMatchObject({ status: "changed", value: "Still warm", problems: [] });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.subtitle).toBe("Still warm");
		expect(entry.published?.fields.subtitle).toBe("Out of the oven");
		expect(await (await editing.page("/blog/fresh-bread")).text()).toContain(">Still warm</p>");
		expect(await (await install.request(`${site.origin}/blog/fresh-bread`)).text()).toContain("<p>Out of the oven</p>");
	});

	test("saves the title, a Group's Field and the Globals the same way", async () => {
		for (const [item, field, value] of [
			[`entry:${site.entryId}`, "title", "Fresher bread"],
			[`entry:${site.entryId}`, "address.city", "Kinsale"],
			["globals", "tagline", "Baked twice daily"],
		] as const) {
			const response = await editing.edit("save", { item, field, value });
			expect({ field, status: response.status }).toEqual({ field, status: 200 });
		}

		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("Fresher bread");
		expect(entry.draft.fields.address).toEqual({ city: "Kinsale" });
		const { globals } = await editor.api.globals.get({ siteId: site.siteId });
		expect(globals.draft.tagline).toBe("Baked twice daily");
		expect(globals.published?.tagline).toBe("Baked daily");
	});

	test("rich text is cleaned as the admin cleans it", async () => {
		const response = await editing.edit("save", {
			item: `entry:${site.entryId}`,
			field: "intro",
			value: '<p onclick="steal()">Baked at <b>six</b><script>steal()</script></p><img src=x onerror=steal()>',
		});

		expect(await json(response)).toMatchObject({ value: "<p>Baked at <b>six</b></p>" });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.intro).toBe("<p>Baked at <b>six</b></p>");
	});

	test("a value that breaks a rule is kept, and its problems come back to show next to the region", async () => {
		const tooLong = await json(
			await editing.edit("save", {
				item: `entry:${site.entryId}`,
				field: "subtitle",
				value: "Far too long for this subtitle",
			}),
		);
		expect(tooLong).toMatchObject({
			value: "Far too long for this subtitle",
			problems: [{ at: "fields.subtitle", rule: "maxLength" }],
		});

		const empty = await json(await editing.edit("save", { item: `entry:${site.entryId}`, field: "title", value: "" }));
		expect(empty).toMatchObject({ problems: [{ at: "title", rule: "required" }] });
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "title", value: "Fresh bread" });
	});

	test("only text and rich text can be typed over in place", async () => {
		for (const [item, field] of [
			[`entry:${site.entryId}`, "price"],
			[`entry:${site.entryId}`, "address"],
			[`entry:${site.entryId}`, "slug"],
			[`entry:${site.entryId}`, "nothing"],
			["globals", "nothing"],
			["menus", "title"],
		] as const) {
			const response = await editing.edit("save", { item, field, value: "12" });
			expect({ item, field, status: response.status, body: await json(response) }).toMatchObject({
				item,
				field,
				status: 400,
				body: { code: "EDIT_FIELD_INVALID" },
			});
		}
	});

	test("an Entry of another Site, even in the same Workspace, can't be changed from this one", async () => {
		const other = await bakery();

		const response = await editing.edit("save", {
			item: `entry:${other.entryId}`,
			field: "subtitle",
			value: "Hijacked",
		});

		expect(response.status).toBe(404);
		expect(await json(response)).toMatchObject({ code: "ENTRY_NOT_FOUND" });
		const { entry } = await editor.api.entries.get({ siteId: other.siteId, entryId: other.entryId });
		expect(entry.draft.fields.subtitle).toBe("Out of the oven");
	});

	test("saving a Draft isn't written to the Audit log, but starting Edit mode is, with how it came in", async () => {
		const admin = await install.superadmin();
		const { entries } = await admin.api.audit.list({ limit: 200 });
		const here = entries.filter((entry) => entry.siteId === site.siteId);

		expect(here.find((entry) => entry.action === "editMode.start")).toMatchObject({
			via: { kind: "editMode" },
			details: { path: "/blog/fresh-bread" },
		});
		expect(here.map((entry) => entry.action)).not.toContain("entry.saveDraft");
	});
});

describe("what every edit request must carry", () => {
	let site: Bakery;
	let editing: EditModeBrowser;
	const save = () => ({ item: `entry:${site.entryId}`, field: "subtitle", value: "Changed" });

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
	});

	async function expectRefused(response: Response, status: number, code: string): Promise<void> {
		expect({ status: response.status, body: await json(response) }).toMatchObject({ status, body: { code } });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.subtitle).toBe("Out of the oven");
	}

	test("the session's header token", async () => {
		await expectRefused(await editing.edit("save", save(), { headerToken: null }), 403, "EDIT_REQUEST_REFUSED");
		await expectRefused(
			await editing.edit("save", save(), { headerToken: "A".repeat(43) }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		// Another Edit mode session's token isn't this one's.
		const other = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
		await expectRefused(
			await editing.edit("save", save(), { headerToken: await other.headerToken() }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
	});

	test("the Site's own origin", async () => {
		await expectRefused(
			await editing.edit("save", save(), { origin: "https://elsewhere.example", fetchSite: "cross-site" }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		await expectRefused(
			await editing.edit("save", save(), { origin: site.origin, fetchSite: "same-site" }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		await expectRefused(await editing.edit("save", save(), { origin: null }), 403, "EDIT_REQUEST_REFUSED");
	});

	test("the edit cookie", async () => {
		const stranger = install.browser({ origin: site.origin });
		const response = await stranger.request(`${site.origin}/_webcraft/edit/api/save`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-webcraft-edit-token": await editing.headerToken() },
			body: JSON.stringify(save()),
		});

		await expectRefused(response, 401, "EDIT_MODE_ENDED");
	});

	test("a POST of JSON", async () => {
		const get = await editing.browser.request(`${site.origin}/_webcraft/edit/api/save`);
		expect(get.status).toBe(405);
		const notJson = await editing.browser.request(`${site.origin}/_webcraft/edit/api/save`, {
			method: "POST",
			headers: { "content-type": "text/plain", "x-webcraft-edit-token": await editing.headerToken() },
			body: JSON.stringify(save()),
		});
		await expectRefused(notJson, 400, "BAD_REQUEST");
		await expectRefused(await editing.edit("save", { item: 5 }), 400, "BAD_REQUEST");
		await expectRefused(await editing.edit("no-such-action", save()), 404, "NOT_FOUND");
	});
});

describe("Edit mode ends", () => {
	/** A new Editor, signed in to the admin, in Edit mode on a new Site. */
	async function editingEditor() {
		const site = await bakery();
		const member = await install.createMember({ workspaceId, role: "editor" });
		const editing = await openEditMode(install, member.browser, site.siteId, "/blog/fresh-bread");
		return { site, member, editing };
	}

	/** Edit mode has ended for this browser: edit requests are refused and pages are visitors' again. */
	async function expectEnded(editing: EditModeBrowser, site: Bakery): Promise<void> {
		const response = await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Late" });
		expect(response.status).toBe(401);
		expect(await json(response)).toMatchObject({ code: "EDIT_MODE_ENDED" });

		const page = await editing.page("/blog/fresh-bread");
		const html = await page.text();
		expect(html).toContain("<p>Out of the oven</p>");
		expect(html).not.toContain("webcraft-edit");
		expect(html).not.toContain("data-wc-");
		expect(editing.browser.cookies.has("__Host-webcraft.edit")).toBe(false);
	}

	test("as soon as the person signs out of the admin", async () => {
		const { site, member, editing } = await editingEditor();
		expect(
			(await editing.edit("save", { item: `entry:${site.entryId}`, field: "title", value: "Fresh bread" })).status,
		).toBe(200);

		await member.browser.api.session.signOut();

		await expectEnded(editing, site);
	});

	test("when that admin session is signed out from another browser", async () => {
		const { site, member, editing } = await editingEditor();
		const elsewhere = await install.signIn(member.account);

		await elsewhere.api.me.sessions.revokeOthers();

		await expectEnded(editing, site);
	});

	test("as soon as the person loses access to the Site", async () => {
		const { site, member, editing } = await editingEditor();
		const admin = await install.superadmin();

		await admin.api.members.remove({ workspaceId, personId: member.personId });

		await expectEnded(editing, site);
	});

	test("after 8 hours, however much it is used", async () => {
		const { site, member, editing } = await editingEditor();

		await install.clock.advance(8 * 60 * 60 * 1000 - 60_000);
		await member.browser.api.session.current();
		const page = await editing.page("/blog/fresh-bread");
		expect(await page.text()).toContain("webcraft-edit-token");

		await install.clock.advance(60_000);
		await member.browser.api.session.current();

		await expectEnded(editing, site);
	});

	test("when the person ends it from the editing bar", async () => {
		const { site, editing } = await editingEditor();

		const response = await editing.edit("end");

		expect(response.status).toBe(200);
		await expectEnded(editing, site);
	});
});
