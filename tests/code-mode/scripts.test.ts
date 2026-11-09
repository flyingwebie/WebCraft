// The Site script and page scripts (ADR 0016, ADR 0022, ADR 0023): Structure that Staff write in
// Code mode's JS panel, with a Draft and a published version, published like any other Structure
// (`structure.edit`). Pages never carry them inline: each is a file named by its content's hash on
// the Site's own domain, the published ones at `/_wc/js/<hash>.js` for visitors (and in Edit mode,
// where the Site's own scripts run), the Drafts only for Staff in Code mode, where a changed script
// runs only once saved and run, or when the page is loaded again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { answer, headOf, openCodeMode } from "../harness/code-mode.ts";
import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let otherStaff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	otherStaff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

type CodeScript = { code: string; version: string | null; src: string | null };
type Scripts = { site: CodeScript; page: (CodeScript & { entryId: string }) | null };
type Refusal = { code: string; data?: { version?: string | null } };

let sites = 0;

/** A Site with two published Blog posts. */
async function bakery() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const entries: string[] = [];
	for (const title of ["Fresh bread", "Rye loaves"]) {
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		entries.push(entry.id);
	}
	return {
		siteId,
		origin: `https://${slug}.sites.test`,
		entryId: entries[0] as string,
		otherEntryId: entries[1] as string,
	};
}

/** The scripts a page's <head> loads, as `[src, attributes]`. */
function scriptsIn(html: string): string[] {
	return [...headOf(html).matchAll(/<script src="([^"]+)"( defer)?><\/script>/g)].map(
		(match) => `${match[1]}${match[2] ?? ""}`,
	);
}

async function refusal(response: Response, status: number): Promise<Refusal> {
	expect(response.status).toBe(status);
	return (await response.json()) as Refusal;
}

describe("writing scripts in Code mode", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	let coding: EditModeBrowser;
	let saved: { site: CodeScript; page: CodeScript };

	beforeAll(async () => {
		site = await bakery();
		coding = await openCodeMode(install, staff, site.siteId, path);
		const none = await answer<Scripts>(coding.edit("code/scripts", { path }));
		expect(none).toEqual({
			site: { code: "", version: null, src: null },
			page: { entryId: site.entryId, code: "", version: null, src: null },
		});
		saved = {
			site: await answer<CodeScript>(
				coding.edit("code/saveScript", {
					path,
					kind: "site",
					code: 'document.body.dataset.site = "on";',
					version: null,
				}),
			),
			page: await answer<CodeScript>(
				coding.edit("code/saveScript", { path, kind: "page", code: "console.log('fresh bread');", version: null }),
			),
		};
	});

	test("saves the Site script and the page's script to their Drafts", async () => {
		expect(saved.site).toEqual({
			code: 'document.body.dataset.site = "on";',
			version: expect.stringMatching(/^[0-9a-f]{16}$/),
			src: expect.stringMatching(/^\/_webcraft\/edit\/js\/[0-9a-f]{16}\.js$/),
		});
		const scripts = await answer<Scripts>(coding.edit("code/scripts", { path }));
		expect(scripts.site).toEqual(saved.site);
		expect(scripts.page).toEqual({ entryId: site.entryId, ...saved.page });
	});

	test("a page in Code mode runs the Drafts, the Site script first, as files only Staff in Code mode get", async () => {
		const html = await (await coding.page(path)).text();

		expect(scriptsIn(html).slice(-2)).toEqual([`${saved.site.src} defer`, `${saved.page.src} defer`]);
		const file = await coding.browser.request(`${site.origin}${saved.page.src}`);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(file.headers.get("cache-control")).toBe("no-store");
		expect(await file.text()).toBe("console.log('fresh bread');");

		expect((await install.request(`${site.origin}${saved.page.src}`)).status).toBe(404);
		const member = await openEditMode(install, editor, site.siteId, path);
		expect((await member.browser.request(`${site.origin}${saved.page.src}`)).status).toBe(404);
	});

	test("visitors and Content editing get none of a Draft", async () => {
		const visitor = await (await install.request(`${site.origin}${path}`)).text();
		expect(scriptsIn(visitor)).toEqual([]);
		const member = await openEditMode(install, editor, site.siteId, path);
		const html = await (await member.page(path)).text();
		expect(scriptsIn(html).every((src) => src.startsWith("/_webcraft/edit/assets/"))).toBe(true);
	});

	test("a page script runs on its own page only", async () => {
		const other = await answer<Scripts>(coding.edit("code/scripts", { path: "/blog/rye-loaves" }));
		expect(other.page).toEqual({ entryId: site.otherEntryId, code: "", version: null, src: null });

		const html = await (await coding.page("/blog/rye-loaves")).text();
		expect(scriptsIn(html).slice(-1)).toEqual([`${saved.site.src} defer`]);
	});

	test("a save over a script someone changed meanwhile is refused with the newer version", async () => {
		const scripts = await answer<Scripts>(coding.edit("code/scripts", { path }));
		const theirs = await otherStaff.api.scripts.saveDraft({
			siteId: site.siteId,
			entryId: null,
			code: "console.log('theirs');",
			basedOn: scripts.site.version,
		});

		const refused = await refusal(
			await coding.edit("code/saveScript", {
				path,
				kind: "site",
				code: "console.log('mine');",
				version: scripts.site.version,
			}),
			409,
		);

		expect(refused.code).toBe("CHANGED_MEANWHILE");
		expect(refused.data?.version).toBe(theirs.version);
	});

	test("the 404 page has the Site script only", async () => {
		const scripts = await answer<Scripts>(coding.edit("code/scripts", { path: "/nothing-here" }));
		expect(scripts.page).toBeNull();
		const refused = await coding.edit("code/saveScript", {
			path: "/nothing-here",
			kind: "page",
			code: "",
			version: null,
		});
		expect((await refusal(refused, 404)).code).toBe("CODE_SOURCE_NOT_FOUND");
	});
});

