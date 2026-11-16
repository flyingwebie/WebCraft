// The way into the building area (ADR 0037): "Edit on site"'s link names the document to open and
// the admin path to go back to; every Edit mode link opens the building area. Following it sets the edit cookie and the
// building-area cookie on the Site's own address and lands on the shell. Both are checked when the
// link is made and again when it is followed, so a changed link can't lead anywhere else.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea } from "../harness/building-area.ts";
import { holdCookie, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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

/** A new Site with a published Blog post at /blog/fresh-bread. */
async function siteWithPost(): Promise<{ siteId: string; origin: string }> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, origin: `https://${slug}.sites.test` };
}

/** The `Set-Cookie` line that sets `name`, split into its value and lower-case attributes. */
function cookieOf(
	response: Response,
	name: string,
): { value: string; attributes: Record<string, string | true> } | undefined {
	const line = response.headers.getSetCookie().find((candidate) => candidate.startsWith(`${name}=`));
	if (!line) return undefined;
	const [pair = "", ...parts] = line.split(";").map((part) => part.trim());
	return {
		value: pair.slice(name.length + 1),
		attributes: Object.fromEntries(
			parts.map((part) => {
				const [key = "", ...value] = part.split("=");
				return [key.toLowerCase(), value.length > 0 ? value.join("=") : true];
			}),
		),
	};
}

const EDIT_COOKIE = "__Host-webcraft.edit";
const BUILD_COOKIE = "__Host-webcraft.build";

