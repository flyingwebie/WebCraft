// The Management API on the Site's own address (ADR 0037): the building area's shell calls the
// procedures on a named list (`BUILDING_AREA_PROCEDURES`) at `/_webcraft/build/api/rpc/…` with its
// Edit mode session, as if that session were an API token pinned to the Site: only the listed
// procedures, only on the session's Site, as the person, recorded as Edit mode. Everything else is
// refused before it runs, and each call is checked as an edit request is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { BUILDING_AREA_PROCEDURES, type BuildingAreaProcedure } from "@webcraft/api";
import { can, EDITOR_LAYOUT_VERSION, type EditSessionActor, type PersonActor } from "@webcraft/core";

import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { type BuildingAreaApi, buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let staffId: string;
let editor: TestBrowser;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	otherWorkspaceId = (await install.createWorkspace("Zenith plc")).id;
	// Staff of both Workspaces: their own access reaches every Site below, so whatever is refused is
	// refused by the building area's limits, not by their Permissions.
	const created = await install.createStaff({ workspaces: [workspaceId, otherWorkspaceId] });
	staff = created.browser;
	staffId = created.personId;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = { siteId: string; postTypeId: string; entryId: string };

/** A live Site with a Blog Post Type, its Entry template and one published post. */
async function bakery(inWorkspace = workspaceId): Promise<Bakery> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(inWorkspace, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, postTypeId: postType.id, entryId: entry.id };
}

/** The building area open on a Site for the person whose admin browser this is, and its API. */
async function building(admin: TestBrowser, site: Bakery): Promise<BuildingAreaApi & { area: BuildingAreaBrowser }> {
	const area = await openBuildingArea(install, admin, site.siteId, { path: "/blog/fresh-bread" });
	return { area, ...buildingAreaApi(install, area) };
}

/** The titles of a Post Type's Entries, as the admin lists them. */
async function titles(site: Bakery): Promise<string[]> {
	const { entries } = await staff.api.entries.list({ siteId: site.siteId, postTypeId: site.postTypeId });
	return entries.map((entry) => entry.draft.title).sort();
}

describe("a listed procedure", () => {
	let site: Bakery;
	let area: BuildingAreaApi;

	beforeAll(async () => {
		site = await bakery();
		area = await building(staff, site);
	});

	test("answers as the person, on the session's Site", async () => {
		const { entry } = await area.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Sourdough",
		});

		expect(entry.draft.title).toBe("Sourdough");
		expect(await titles(site)).toEqual(["Fresh bread", "Sourdough"]);
		const { markup } = await area.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(markup?.draft).toContain("{{ subtitle }}");
		// A procedure that also opens the Site's Workspace, to see it, still can.
		expect((await area.api.media.overview({ siteId: site.siteId })).maxFileBytes).toBeGreaterThan(0);
	});

	test("answers with no-store, as the admin's API does", async () => {
		const response = await area.call("postTypes.list", { siteId: site.siteId });

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("takes an upload as the admin's does", async () => {
		const { media } = await area.api.media.upload({
			siteId: site.siteId,
			file: upload(await photo({ width: 20, height: 10 }), "loaf.jpg"),
		});

		expect(media.fileName).toBe("loaf.jpg");
		const { items } = await staff.api.media.list({ siteId: site.siteId });
		expect(items.map((item) => item.id)).toContain(media.id);
	});

	test("is recorded in the Audit log as Edit mode, by the person", async () => {
		const saved = await area.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<main>{{@outlet}}</main>",
		});
		await area.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
		const published = entries.filter((entry) => entry.siteId === site.siteId && entry.action === "template.publish");
		expect(published.at(0)).toMatchObject({ personId: staffId, via: { kind: "editMode" } });
	});

	test("reads and saves the person's own editor preferences", async () => {
		const saved = await area.api.me.saveEditorPreferences({
			siteId: site.siteId,
			preferences: { version: EDITOR_LAYOUT_VERSION, formatOnLeave: true },
		});

		expect(saved.preferences.formatOnLeave).toBe(true);
		expect((await area.api.me.editorPreferences({ siteId: site.siteId })).preferences.formatOnLeave).toBe(true);
		// The same preferences as in the admin: they are the person's, on every Site.
		expect((await staff.api.me.editorPreferences({ siteId: site.siteId })).preferences.formatOnLeave).toBe(true);
	});

	test("an item of another Site, named on this Site, is not found there", async () => {
		const other = await bakery();

		const read = area.api.entries.get({ siteId: site.siteId, entryId: other.entryId });

		expect(read).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
		await read.catch(() => {});
	});
});

