// What every request of the building area (ADR 0037) must carry, held to what Edit mode's own security
// tests hold its requests to. The Drafts' sockets open only with the session's cookie, its header token
// (as a subprotocol) and from the Site's own pages. Another site's request reaches nothing: the edit
// requests and the API on the Site's address refuse anything the browser calls cross-site, and the
// shell is never served to another site's page, whatever cookies the browser sends along.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DRAFTS_PROTOCOL, EDIT_TOKEN_PROTOCOL_PREFIX } from "@webcraft/core";

import { type BuildingAreaBrowser, openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { upgradeDraftInEditMode } from "../harness/co-editing.ts";
import { EDIT_TOKEN_HEADER } from "../harness/edit-mode.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let entryId: string;
let otherEntryId: string;
const origin = "https://bakery.live.test";
const EDIT_COOKIE = "__Host-webcraft.edit";
const BUILD_COOKIE = "__Host-webcraft.build";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
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
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	entryId = entry.id;
	// Another Site of the same Workspace, which the same people edit.
	const otherSiteId = (await install.createSite(workspaceId, { name: "Acme Cafe", slug: "cafe" })).id;
	const other = await staff.api.postTypes.create({ siteId: otherSiteId, name: "Menus", urlPattern: "/menus/{slug}" });
	otherEntryId = (
		await staff.api.entries.create({ siteId: otherSiteId, postTypeId: other.postType.id, title: "Lunch" })
	).entry.id;
});

afterAll(async () => {
	await install.close();
});

/** Whether the Blog post's Draft still has its subtitle as published: nothing was written. */
async function expectUnchanged(): Promise<void> {
	const { entry } = await staff.api.entries.get({ siteId, entryId });
	expect(entry.draft.fields.subtitle).toBe("Out of the oven");
	expect(entry.draft.title).toBe("Fresh bread");
}

