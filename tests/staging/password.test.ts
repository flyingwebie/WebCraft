// A Site's staging password (ADR 0014): Owners and Staff set one so client stakeholders without an
// account can see the Staging address. Only its hash is kept; changing it is a Sensitive action and
// logged; trying passwords is limited per client address; the cookie it sets lasts a week, or until
// the password changes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { givePassword, stagingVisitor } from "../harness/staging.ts";

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

/** A new Site with a published Page at /about. */
async function newSite(): Promise<{ siteId: string; slug: string }> {
	const slug = `password-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const about = await staff.api.entries.create({
		siteId,
		postTypeId: pages?.id as string,
		title: "About us",
		slug: "about",
	});
	await staff.api.entries.publish({ siteId, entryId: about.entry.id });
	return { siteId, slug };
}

const PASSWORD_COOKIE = "__Host-webcraft.staging-password";

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

describe("setting the staging password", () => {
	test("Owners and Staff set it; only whether there is one is ever shown, and it is logged without the password", async () => {
		const { siteId } = await newSite();
		const owner = (await install.createMember({ workspaceId, role: "owner", sites: [siteId] })).browser;

		expect((await staff.api.staging.get({ siteId })).password).toEqual({ set: false, changedAt: null });
		const set = await owner.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		expect(set).toEqual({
			url: expect.stringMatching(/^https:\/\/password-\d+\.sites\.test$/),
			password: { set: true, changedAt: install.clock.now() },
		});
		expect(JSON.stringify(await staff.api.staging.get({ siteId }))).not.toContain("crusty sourdough");
		// Only its hash is kept.
		expect(await install.tablesHolding("crusty sourdough")).toEqual([]);

		await staff.api.staging.setPassword({ siteId, password: null });
		expect((await staff.api.staging.get({ siteId })).password.set).toBe(false);

		const { entries } = await (await install.superadmin()).api.audit.list({});
		const changes = entries.filter((entry) => entry.action === "stagingPassword.change" && entry.siteId === siteId);
		expect(changes.map((entry) => entry.details)).toEqual([{ set: false }, { set: true }]);
		expect(JSON.stringify(changes)).not.toContain("crusty sourdough");
	});

	test("Editors and Authors can't set it; everyone who sees the Site sees whether there is one", async () => {
		const { siteId } = await newSite();
		const editor = (await install.createMember({ workspaceId, role: "editor", sites: [siteId] })).browser;
		await expect(editor.api.staging.setPassword({ siteId, password: "crusty sourdough" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect((await editor.api.staging.get({ siteId })).password.set).toBe(false);
	});

	test("refuses one shorter than 8 characters, longer than 200, or only spaces", async () => {
		const { siteId } = await newSite();
		for (const password of ["short", " ".repeat(12), "x".repeat(201)]) {
			await expect(staff.api.staging.setPassword({ siteId, password })).rejects.toMatchObject({
				code: "STAGING_PASSWORD_INVALID",
			});
		}
	});
});

describe("giving the staging password on the Staging address", () => {
	test("the page offers its form only while the Site has a password", async () => {
		const { siteId, slug } = await newSite();
		const visitor = stagingVisitor(install, slug);
		expect(await (await visitor.page("/about")).text()).not.toContain("<form");

		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const html = await (await visitor.page("/about")).text();
		expect(html).toContain('<form method="post" action="/_webcraft/staging/password" novalidate>');
		expect(html).toContain('<label for="password">Password</label>');
		expect(html).toContain('<input type="hidden" name="path" value="/about">');
	});

	test("a wrong one shows the page again, saying so, and lets nothing in", async () => {
		const { siteId, slug } = await newSite();
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const visitor = stagingVisitor(install, slug);

		const answer = await givePassword(visitor, "soft white loaf", "/about");
		expect(answer.status).toBe(403);
		expect(answer.headers.getSetCookie()).toEqual([]);
		const html = await answer.text();
		expect(html).toContain("<title>Error: Sign in to see this site · Acme Bakery</title>");
		expect(html).toContain(`role="alert">That password isn't right. Check it and try again.</p>`);
		expect(html).toContain('aria-invalid="true" autofocus');
		expect((await visitor.page("/about")).status).toBe(403);
	});

	test("changing or removing the password shuts out every browser it let in", async () => {
		const { siteId, slug } = await newSite();
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const visitor = stagingVisitor(install, slug);
		await givePassword(visitor, "crusty sourdough");
		expect((await visitor.page("/about")).status).toBe(200);

		await staff.api.staging.setPassword({ siteId, password: "seeded rye loaf" });
		const shut = await visitor.page("/about");
		expect(shut.status).toBe(403);
		expect(cookieAttributes(shut, PASSWORD_COOKIE)?.["max-age"]).toBe("0");

		await givePassword(visitor, "seeded rye loaf");
		expect((await visitor.page("/about")).status).toBe(200);
		await staff.api.staging.setPassword({ siteId, password: null });
		expect((await visitor.page("/about")).status).toBe(403);
	});

	test("one Site's password cookie opens no other Site", async () => {
		const first = await newSite();
		const second = await newSite();
		await staff.api.staging.setPassword({ siteId: first.siteId, password: "crusty sourdough" });
		await staff.api.staging.setPassword({ siteId: second.siteId, password: "crusty sourdough" });
		const visitor = stagingVisitor(install, first.slug);
		await givePassword(visitor, "crusty sourdough");
		const cookie = visitor.browser.cookies.get(PASSWORD_COOKIE);

		const elsewhere = await install.request(`https://${second.slug}.sites.test/about`, {
			headers: { cookie: `${PASSWORD_COOKIE}=${cookie}` },
		});
		expect(elsewhere.status).toBe(403);
	});

	test("one client address may try 10 passwords a minute on a Site; then it is asked to wait", async () => {
		const { siteId, slug } = await newSite();
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const visitor = stagingVisitor(install, slug);

		for (let attempt = 0; attempt < 10; attempt++) {
			expect((await givePassword(visitor, `wrong guess ${attempt}`)).status).toBe(403);
		}
		const refused = await givePassword(visitor, "crusty sourdough");
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("60");
		expect(await refused.text()).toContain("Too many tries from your network.");
		expect(refused.headers.getSetCookie()).toEqual([]);

		// Another address isn't held back, and the minute passes.
		const other = stagingVisitor(install, slug);
		expect((await givePassword(other, "crusty sourdough")).status).toBe(303);
		await install.clock.advance(60_000);
		expect((await givePassword(visitor, "crusty sourdough")).status).toBe(303);
	});

	test("takes the password only from the Staging address's own page", async () => {
		const { siteId, slug } = await newSite();
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const answer = await install.request(`https://${slug}.sites.test/_webcraft/staging/password`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://evil.example",
				"sec-fetch-site": "cross-site",
			},
			body: "password=crusty+sourdough&path=%2F",
		});
		expect(answer.status).toBe(403);
		expect(answer.headers.getSetCookie()).toEqual([]);
	});

	test("goes on only to a path on the Site", async () => {
		const { siteId, slug } = await newSite();
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		for (const path of ["https://evil.example/", "//evil.example/x", "about"]) {
			const answer = await givePassword(stagingVisitor(install, slug), "crusty sourdough", path);
			expect(answer.headers.get("location")).toBe("/");
		}
	});
	// Last: it moves the clock a week, past every admin session of this file.
	test("the right one lets the browser in for a week: a cookie only this hostname gets", async () => {
		const { siteId, slug } = await newSite();
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const visitor = stagingVisitor(install, slug);

		const answer = await givePassword(visitor, "crusty sourdough", "/about");
		expect(answer.status).toBe(303);
		expect(answer.headers.get("location")).toBe("/about");
		expect(answer.headers.get("cache-control")).toBe("no-store");
		expect(cookieAttributes(answer, PASSWORD_COOKIE)).toEqual({
			path: "/",
			"max-age": String(7 * 24 * 60 * 60),
			httponly: true,
			secure: true,
			samesite: "Lax",
		});

		const page = await visitor.page("/about");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("About us");

		await install.clock.advance(7 * 24 * 60 * 60_000 - 60_000);
		expect((await visitor.page("/about")).status).toBe(200);
		await install.clock.advance(60_000);
		expect((await visitor.page("/about")).status).toBe(403);
	});
});