describe("the session's Site", () => {
	let site: Bakery;
	let sameWorkspace: Bakery;
	let otherWorkspace: Bakery;
	let area: BuildingAreaApi;

	beforeAll(async () => {
		site = await bakery();
		sameWorkspace = await bakery();
		otherWorkspace = await bakery(otherWorkspaceId);
		area = await building(staff, site);
	});

	test("every listed procedure refuses a call that names another Site, or none, before it runs", async () => {
		for (const path of BUILDING_AREA_PROCEDURES) {
			for (const input of [
				{ siteId: sameWorkspace.siteId },
				{ siteId: otherWorkspace.siteId },
				{ siteId: "not-a-site" },
				{},
				null,
			]) {
				const refusal = await refusalOf(await area.call(path, input));
				expect({ path, input, refusal }).toMatchObject({
					path,
					input,
					refusal: { status: 404, code: "SITE_NOT_FOUND" },
				});
			}
		}
	});

	test("a change to another Site never happens, though the person may make it in the admin", async () => {
		const response = await area.call("entries.create", {
			siteId: sameWorkspace.siteId,
			postTypeId: sameWorkspace.postTypeId,
			title: "Hijacked",
		});

		expect(await refusalOf(response)).toMatchObject({ status: 404, code: "SITE_NOT_FOUND" });
		expect(await titles(sameWorkspace)).toEqual(["Fresh bread"]);
	});
});

describe("anything not on the list", () => {
	let site: Bakery;
	let area: BuildingAreaApi;

	beforeAll(async () => {
		site = await bakery();
		area = await building(staff, site);
	});

	test("is not there, and never runs", async () => {
		const unlisted: [string, unknown][] = [
			// Site procedures left off the list.
			["postTypes.create", { siteId: site.siteId, name: "Recipes", urlPattern: "/recipes/{slug}" }],
			["entries.delete", { siteId: site.siteId, entryId: site.entryId }],
			["entries.saveDraft", { siteId: site.siteId, entryId: site.entryId, title: "Changed" }],
			["media.suggestAltText", { siteId: site.siteId, mediaId: crypto.randomUUID() }],
			["domains.list", { siteId: site.siteId }],
			["sites.get", { siteId: site.siteId }],
			["builder.transferHistory", { siteId: site.siteId, payload: "x" }],
			// Workspace, Install and account procedures.
			["workspaces.list", {}],
			["members.list", { workspaceId }],
			["install.settings", {}],
			["audit.list", {}],
			["me.sessions.list", {}],
			["session.signOut", {}],
			["editMode.open", { siteId: site.siteId, building: true }],
			["shell.context", {}],
			// No procedure at all, and a Module's.
			["entries.nothing", { siteId: site.siteId }],
			["m.redirects.rules.list", { siteId: site.siteId }],
		];
		for (const [path, input] of unlisted) {
			const refusal = await refusalOf(await area.call(path, input));
			expect({ path, refusal }).toMatchObject({ path, refusal: { status: 404, code: "NOT_FOUND" } });
		}

		const { postTypes } = await staff.api.postTypes.list({ siteId: site.siteId });
		expect(postTypes.map((postType) => postType.name)).not.toContain("Recipes");
		expect(await titles(site)).toEqual(["Fresh bread"]);
		const { entry } = await staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("Fresh bread");
	});

	test("a Sensitive action is refused as it is to an API token, and never runs", async () => {
		const sensitive: [string, unknown, string][] = [
			["apiTokens.create", { workspaceId, name: "Leak", sites: "all", readOnly: false }, "apiToken.create"],
			["members.invite", { workspaceId, email: "intruder@example.com", role: "owner", sites: "all" }, "member.invite"],
			["contentApi.keys.create", { siteId: site.siteId, name: "Leak", origins: [] }, "contentApi.open"],
			["siteExports.start", { siteId: site.siteId }, "site.export"],
		];
		for (const [path, input, action] of sensitive) {
			const refusal = await refusalOf(await area.call(path, input));
			expect({ path, refusal }).toMatchObject({
				path,
				refusal: { status: 403, code: "SENSITIVE_ACTION_REFUSED", data: { action } },
			});
		}

		expect((await staff.api.apiTokens.list()).tokens).toEqual([]);
		expect((await staff.api.contentApi.get({ siteId: site.siteId })).keys).toEqual([]);
	});
});