describe("publishing scripts", () => {
	test("visitors get the published scripts as hashed files, and so does Edit mode", async () => {
		const site = await bakery();
		const siteScript = await staff.api.scripts.saveDraft({
			siteId: site.siteId,
			entryId: null,
			code: "window.site = 1;",
		});
		const pageScript = await staff.api.scripts.saveDraft({
			siteId: site.siteId,
			entryId: site.entryId,
			code: "window.page = 1;",
		});
		expect(siteScript.script.status).toBe("draft");

		await staff.api.scripts.publish({ siteId: site.siteId, scriptId: siteScript.script.id });
		const published = await staff.api.scripts.publish({ siteId: site.siteId, scriptId: pageScript.script.id });
		expect(published.script.status).toBe("published");

		const visitor = await (await install.request(`${site.origin}${path}`)).text();
		const loaded = scriptsIn(visitor);
		expect(loaded).toEqual([
			expect.stringMatching(/^\/_wc\/js\/[0-9a-f]{16}\.js defer$/),
			expect.stringMatching(/^\/_wc\/js\/[0-9a-f]{16}\.js defer$/),
		]);
		const file = await install.request(`${site.origin}${loaded[1]?.replace(" defer", "")}`);
		expect(file.status).toBe(200);
		expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await file.text()).toBe("window.page = 1;");
		const other = await (await install.request(`${site.origin}/blog/rye-loaves`)).text();
		expect(scriptsIn(other)).toEqual(loaded.slice(0, 1));

		// The Site's own scripts run in Edit mode too, for Members as well (ADR 0022).
		const member = await openEditMode(install, editor, site.siteId, path);
		const html = await (await member.page(path)).text();
		expect(scriptsIn(html).slice(-2)).toEqual(loaded);

		// A changed Draft shows to visitors once published again.
		await staff.api.scripts.saveDraft({ siteId: site.siteId, entryId: null, code: "window.site = 2;" });
		expect(scriptsIn(await (await install.request(`${site.origin}${path}`)).text())).toEqual(loaded);
	});

	test("are Structure: Members can't read, save or publish them, and publishing is logged", async () => {
		const site = await bakery();
		const { script } = await staff.api.scripts.saveDraft({ siteId: site.siteId, entryId: null, code: "1;" });
		await staff.api.scripts.publish({ siteId: site.siteId, scriptId: script.id });

		await expect(editor.api.scripts.get({ siteId: site.siteId, entryId: null })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			editor.api.scripts.saveDraft({ siteId: site.siteId, entryId: null, code: "2;" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(editor.api.scripts.publish({ siteId: site.siteId, scriptId: script.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const admin = await install.superadmin();
		const entries = await admin.api.audit.list({ limit: 20 });
		expect(entries.entries.find((entry) => entry.action === "script.publish")).toMatchObject({
			siteId: site.siteId,
			details: { scriptId: script.id, kind: "site", entryId: null },
		});
	});

	test("refuses a page script for something that isn't an Entry of the Site", async () => {
		const site = await bakery();
		const other = await bakery();

		await expect(
			staff.api.scripts.saveDraft({ siteId: site.siteId, entryId: other.entryId, code: "1;" }),
		).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
	});
});