/** A browser's cookies as a `Cookie` header, without those named in `leaving`. */
function cookiesOf(browser: TestBrowser, leaving: readonly string[] = []): string {
	return Array.from(browser.cookies)
		.filter(([name]) => !leaving.includes(name))
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

describe("the Drafts' sockets, from the building area", () => {
	let area: BuildingAreaBrowser;
	const item = () => ({ kind: "entry", id: entryId }) as const;

	beforeAll(async () => {
		area = await openBuildingArea(install, editor, siteId, { open: "/page/blog/fresh-bread" });
	});

	/**
	 * A socket asked for as it is, through the handler: the cookies, origin, `Sec-Fetch-Site` and
	 * subprotocols given (the session's own unless said otherwise), to test what a browser never sends.
	 */
	async function upgrade(
		options: {
			leaving?: readonly string[];
			origin?: string | null;
			fetchSite?: string | null;
			token?: string | null;
		} = {},
	): Promise<Response | "opened"> {
		const headers = new Headers({
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": btoa("0123456789abcdef"),
		});
		const token = options.token === undefined ? await area.headerToken() : options.token;
		headers.set(
			"sec-websocket-protocol",
			[DRAFTS_PROTOCOL, ...(token === null ? [] : [`${EDIT_TOKEN_PROTOCOL_PREFIX}${token}`])].join(", "),
		);
		const cookie = cookiesOf(area.browser, options.leaving);
		if (cookie) headers.set("cookie", cookie);
		const from = options.origin === undefined ? origin : options.origin;
		if (from !== null) headers.set("origin", from);
		if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
		const answer = await install.upgrade(new Request(`${origin}/_webcraft/edit/drafts/entry/${entryId}`, { headers }));
		return answer instanceof Response ? answer : "opened";
	}

	const statusOf = (answer: Response | "opened") => (answer instanceof Response ? answer.status : answer);

	test("open with the session's cookie and header token, from the Site's own page", async () => {
		expect(await upgrade()).toBe("opened");
		expect(await upgrade({ fetchSite: "same-origin" })).toBe("opened");
		const accepted = await upgradeDraftInEditMode(area, item());
		expect(accepted instanceof Response).toBe(false);
	});

	test("refuse a browser without the session's cookie, even with the building-area cookie and the token", async () => {
		expect(area.browser.cookies.has(BUILD_COOKIE)).toBe(true);
		expect(statusOf(await upgrade({ leaving: [EDIT_COOKIE] }))).toBe(401);
		expect(statusOf(await upgrade({ leaving: [EDIT_COOKIE, BUILD_COOKIE] }))).toBe(401);
	});

	test("refuse a connection without the header token, or with one that isn't this session's", async () => {
		expect(statusOf(await upgrade({ token: null }))).toBe(403);
		expect(statusOf(await upgrade({ token: "0".repeat(64) }))).toBe(403);
		expect(statusOf(await upgrade({ token: "" }))).toBe(403);
		// Another building-area session's token isn't this one's.
		const another = await openBuildingArea(install, editor, siteId);
		expect(statusOf(await upgrade({ token: await another.headerToken() }))).toBe(403);
	});

	test("refuse a connection another site's page asks for", async () => {
		expect(statusOf(await upgrade({ origin: "https://attacker.example" }))).toBe(403);
		expect(statusOf(await upgrade({ origin: "https://attacker.example", fetchSite: "cross-site" }))).toBe(403);
		expect(statusOf(await upgrade({ origin: "https://cafe.live.test", fetchSite: "same-site" }))).toBe(403);
		expect(statusOf(await upgrade({ origin: null }))).toBe(403);
		// The browser says the page that asks is another site's, whatever its Origin claims.
		expect(statusOf(await upgrade({ fetchSite: "cross-site" }))).toBe(403);
		expect(statusOf(await upgrade({ fetchSite: "same-site" }))).toBe(403);
	});

	test("never open another Site's Draft from this Site's address", async () => {
		const answer = await upgradeDraftInEditMode(area, { kind: "entry", id: otherEntryId });
		expect(answer instanceof Response && answer.status).toBe(404);
	});
});

describe("a cross-site request", () => {
	let area: BuildingAreaBrowser;

	beforeAll(async () => {
		area = await openBuildingArea(install, editor, siteId, { open: "/page/blog/fresh-bread" });
	});

	/** An edit request with the session's cookies and token, from `from`, which the browser calls `fetchSite`. */
	async function editRequest(
		action: string,
		from: string,
		fetchSite: string,
		body: BodyInit = JSON.stringify({ item: `entry:${entryId}`, field: "subtitle", value: "From elsewhere" }),
		contentType: string | null = "application/json",
	): Promise<Response> {
		const headers = new Headers({
			cookie: cookiesOf(area.browser),
			origin: from,
			"sec-fetch-site": fetchSite,
			[EDIT_TOKEN_HEADER]: await area.headerToken(),
		});
		if (contentType) headers.set("content-type", contentType);
		return install.request(new Request(`${origin}/_webcraft/edit/api/${action}`, { method: "POST", headers, body }));
	}

	test("to an edit request is refused, though it carries the cookies and the token", async () => {
		for (const [from, fetchSite] of [
			["https://attacker.example", "cross-site"],
			// The browser's word wins over an Origin that claims to be the Site's.
			[origin, "cross-site"],
			[origin, "same-site"],
		] as const) {
			const response = await editRequest("save", from, fetchSite);
			expect({ from, fetchSite, status: response.status }).toEqual({ from, fetchSite, status: 403 });
			expect(await response.json()).toMatchObject({ code: "EDIT_REQUEST_REFUSED" });
		}
		await expectUnchanged();
		// The same request from the Site's own page goes through.
		const own = await editRequest("save", origin, "same-origin");
		expect(own.status).toBe(200);
		await editRequest(
			"save",
			origin,
			"same-origin",
			JSON.stringify({ item: `entry:${entryId}`, field: "subtitle", value: "Out of the oven" }),
		);
	});

	test("to the upload edit request is refused, and nothing reaches the Media library", async () => {
		const form = new FormData();
		form.set("file", upload(await photo({ width: 20, height: 20 }), "sneaky.jpg"));

		const response = await editRequest("media/upload", origin, "cross-site", form, null);

		expect(response.status).toBe(403);
		const { items } = await staff.api.media.list({ siteId, search: "sneaky" });
		expect(items).toEqual([]);
	});

	test("to the API on the Site's address is refused before any procedure runs", async () => {
		const { call } = buildingAreaApi(install, area);
		const { postTypeId } = (await staff.api.entries.get({ siteId, entryId })).entry;
		const count = async () => (await staff.api.entries.list({ siteId, postTypeId })).entries.length;
		const before = await count();

		for (const [from, fetchSite] of [
			["https://attacker.example", "cross-site"],
			[origin, "cross-site"],
		] as const) {
			const refused = await refusalOf(
				await call("entries.create", { siteId, postTypeId, title: "Planted" }, { origin: from, fetchSite }),
			);
			expect({ from, fetchSite, ...refused }).toMatchObject({
				from,
				fetchSite,
				status: 403,
				code: "EDIT_REQUEST_REFUSED",
			});
		}
		expect(await count()).toBe(before);
	});

	test("to the shell gets no shell: not to a script, a fetch or a frame of another site's page", async () => {
		for (const [fetchSite, mode, destination] of [
			["cross-site", "no-cors", "script"],
			["cross-site", "cors", "empty"],
			["cross-site", "navigate", "iframe"],
			["same-site", "no-cors", "empty"],
			["same-site", "navigate", "iframe"],
			["cross-site", null, null],
		] as const) {
			const headers = new Headers({ cookie: cookiesOf(area.browser), "sec-fetch-site": fetchSite });
			if (mode) headers.set("sec-fetch-mode", mode);
			if (destination) headers.set("sec-fetch-dest", destination);
			for (const address of ["/_webcraft/build/page/blog/fresh-bread", "/_webcraft/build/stand-in/site-template"]) {
				const response = await install.request(new Request(`${origin}${address}`, { headers }));
				const html = await response.text();
				expect({ address, fetchSite, mode, destination, status: response.status }).toEqual({
					address,
					fetchSite,
					mode,
					destination,
					status: 403,
				});
				expect(shellConfigIn(html)).toBeUndefined();
				expect(html).not.toContain(await area.headerToken());
			}
		}
	});

	test("to the shell that is the person's own navigation opens it: the way in arrives from the admin's address", async () => {
		// The admin's link is on another site, and the browser keeps calling every step of a redirect
		// "cross-site": the shell the link lands on is opened that way, by the person themselves.
		const headers = new Headers({
			cookie: cookiesOf(area.browser),
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
			"sec-fetch-dest": "document",
		});

		const response = await install.request(new Request(`${origin}/_webcraft/build/page/blog/fresh-bread`, { headers }));

		expect(response.status).toBe(200);
		// Never in another site's frame, never in the browser's cache.
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("cache-control")).toContain("no-store");
	});
});
