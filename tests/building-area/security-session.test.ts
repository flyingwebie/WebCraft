// The building area's session and the link that starts it (ADR 0037), held to what Edit mode's own
// security tests hold it to. The link that opens the building area works once, for 60 seconds, on the
// Site it was made for, and only for someone who still edits that Site. A session ends at once when
// the person loses access to the Site, after 8 hours however much it is used, and when two-factor
// authentication becomes required for them: from then on the shell, its API, the edit requests and the
// Drafts' sockets refuse it, nothing more is written, and the Site's pages are visitors' pages again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withValue } from "../co-editing/support.ts";
import { buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { type BuildingAreaBrowser, openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { openDraftInEditMode, type TestEditor, upgradeDraftInEditMode } from "../harness/co-editing.ts";
import { createTestInstall, TEST_PASSWORD, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { addAuthenticator, confirmIfAsked } from "../harness/two-factor.ts";

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

const EDIT_COOKIE = "__Host-webcraft.edit";
const BUILD_COOKIE = "__Host-webcraft.build";

let sites = 0;

type Bakery = { siteId: string; slug: string; origin: string; entryId: string; postTypeId: string };

/** A live Site with a published Blog post at /blog/fresh-bread, its subtitle "Out of the oven". */
async function bakery(): Promise<Bakery> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
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
	return { siteId, slug, origin: `https://${slug}.live.test`, entryId: entry.id, postTypeId: postType.id };
}

const PATH = "/blog/fresh-bread";

/** Someone in the building area on a Site, with the Blog post's Draft open over the Drafts' socket. */
type Editing = { area: BuildingAreaBrowser; draft: TestEditor };

async function enter(site: Bakery, admin: TestBrowser): Promise<Editing> {
	const area = await openBuildingArea(install, admin, site.siteId, { open: `/page${PATH}` });
	// The session holds before anything ends it: the shell, a save and a socket all work.
	expect((await area.shell(area.landed)).status).toBe(200);
	const draft = await openDraftInEditMode(area, { kind: "entry", id: site.entryId });
	return { area, draft };
}

/**
 * The building-area session has ended for this browser: the shell, its API, the edit requests and the
 * Drafts' socket refuse it, the open Draft ends at its next change, nothing is written, and the page
 * the frame loads is the visitors' page.
 */
async function expectEnded(site: Bakery, { area, draft }: Editing): Promise<void> {
	// The open Draft ends at the next change, which is never saved.
	draft.change((current) => withValue(current, "subtitle", "Typed after the end"));
	await draft.until(() => draft.status() === "ended", "the open Draft to end");
	draft.close();
	const socket = await upgradeDraftInEditMode(area, { kind: "entry", id: site.entryId });
	expect(socket instanceof Response && socket.status).toBe(401);

	// The shell is the page that sends the person back to the admin: no token, nothing to start from.
	const shell = await area.browser.request(`${site.origin}/_webcraft/build/page${PATH}`);
	expect(shell.status).toBe(401);
	expect(shellConfigIn(await shell.text())).toBeUndefined();

	// The frame's page is the visitors' page: no regions, no agent, no token, no Drafts.
	const page = await area.page(PATH);
	const html = await page.text();
	expect(html).toContain("<p>Out of the oven</p>");
	expect(html).not.toContain("data-wc-");
	expect(html).not.toContain("webcraft-edit-token");
	expect(html).not.toContain("/_webcraft/edit/assets/agent-");
	// A page opened at the top level stays where it is: no way into a shell that would refuse it.
	expect((await area.page(PATH, "document")).status).toBe(200);

	// The API on the Site's address refuses it, and so does each edit request.
	const { call } = buildingAreaApi(install, area);
	const viaApi = await refusalOf(await call("entries.get", { siteId: site.siteId, entryId: site.entryId }));
	expect(viaApi).toMatchObject({ status: 401, code: "EDIT_MODE_ENDED" });
	const save = await area.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Late" });
	expect(save.status).toBe(401);
	expect(await save.json()).toMatchObject({ code: "EDIT_MODE_ENDED" });
	expect(area.browser.cookies.has(EDIT_COOKIE)).toBe(false);

	const { entry } = await staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
	expect(entry.draft.fields.subtitle).toBe("Out of the oven");
}

describe("a building-area session ends", () => {
	test("as soon as the person loses access to the Site", async () => {
		const site = await bakery();
		const member = await install.createMember({ workspaceId, role: "editor" });
		const editing = await enter(site, member.browser);

		await (await install.superadmin()).api.members.remove({ workspaceId, personId: member.personId });

		await expectEnded(site, editing);
	});

	describe("when two-factor authentication becomes required", () => {
		let site: Bakery;
		let editing: Editing;
		let link: string;
		const setRequired = (required: boolean) =>
			confirmIfAsked(staff, TEST_PASSWORD, () => staff.api.members.requireTwoFactor({ workspaceId, required }));

		beforeAll(async () => {
			site = await bakery();
			const member = await install.createMember({ workspaceId, role: "editor" });
			editing = await enter(site, member.browser);
			link = (await member.browser.api.editMode.open({ siteId: site.siteId })).url;
			await addAuthenticator(install, staff);
			await setRequired(true);
		});

		afterAll(async () => {
			await setRequired(false);
		});

		test("for the person: the session ends as soon as they must set it up first", async () => {
			await expectEnded(site, editing);
		});

		test("a link they made before opens nothing", async () => {
			const response = await install.browser({ origin: site.origin }).request(link);

			expect(response.status).toBe(403);
			expect(response.headers.getSetCookie()).toEqual([]);
		});
	});
});

describe("the link that opens the building area", () => {
	test("works once", async () => {
		const site = await bakery();
		const { url } = await editor.api.editMode.open({ siteId: site.siteId });

		const first = await install.browser({ origin: site.origin }).request(url);
		expect(first.status).toBe(303);
		expect(first.headers.get("location")).toBe("/_webcraft/build/page/");

		const again = await install.browser({ origin: site.origin }).request(url);
		expect(again.status).toBe(403);
		expect(again.headers.getSetCookie()).toEqual([]);
		expect(await again.text()).toContain("expired or was used already");
	});

	test("works for 60 seconds", async () => {
		const site = await bakery();
		const { url, expiresAt } = await editor.api.editMode.open({ siteId: site.siteId });
		expect(expiresAt).toEqual(new Date(install.clock.now().getTime() + 60_000));

		await install.clock.advance(60_000);

		const late = await install.browser({ origin: site.origin }).request(url);
		expect(late.status).toBe(403);
		expect(late.headers.getSetCookie()).toEqual([]);
	});

	test("works only at the address of the Site it was made for", async () => {
		const ours = await bakery();
		const other = await bakery();
		const { url } = await editor.api.editMode.open({ siteId: ours.siteId });
		expect(new URL(url).origin).toBe(ours.origin);

		for (const host of [new URL(other.origin).host, `${other.slug}.sites.test`]) {
			const elsewhere = new URL(url);
			elsewhere.host = host;
			const response = await install.browser({ origin: `https://${host}` }).request(elsewhere);
			expect({ host, status: response.status }).toEqual({ host, status: 403 });
			expect(response.headers.getSetCookie()).toEqual([]);
		}
		// Trying it elsewhere doesn't use it up.
		const response = await install.browser({ origin: ours.origin }).request(url);
		expect(response.status).toBe(303);
		expect(response.headers.getSetCookie().some((line) => line.startsWith(`${BUILD_COOKIE}=`))).toBe(true);
	});

	test("a made-up link opens nothing", async () => {
		const site = await bakery();

		for (const path of [
			"/_webcraft/edit/enter?build=1",
			"/_webcraft/edit/enter?token=made-up&build=1",
			"/_webcraft/edit/enter?token=made-up&build=1&open=%2Fpage%2F",
		]) {
			const response = await install.browser({ origin: site.origin }).request(`${site.origin}${path}`);
			expect({ path, status: response.status }).toEqual({ path, status: 403 });
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	});

	test("made in an admin session that has since signed out, it opens nothing", async () => {
		const site = await bakery();
		const { account } = await install.createMember({ workspaceId, role: "author" });
		const author = await install.signIn(account);
		const { url } = await author.api.editMode.open({ siteId: site.siteId });

		await author.api.session.signOut();

		const response = await install.browser({ origin: site.origin }).request(url);
		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	test("for a person who lost access between making it and following it, it opens nothing", async () => {
		const site = await bakery();
		const { personId, browser } = await install.createMember({ workspaceId, role: "editor" });
		const { url } = await browser.api.editMode.open({ siteId: site.siteId });

		await (await install.superadmin()).api.members.remove({ workspaceId, personId });

		const response = await install.browser({ origin: site.origin }).request(url);
		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	test("opens a path on the Site, never another address", async () => {
		const site = await bakery();

		for (const path of ["https://elsewhere.example/", "//elsewhere.example/", "/\\elsewhere.example", "about"]) {
			const code = await editor.api.editMode.open({ siteId: site.siteId, path }).catch((error) => error.code);
			expect({ path, code }).toEqual({ path, code: "EDIT_PATH_INVALID" });
		}
	});

	test("only people who edit the Site's Content get one: others can't see the Site at all", async () => {
		const site = await bakery();
		const elsewhere = await install.createWorkspace("Someone else");
		const outsider = (await install.createMember({ workspaceId: elsewhere.id, role: "owner" })).browser;

		expect(await outsider.api.editMode.open({ siteId: site.siteId }).catch((error) => error.code)).toBe(
			"SITE_NOT_FOUND",
		);
		expect(
			await install
				.browser()
				.api.editMode.open({ siteId: site.siteId })
				.catch((error) => error.code),
		).toBe("UNAUTHORIZED");
	});

	test("a Site without an address of its own has none", async () => {
		const bare = await createTestInstall({ sitesDomain: null });
		try {
			const workspace = await bare.createWorkspace();
			const site = await bare.createSite(workspace.id);
			const admin = await bare.superadmin();

			expect(await admin.api.editMode.open({ siteId: site.id }).catch((error) => error.code)).toBe(
				"EDIT_MODE_UNAVAILABLE",
			);
		} finally {
			await bare.close();
		}
	});
});

// Last in the file: it moves the clock on by 8 hours, past every other session made here.
describe("after 8 hours", () => {
	test("a building-area session ends however much it is used, and Staff's Drafts of the Structure go with it", async () => {
		const site = await bakery();
		const member = await install.createMember({ workspaceId, role: "editor" });
		const memberEditing = await enter(site, member.browser);
		const ada = await install.createStaff({ workspaces: [workspaceId] });
		const staffEditing = await enter(site, ada.browser);
		// A change to the Template's Draft: Staff see it in the frame, visitors never do.
		await ada.browser.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><p>Not published</p></article>",
		});
		expect(await (await staffEditing.area.page(PATH)).text()).toContain("Not published");

		await install.clock.advance(8 * 60 * 60 * 1000 - 60_000);
		await member.browser.api.session.current();
		await ada.browser.api.session.current();
		const shell = await memberEditing.area.shell(memberEditing.area.landed);
		expect(shellConfigIn(await shell.text())?.token).toBeString();
		expect(
			(await memberEditing.area.edit("save", { item: `entry:${site.entryId}`, field: "title", value: "Fresh bread" }))
				.status,
		).toBe(200);

		await install.clock.advance(60_000);
		await member.browser.api.session.current();
		await ada.browser.api.session.current();

		await expectEnded(site, memberEditing);
		await expectEnded(site, staffEditing);
		expect(await (await staffEditing.area.page(PATH)).text()).not.toContain("Not published");
	});
});