describe("what every call must carry, as an edit request does", () => {
	let site: Bakery;
	let building_: BuildingAreaApi & { area: BuildingAreaBrowser };
	const create = () => ({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Refused" });

	beforeAll(async () => {
		site = await bakery();
		building_ = await building(staff, site);
	});

	async function expectRefused(response: Response, status: number, code: string): Promise<void> {
		expect(await refusalOf(response)).toMatchObject({ status, code });
		expect(await titles(site)).toEqual(["Fresh bread"]);
	}

	test("the session's header token", async () => {
		const { call } = building_;
		await expectRefused(await call("entries.create", create(), { headerToken: null }), 403, "EDIT_REQUEST_REFUSED");
		await expectRefused(
			await call("entries.create", create(), { headerToken: "A".repeat(43) }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		// Another session's token isn't this one's.
		const other = await openBuildingArea(install, staff, site.siteId, { path: "/blog/fresh-bread" });
		await expectRefused(
			await call("entries.create", create(), { headerToken: await other.headerToken() }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
	});

	test("the Site's own origin", async () => {
		const { call, area } = building_;
		await expectRefused(
			await call("entries.create", create(), { origin: "https://elsewhere.example", fetchSite: "cross-site" }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		await expectRefused(
			await call("entries.create", create(), { origin: area.origin, fetchSite: "same-site" }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		await expectRefused(await call("entries.create", create(), { origin: null }), 403, "EDIT_REQUEST_REFUSED");
	});

	test("a POST", async () => {
		const response = await building_.call("postTypes.list", { siteId: site.siteId }, { method: "GET" });

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	test("the edit cookie", async () => {
		await expectRefused(
			await building_.call("entries.create", create(), { withoutCookies: ["__Host-webcraft.edit"] }),
			401,
			"EDIT_MODE_ENDED",
		);
	});

	test("the building area's cookie: a browser in Edit mode alone reaches none of it", async () => {
		await expectRefused(
			await building_.call("entries.create", create(), { withoutCookies: ["__Host-webcraft.build"] }),
			403,
			"EDIT_REQUEST_REFUSED",
		);
		const editing = await openEditMode(install, staff, site.siteId, "/blog/fresh-bread");
		const response = await install.request(
			new Request(`${editing.origin}/_webcraft/build/api/rpc/entries/create`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-webcraft-edit-token": await editing.headerToken(),
					cookie: Array.from(editing.browser.cookies, ([name, value]) => `${name}=${value}`).join("; "),
					origin: editing.origin,
					"sec-fetch-site": "same-origin",
				},
				body: JSON.stringify({ json: create() }),
			}),
		);
		await expectRefused(response, 403, "EDIT_REQUEST_REFUSED");
	});

	test("a session that still holds: once the person signs out of the admin, nothing more", async () => {
		const member = await install.createStaff({ workspaces: [workspaceId] });
		const area = await building(member.browser, site);
		expect((await area.call("postTypes.list", { siteId: site.siteId })).status).toBe(200);

		await member.browser.api.session.signOut();

		const response = await area.call("entries.create", create());
		const cleared = response.headers.getSetCookie().some((line) => line.startsWith("__Host-webcraft.edit=;"));
		await expectRefused(response, 401, "EDIT_MODE_ENDED");
		expect(cleared).toBe(true);
	});

	test("an upload within the Install's largest file; any other body within the API's limit", async () => {
		const { api: admin } = await install.superadmin();
		await admin.install.media.update({ maxFileBytes: 1024 * 1024 });
		try {
			const big = new Uint8Array(1024 * 1024 + 70 * 1024);
			big.set(await photo({ width: 10, height: 10 }));
			const tooLarge = building_.api.media.upload({ siteId: site.siteId, file: upload(big, "huge.jpg") });
			expect(tooLarge).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE", data: { maxBytes: 1024 * 1024 } });
			await tooLarge.catch(() => {});
		} finally {
			await admin.install.media.update({ maxFileBytes: 100 * 1024 * 1024 });
		}
		const malformed = await building_.call("entries.create", undefined, { body: "{not json" });
		expect(malformed.status).toBe(400);
		expect(await titles(site)).toEqual(["Fresh bread"]);
	});
});

describe("Permissions, as in the admin", () => {
	let site: Bakery;
	let area: BuildingAreaApi;

	beforeAll(async () => {
		site = await bakery();
		area = await building(editor, site);
	});

	test("a Member changes Content, but a procedure that needs structure.edit is FORBIDDEN", async () => {
		const { entry } = await area.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Rye",
		});
		expect(entry.draft.title).toBe("Rye");
		const { preferences } = await area.api.me.saveEditorPreferences({
			siteId: site.siteId,
			preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
		});
		expect(preferences.hintSeen).toBe(true);

		for (const call of [
			() => area.api.templates.getSiteTemplateMarkup({ siteId: site.siteId }),
			() => area.api.templates.saveSiteTemplateMarkup({ siteId: site.siteId, markup: "<main></main>" }),
			() => area.api.designSystem.get({ siteId: site.siteId }),
			() => area.api.components.list({ siteId: site.siteId }),
		]) {
			const refused = await call().then(
				() => null,
				(error: unknown) => error,
			);
			expect(refused).toBeInstanceOf(ORPCError);
			expect(refused).toMatchObject({ code: "FORBIDDEN", data: { permission: "structure.edit" } });
		}
	});
});

describe("the session's actor", () => {
	// Behind the check on `siteId`, the person acts through an actor that reaches the session's Site
	// and nothing else, whatever the person themself may do.
	const superadmin: PersonActor = {
		kind: "person",
		personId: crypto.randomUUID(),
		installRole: { role: "superadmin", workspaces: "all" },
		memberships: [],
	};
	const pinned: EditSessionActor = {
		kind: "editSession",
		sessionId: crypto.randomUUID(),
		person: superadmin,
		workspaceId: "w1",
		siteId: "s1",
	};

	test("reaches its Site with the person's Permissions there", () => {
		expect(can(pinned, "structure.edit", { level: "site", workspaceId: "w1", siteId: "s1" })).toBe(true);
		expect(can(pinned, "workspace.view", { level: "workspace", workspaceId: "w1" })).toBe(true);
	});

	test("reaches no other Site, nothing else of its Workspace, no other Workspace and not the Install", () => {
		expect(can(pinned, "site.view", { level: "site", workspaceId: "w1", siteId: "s2" })).toBe(false);
		expect(can(pinned, "site.view", { level: "site", workspaceId: "w2", siteId: "s1" })).toBe(false);
		expect(can(pinned, "member.invite", { level: "workspace", workspaceId: "w1" })).toBe(false);
		expect(can(pinned, "workspace.view", { level: "workspace", workspaceId: "w2" })).toBe(false);
		expect(can(pinned, "install.manage", { level: "install" })).toBe(false);
	});

	test("never holds more than the person", () => {
		const author: PersonActor = {
			kind: "person",
			personId: crypto.randomUUID(),
			installRole: null,
			memberships: [{ workspaceId: "w1", role: "author", sites: ["s1"] }],
		};
		const session = { ...pinned, person: author };
		expect(can(session, "entry.edit", { level: "site", workspaceId: "w1", siteId: "s1" })).toBe(true);
		expect(can(session, "structure.edit", { level: "site", workspaceId: "w1", siteId: "s1" })).toBe(false);
		expect(can(session, "entry.publish", { level: "site", workspaceId: "w1", siteId: "s1" })).toBe(false);
	});
});

describe("the list", () => {
	test("names only procedures of the Management API", () => {
		// @ts-expect-error: a path that isn't a procedure fails the typecheck.
		const notOne: BuildingAreaProcedure = "entries.nothing";
		expect(BUILDING_AREA_PROCEDURES).not.toContain(notOne);
		expect(BUILDING_AREA_PROCEDURES).toContain("templates.publish");
	});
});
