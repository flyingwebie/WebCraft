// Who may open a Site's Staging address (ADR 0014): the people reviewing it. Someone signed in to the
// admin who sees the Site (its Members reaching it, Staff, the Superadmin) opens it from the admin,
// which hands their browser a single-use link to the Staging address; it sets the Staging cookie
// there, tied to their admin session. Everyone else gets a page asking them to sign in, never the Site.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { openStaging, stagingVisitor } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with a published home page titled "Welcome" and a published Page at /about. */
async function newSite(): Promise<{ siteId: string; slug: string; origin: string }> {
	const slug = `review-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const home = await staff.api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Welcome" });
	await staff.api.entries.publish({ siteId, entryId: home.entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: home.entry.id });
	const about = await staff.api.entries.create({
		siteId,
		postTypeId: pages?.id as string,
		title: "About us",
		slug: "about",
	});
	await staff.api.entries.publish({ siteId, entryId: about.entry.id });
	return { siteId, slug, origin: `https://${slug}.sites.test` };
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

const STAGING_COOKIE = "__Host-webcraft.staging";

/** What the Staging address shows someone it doesn't know: a page asking them to sign in, never the Site. */
async function expectSignInPage(response: Response): Promise<string> {
	expect(response.status).toBe(403);
	expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(response.headers.get("x-robots-tag")).toBe("noindex");
	const html = await response.text();
	expect(html).toContain('<meta name="robots" content="noindex">');
	expect(html).not.toContain("Welcome");
	expect(html).not.toContain("About us");
	// Unbranded, like everything a Site's hostname answers: nothing it shows or links names what serves it.
	expect(html.replace(/ action="\/_webcraft\/staging\/password"/, "").toLowerCase()).not.toContain("webcraft");
	return html;
}

describe("someone the Staging address doesn't know", () => {
	test("gets a page asking them to sign in, with a link to the admin that opens the Staging address for them", async () => {
		const { siteId, slug } = await newSite();
		const visitor = stagingVisitor(install, slug);

		const response = await visitor.page("/about");
		expectSiteHeaders(response);
		const html = await expectSignInPage(response);

		expect(html).toContain("<h1>Sign in to see this site</h1>");
		const link = /<a href="([^"]+)"[^>]*>Sign in<\/a>/.exec(html)?.[1]?.replaceAll("&amp;", "&");
		expect(link).toBe(`https://admin.test/staging/${siteId}?path=%2Fabout`);
	});

	test("gets it for every path the Site answers: pages, the 404 page, files and the Install's own paths", async () => {
		const { slug } = await newSite();
		const visitor = stagingVisitor(install, slug);

		for (const path of ["/", "/no-such-page", "/_wc/css/0123456789abcdef.css", "/_media/x.jpg", "/_wc/lang/fr"]) {
			await expectSignInPage(await visitor.page(path));
		}
		// What isn't a page someone opens answers plainly.
		const post = await visitor.page("/_webcraft/forms/00000000-0000-4000-8000-000000000000", {
			method: "POST",
			body: "name=x",
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});
		expect(post.status).toBe(403);
		expect(await post.text()).toBe("Forbidden");
	});

	test("never sees it through a Staging cookie that isn't one", async () => {
		const { slug } = await newSite();
		const visitor = stagingVisitor(install, slug);

		const response = await install.request(`${visitor.origin}/about`, {
			headers: { cookie: `${STAGING_COOKIE}=not-a-session` },
		});
		await expectSignInPage(response);
		// The cookie that opens nothing is cleared.
		expect(cookieAttributes(response, STAGING_COOKIE)?.["max-age"]).toBe("0");
	});
});

