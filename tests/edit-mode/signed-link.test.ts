// Edit mode starts with "Edit on site" in the admin: a single-use signed link, valid 60 seconds, for
// one person and one Site. Following it on the Site's own domain sets the edit cookie there
// (`HttpOnly`, `Secure`, `SameSite=Lax`, at most 8 hours) and opens the page (ADR 0022).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

/** The attributes of the `Set-Cookie` line that sets `name`, by lower-case name (`true` for a flag). */
function cookieAttributes(response: Response, name: string): Record<string, string | true> | undefined {
	const line = response.headers.getSetCookie().find((candidate) => candidate.startsWith(`${name}=`));
	if (!line) return undefined;
	const [, ...parts] = line.split(";").map((part) => part.trim());
	return Object.fromEntries(
		parts.map((part) => {
			const [key = "", ...value] = part.split("=");
			return [key.toLowerCase(), value.length > 0 ? value.join("=") : true];
		}),
	);
}

const EDIT_COOKIE = "__Host-webcraft-edit";

describe("Edit on site", () => {
	test("gives a link on the Site's own address; following it sets the edit cookie there and opens the page", async () => {
		const { siteId, origin } = await siteWithPost();

		const { url, expiresAt } = await editor.api.editMode.open({ siteId, path: "/blog/fresh-bread" });

		expect(new URL(url).origin).toBe(origin);
		expect(new URL(url).pathname.startsWith("/_webcraft/edit/")).toBe(true);
		expect(expiresAt).toEqual(new Date(install.clock.now().getTime() + 60_000));

		const visitor = install.browser({ origin });
		const response = await visitor.request(url);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/blog/fresh-bread");
		// The link's token never reaches another site through the Referer, nor any cache.
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(cookieAttributes(response, EDIT_COOKIE)).toEqual({
			path: "/",
			"max-age": String(8 * 60 * 60),
			httponly: true,
			secure: true,
			samesite: "Lax",
		});
	});

	test("a link works once", async () => {
		const { siteId, origin } = await siteWithPost();
		const { url } = await editor.api.editMode.open({ siteId, path: "/" });

		expect((await install.browser({ origin }).request(url)).status).toBe(303);

		const again = await install.browser({ origin }).request(url);
		expect(again.status).toBe(403);
		expect(again.headers.getSetCookie()).toEqual([]);
		expect(await again.text()).toContain("expired or was used already");
	});

	test("a link works for 60 seconds", async () => {
		const { siteId, origin } = await siteWithPost();
		const { url } = await editor.api.editMode.open({ siteId, path: "/" });

		await install.clock.advance(60_000);

		const late = await install.browser({ origin }).request(url);
		expect(late.status).toBe(403);
		expect(late.headers.getSetCookie()).toEqual([]);
	});

	test("a link works only on the Site it was made for", async () => {
		const ours = await siteWithPost();
		const other = await siteWithPost();
		const { url } = await editor.api.editMode.open({ siteId: ours.siteId, path: "/" });

		const elsewhere = new URL(url);
		elsewhere.host = new URL(other.origin).host;
		const response = await install.browser({ origin: other.origin }).request(elsewhere.toString());

		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
		// Trying it elsewhere doesn't use it up.
		expect((await install.browser({ origin: ours.origin }).request(url)).status).toBe(303);
	});

	test("a made-up link opens nothing", async () => {
		const { origin } = await siteWithPost();

		for (const path of ["/_webcraft/edit/enter", "/_webcraft/edit/enter?token=made-up"]) {
			const response = await install.browser({ origin }).request(`${origin}${path}`);
			expect(response.status).toBe(403);
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	});

	test("a link made in an admin session that has since signed out opens nothing", async () => {
		const { siteId, origin } = await siteWithPost();
		const { account } = await install.createMember({ workspaceId, role: "author" });
		const author = await install.signIn(account);
		const { url } = await author.api.editMode.open({ siteId, path: "/" });

		await author.api.session.signOut();

		expect((await install.browser({ origin }).request(url)).status).toBe(403);
	});

	test("a link opens a path on the Site, never another address", async () => {
		const { siteId } = await siteWithPost();

		for (const path of [
			"https://elsewhere.example/",
			"//elsewhere.example/",
			"/\\elsewhere.example",
			"about",
			"/a?b=c",
		]) {
			expect(await editor.api.editMode.open({ siteId, path }).catch((error) => error.code)).toBe("EDIT_PATH_INVALID");
		}
	});
});

describe("who may open Edit mode", () => {
	test("only people who edit the Site's Content: others can't see the Site at all", async () => {
		const { siteId } = await siteWithPost();
		const elsewhere = await install.createWorkspace("Someone else");
		const outsider = (await install.createMember({ workspaceId: elsewhere.id, role: "owner" })).browser;

		expect(await outsider.api.editMode.open({ siteId, path: "/" }).catch((error) => error.code)).toBe("SITE_NOT_FOUND");
		expect(
			await install
				.browser()
				.api.editMode.open({ siteId, path: "/" })
				.catch((error) => error.code),
		).toBe("UNAUTHORIZED");
	});

	test("a person who lost access between making the link and following it is turned away", async () => {
		const { siteId, origin } = await siteWithPost();
		const { personId, browser } = await install.createMember({ workspaceId, role: "editor" });
		const { url } = await browser.api.editMode.open({ siteId, path: "/" });

		const admin = await install.superadmin();
		await admin.api.members.remove({ workspaceId, personId });

		expect((await install.browser({ origin }).request(url)).status).toBe(403);
	});

	test("a Site without an address of its own can't be opened in Edit mode", async () => {
		const bare = await createTestInstall({ sitesDomain: null });
		try {
			const workspace = await bare.createWorkspace();
			const site = await bare.createSite(workspace.id);
			const admin = await bare.superadmin();

			expect(await admin.api.editMode.open({ siteId: site.id, path: "/" }).catch((error) => error.code)).toBe(
				"EDIT_MODE_UNAVAILABLE",
			);
		} finally {
			await bare.close();
		}
	});
});
