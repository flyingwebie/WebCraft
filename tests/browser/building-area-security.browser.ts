// The building area's session ending in a real browser (ADR 0037; BA-31), in Chromium. The way in from
// the admin arrives on the Site's address as a navigation the browser calls cross-site (the admin is
// another site), and opens the shell. A session then ends when the person loses access to the Site,
// after 8 hours, and when two-factor authentication becomes required for them: the next thing typed in
// the page is not saved, the shell says Edit mode has ended (assertively) and that it could not save,
// nothing reaches the Draft however much more is typed, and reloading gives the page that sends the
// person back to the admin. The server tests (`tests/building-area/security-*.test.ts`) check every
// request's refusal; this checks what the person sees.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import type { Frame, Page } from "playwright";

import { TEST_PASSWORD, type TestAccount, type TestBrowser } from "../harness/index.ts";
import { addAuthenticator, confirmIfAsked } from "../harness/two-factor.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let workspaceId: string;
let siteId: string;
let entryId: string;
const slug = "bakery";
const ENDED = "Edit mode has ended. Open it again from the admin.";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	entryId = entry.id;
});

afterAll(async () => {
	await install?.close();
});

/** The Blog post's subtitle in its Draft, as the admin reads it. */
async function subtitle(): Promise<unknown> {
	const { api } = await install.install.superadmin();
	return (await api.entries.get({ siteId, entryId })).entry.draft.fields.subtitle;
}

/** What `read` gives once `done` accepts it, waiting up to 6 seconds (a save waits for typing to pause). */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 6000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(150);
		value = await read();
	}
	return value;
}

/** Types at the end of the subtitle, with the pointer and the keyboard, as a person does. */
async function typeInSubtitle(page: Page, frame: Frame, text: string): Promise<void> {
	const region = frame.locator('p[data-wc-field="subtitle"]');
	await region.scrollIntoViewIfNeeded();
	await settled(page);
	const box = await region.boundingBox();
	if (!box) throw new Error("The subtitle isn't shown.");
	await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
	await page.keyboard.press("End");
	await page.keyboard.type(text);
}

/** Someone in the building area on the Blog post, and the subtitle their first change saved. */
type Editing = { page: Page; frame: Frame; saved: string };

/** A new page in the building area as `person`, on the Blog post, once a first change has saved. */
async function editing(person: TestAccount): Promise<Editing> {
	const page = await install.newPage("light");
	await page.setViewportSize({ width: 1440, height: 900 });
	const frame = await enterBuildingArea(install, page, { as: person, siteId, slug, open: "/page/blog/fresh-bread" });
	await frame.locator('p[data-wc-field="subtitle"][contenteditable]').waitFor();
	const saved = `${await subtitle()} today`;
	await typeInSubtitle(page, frame, " today");
	expect(await eventually(subtitle, (value) => value === saved)).toBe(saved);
	await page.locator('[data-wc-draft-state]:not([data-wc-draft-state="saving"])').waitFor();
	return { page, frame, saved };
}

/**
 * The session has ended: what is typed next is refused, the shell says Edit mode has ended and that
 * it could not save, the Draft keeps what was saved before, and reloading the shell sends the person
 * back to the admin.
 */
async function expectEndedInShell({ page, frame, saved }: Editing): Promise<void> {
	await typeInSubtitle(page, frame, " and tomorrow");
	await page.locator("[data-wc-messages]").filter({ hasText: ENDED }).waitFor({ timeout: 6000 });
	await page.locator('[data-wc-draft-state="failed"]').filter({ hasText: "Could not save" }).waitFor();
	// More typing, and leaving the region, write nothing either.
	await typeInSubtitle(page, frame, " and after");
	await page.keyboard.press("Tab");
	await Bun.sleep(1500);
	expect(await subtitle()).toBe(saved);

	await page.reload();
	await page.getByRole("heading", { name: "Open the building area from the admin" }).waitFor();
	expect(await page.locator("iframe[data-wc-frame]").count()).toBe(0);
	const back = page.getByRole("link", { name: /admin/i });
	expect(new URL((await back.getAttribute("href")) ?? "").pathname).toBe(`/sites/${siteId}/build`);
	await page.context().close();
}

describe("the building area's session", () => {
	test("the admin's way in arrives as another site's navigation, and opens the shell", async () => {
		const { account } = await install.install.createMember({ workspaceId, role: "editor", name: "Erin Editor" });
		const page = await install.newPage("light");
		const fetchSite = new Promise<string | undefined>((resolve) => {
			page.on("request", async (request) => {
				if (new URL(request.url()).pathname.startsWith("/_webcraft/build/page/") && request.isNavigationRequest())
					resolve((await request.allHeaders())["sec-fetch-site"]);
			});
		});
		await install.signIn(page, account);

		await page.goto(install.adminUrl(`/sites/${siteId}/build?open=${encodeURIComponent("/page/blog/fresh-bread")}`));
		const frame = await frameOf(page);

		expect(["cross-site", "same-site"]).toContain((await fetchSite) ?? "");
		expect(new URL(frame.url()).pathname).toBe("/blog/fresh-bread");
		await page.context().close();
	});

	test("ends when the person loses access to the Site: the shell says so and saves nothing more", async () => {
		const leaving = await install.install.createMember({ workspaceId, role: "editor", name: "Lee Leaving" });
		const session = await editing(leaving.account);

		await (await install.install.superadmin()).api.members.remove({ workspaceId, personId: leaving.personId });

		await expectEndedInShell(session);
	});

	test("ends after 8 hours: the shell says so and saves nothing more", async () => {
		const ada = await install.install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
		const session = await editing(ada.account);

		// The web process runs on the real clock: the session's 8 hours are over as its end time passes.
		const client = new pg.Client({ connectionString: install.install.databaseUrl });
		await client.connect();
		try {
			const ended = await client.query(
				"UPDATE edit_sessions SET expires_at = now() - interval '1 second' WHERE person_id = $1",
				[ada.personId],
			);
			expect(ended.rowCount).toBe(1);
		} finally {
			await client.end();
		}

		await expectEndedInShell(session);
	});

	// Last: it asks two-factor authentication of every Member of the Workspace.
	test("ends when two-factor authentication becomes required: the shell says so and saves nothing more", async () => {
		const member = await install.install.createMember({ workspaceId, role: "editor", name: "Tess Twofactor" });
		const session = await editing(member.account);
		const staff: TestBrowser = (await install.install.createStaff({ workspaces: [workspaceId], name: "Sam Staff" }))
			.browser;
		await addAuthenticator(install.install, staff);

		await confirmIfAsked(staff, TEST_PASSWORD, () =>
			staff.api.members.requireTwoFactor({ workspaceId, required: true }),
		);

		await expectEndedInShell(session);
	});
});