describe("opening the Staging address from the admin", () => {
	test("gives a link to the Staging address; following it sets the Staging cookie there and opens the page", async () => {
		const { siteId, slug, origin } = await newSite();

		const { url, expiresAt } = await staff.api.staging.open({ siteId, path: "/about" });
		expect(new URL(url).origin).toBe(`https://${slug}.sites.test`);
		expect(new URL(url).pathname).toBe("/_webcraft/staging/enter");
		expect(new Date(expiresAt).getTime() - install.clock.now().getTime()).toBe(60_000);

		const browser = install.browser({ origin });
		const entered = await browser.request(url);
		expect(entered.status).toBe(303);
		expect(entered.headers.get("location")).toBe("/about");
		expect(entered.headers.get("cache-control")).toBe("no-store");
		expect(entered.headers.get("referrer-policy")).toBe("no-referrer");
		expect(cookieAttributes(entered, STAGING_COOKIE)).toEqual({
			path: "/",
			"max-age": String(8 * 60 * 60),
			httponly: true,
			secure: true,
			samesite: "Lax",
		});

		const page = await browser.request(`${origin}/about`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("About us");
	});

	test("works once, within 60 seconds, and only on the Site it was made for", async () => {
		const { siteId, origin } = await newSite();
		const other = await newSite();

		const { url } = await staff.api.staging.open({ siteId, path: "/" });
		const token = new URL(url).searchParams.get("token") ?? "";
		// On another Site's Staging address the link opens nothing (and isn't used up).
		const elsewhere = await install
			.browser({ origin: other.origin })
			.request(`${other.origin}/_webcraft/staging/enter?token=${token}`);
		expect(elsewhere.status).toBe(403);
		expect(elsewhere.headers.getSetCookie()).toEqual([]);

		const first = install.browser({ origin });
		expect((await first.request(url)).status).toBe(303);
		const again = await install.browser({ origin }).request(url);
		expect(again.status).toBe(403);

		const late = await staff.api.staging.open({ siteId, path: "/" });
		await install.clock.advance(61_000);
		expect((await install.browser({ origin }).request(late.url)).status).toBe(403);
	});

	test("lets in the Site's Members, Staff and the Superadmin; a Member not reaching the Site can't ask for a link", async () => {
		const { siteId } = await newSite();
		const other = await newSite();
		const author = (await install.createMember({ workspaceId, role: "author", sites: [siteId] })).browser;
		const elsewhere = (await install.createMember({ workspaceId, role: "owner", sites: [other.siteId] })).browser;
		const superadmin = await install.superadmin();

		for (const person of [author, staff, superadmin]) {
			const reviewer = await openStaging(install, person, siteId, "/about");
			expect((await reviewer.page("/about")).status).toBe(200);
		}
		await expect(elsewhere.api.staging.open({ siteId, path: "/" })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	});

	test("refuses a path that isn't one on the Site", async () => {
		const { siteId } = await newSite();
		for (const path of ["https://evil.example/", "//evil.example", "/a b", "about"]) {
			await expect(staff.api.staging.open({ siteId, path })).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
	});

	test("refuses on an Install without a sites domain: no Site has a Staging address", async () => {
		const bare = await createTestInstall({ sitesDomain: null });
		try {
			const admin = await bare.superadmin();
			const { id } = await bare.createWorkspace();
			const site = await bare.createSite(id);
			await expect(admin.api.staging.open({ siteId: site.id, path: "/" })).rejects.toMatchObject({
				code: "STAGING_UNAVAILABLE",
			});
		} finally {
			await bare.close();
		}
	});
});

describe("the Staging cookie", () => {
	test("ends with the admin session it came from: signing out of the admin closes the Staging address", async () => {
		const { siteId } = await newSite();
		const member = await install.createMember({ workspaceId, role: "editor", sites: [siteId] });
		const reviewer = await openStaging(install, member.browser, siteId);
		expect((await reviewer.page("/about")).status).toBe(200);

		await member.browser.api.session.signOut();

		const after = await reviewer.page("/about");
		await expectSignInPage(after);
		expect(cookieAttributes(after, STAGING_COOKIE)?.["max-age"]).toBe("0");
	});

	test("ends when the person no longer reaches the Site", async () => {
		const { siteId } = await newSite();
		const other = await newSite();
		const member = await install.createMember({ workspaceId, role: "editor", sites: [siteId] });
		const reviewer = await openStaging(install, member.browser, siteId);
		expect((await reviewer.page("/about")).status).toBe(200);

		const admin = await install.superadmin();
		await admin.api.members.changeAccess({
			workspaceId,
			personId: member.personId,
			role: "editor",
			sites: [other.siteId],
		});

		await expectSignInPage(await reviewer.page("/about"));
	});

	test("lasts 8 hours at most", async () => {
		const { siteId } = await newSite();
		const reviewer = await openStaging(install, staff, siteId);
		await install.clock.advance(8 * 60 * 60_000 - 60_000);
		expect((await reviewer.page("/about")).status).toBe(200);
		await install.clock.advance(60_000);
		await expectSignInPage(await reviewer.page("/about"));
	});

	test("opens only the Site it was set for", async () => {
		const { siteId } = await newSite();
		const other = await newSite();
		const reviewer = await openStaging(install, staff, siteId);
		const cookie = reviewer.browser.cookies.get(STAGING_COOKIE);

		const response = await install.request(`${other.origin}/about`, {
			headers: { cookie: `${STAGING_COOKIE}=${cookie}` },
		});
		await expectSignInPage(response);
	});
});

describe("Edit mode", () => {
	test("opens the Staging address too: its pages are Edit mode's while the edit cookie holds", async () => {
		const { siteId, origin } = await newSite();
		const { url } = await staff.api.editMode.open({ siteId, path: "/about" });
		expect(new URL(url).origin).toBe(origin);
		const browser = install.browser({ origin });
		expect((await browser.request(url)).status).toBe(303);

		const page = await browser.request(`${origin}/about`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<meta name="webcraft-edit-token"');
	});
});