describe("a link that opens the building area", () => {
	test("says so, with the document it opens and the admin path to go back to", async () => {
		const { siteId, origin } = await siteWithPost();

		const { url } = await staff.api.editMode.open({
			siteId,
			open: "/page/blog/fresh-bread",
			returnTo: `/sites/${siteId}/entries`,
		});

		const link = new URL(url);
		expect(link.origin).toBe(origin);
		expect(link.pathname).toBe("/_webcraft/edit/enter");
		expect(link.searchParams.get("open")).toBe("/page/blog/fresh-bread");
		expect(link.searchParams.get("return")).toBe(`/sites/${siteId}/entries`);
		// The building area has no Code mode to start.
		expect(link.searchParams.has("code")).toBe(false);
	});

	test("opens the page at `path` when it names no document", async () => {
		const { siteId } = await siteWithPost();

		const { url } = await editor.api.editMode.open({ siteId, path: "/blog/fresh-bread" });

		expect(new URL(url).searchParams.get("open")).toBe("/page/blog/fresh-bread");
	});

	test("refuses a document or an admin path that isn't one", async () => {
		const { siteId } = await siteWithPost();
		const refused = async (input: { open?: string; returnTo?: string }) => {
			const error = await staff.api.editMode.open({ siteId, ...input }).catch((caught) => caught);
			expect(error).toMatchObject({ code: "BAD_REQUEST" });
		};

		await refused({ open: "page/blog" });
		await refused({ open: "/page//evil.example" });
		await refused({ open: "/elsewhere/blog" });
		await refused({ returnTo: "//evil.example/sites" });
		await refused({ returnTo: "https://evil.example/" });
		await refused({ returnTo: "/sites/x#fragment" });
		await refused({ returnTo: "/\\evil.example" });
	});

	test("following it sets the edit cookie and the building-area cookie, then lands on the shell", async () => {
		const { siteId, origin } = await siteWithPost();
		const { url } = await staff.api.editMode.open({
			siteId,
			open: "/page/blog/fresh-bread",
			returnTo: `/sites/${siteId}/entries?postType=1`,
		});

		const response = await install.browser({ origin }).request(url);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/_webcraft/build/page/blog/fresh-bread");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(cookieOf(response, EDIT_COOKIE)?.attributes).toMatchObject({
			httponly: true,
			secure: true,
			samesite: "Lax",
		});
		const build = cookieOf(response, BUILD_COOKIE);
		// The cookie holds where the logo tile goes back to, and lives as long as the edit cookie.
		expect(decodeURIComponent(build?.value ?? "")).toBe(`/sites/${siteId}/entries?postType=1`);
		expect(build?.attributes).toEqual({
			path: "/",
			"max-age": String(8 * 60 * 60),
			httponly: true,
			secure: true,
			samesite: "Lax",
		});
	});

	test("Members open it too, with `entry.edit`", async () => {
		const { siteId } = await siteWithPost();

		const building = await openBuildingArea(install, editor, siteId, { path: "/blog/fresh-bread" });

		expect(building.landed).toBe("/_webcraft/build/page/blog/fresh-bread");
		expect((await building.shell(building.landed)).status).toBe(200);
	});

	test("a link changed on the way opens the link's page and goes back to the Site in the admin", async () => {
		const { siteId, origin } = await siteWithPost();
		const { url } = await staff.api.editMode.open({ siteId, path: "/blog/fresh-bread" });
		const changed = new URL(url);
		changed.searchParams.set("open", "//evil.example/");
		changed.searchParams.set("return", "https://evil.example/");

		const response = await install.browser({ origin }).request(changed);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/_webcraft/build/page/blog/fresh-bread");
		expect(decodeURIComponent(cookieOf(response, BUILD_COOKIE)?.value ?? "")).toBe(`/sites/${siteId}`);
	});

	test("with Safe mode, starts Safe mode as well", async () => {
		const { siteId, origin } = await siteWithPost();
		const { url } = await staff.api.editMode.open({ siteId, safeMode: true });

		const response = await install.browser({ origin }).request(url);

		expect(cookieOf(response, "__Host-webcraft.safe")?.value).toBe("on");
		expect(cookieOf(response, BUILD_COOKIE)).toBeDefined();
	});

	test("a link asked for without a document opens the page at `path` in the building area, again and again", async () => {
		const { siteId } = await siteWithPost();
		const building = await openBuildingArea(install, staff, siteId);
		expect(building.browser.cookies.has(BUILD_COOKIE)).toBe(true);

		const { url } = await staff.api.editMode.open({ siteId, path: "/blog/fresh-bread" });
		const response = await building.browser.request(url);

		expect(response.headers.get("location")).toBe("/_webcraft/build/page/blog/fresh-bread");
		expect(cookieOf(response, BUILD_COOKIE)?.attributes["max-age"]).toBe(String(8 * 60 * 60));
		expect(building.browser.cookies.has(BUILD_COOKIE)).toBe(true);
	});

	test("there is no other way into Edit mode: every link sets the building-area cookie", async () => {
		const { siteId } = await siteWithPost();

		const editing = await openEditMode(install, editor, siteId, "/");

		expect(editing.browser.cookies.has(BUILD_COOKIE)).toBe(true);
		// Links of the old editors' ways in (`code`, `selection`) open the building area all the same.
		const { url } = await staff.api.editMode.open({ siteId, path: "/" });
		const old = new URL(url);
		old.searchParams.delete("open");
		old.searchParams.set("code", "1");
		const response = await install.browser({ origin: old.origin }).request(old);
		expect(response.headers.get("location")).toBe("/_webcraft/build/page/");
		expect(cookieOf(response, "__Host-webcraft.code")).toBeUndefined();
	});
});

describe("ending Edit mode", () => {
	test("clears the building-area cookie, and Code mode's and Safe mode's with the edit cookie", async () => {
		const { siteId } = await siteWithPost();
		const building = await openBuildingArea(install, staff, siteId, { safeMode: true });
		// Code mode's cookie, as a browser may still hold it from before the building area.
		holdCookie(building.browser, "__Host-webcraft.code", "on");

		const ended = await building.edit("end");

		expect(ended.status).toBe(200);
		for (const name of [EDIT_COOKIE, BUILD_COOKIE, "__Host-webcraft.code", "__Host-webcraft.safe"]) {
			expect(cookieOf(ended, name)?.attributes["max-age"]).toBe("0");
			expect(building.browser.cookies.has(name)).toBe(false);
		}
	});
});
