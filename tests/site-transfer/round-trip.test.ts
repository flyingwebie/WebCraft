// A Site export holds one Site (ADR 0033): exported from one Install and imported into another
// Workspace, or into a fresh Install, it comes back as a new Site whose pages render as they did once
// published, with its Media served, its Submissions, analytics, Redirect rules and history, its
// Content arriving as Drafts and its domains paused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";

import { analyticsApi, dayOf } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { exportedArchive, importArchive, manifestIn, tarFiles } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { approveModules, publishEverything, type RichSite, richSite } from "./support.ts";

let source: TestInstall;
let site: RichSite;
let archive: Uint8Array;

beforeAll(async () => {
	source = await createTestInstall();
	await approveModules(source);
	site = await richSite(source);
	expect(site.page).toContain("<h1>Fresh bread</h1>");
	archive = await exportedArchive(source, site.staff, site.siteId);
});

afterAll(async () => {
	await source?.close();
});

/** What a page shows inside <main>. */
function mainOf(html: string): string {
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

describe("a Site export", () => {
	test("is one tar archive: its manifest first, then people, the Site's rows and its files", () => {
		const paths = tarFiles(archive).map((file) => file.path);
		expect(paths[0]).toBe("manifest.json");
		expect(paths[1]).toBe("people.jsonl.gz");
		expect(paths.some((path) => path.endsWith("-public.entries.jsonl.gz"))).toBe(true);
		expect(paths.some((path) => path.endsWith("-m_forms.submissions.jsonl.gz"))).toBe(true);
		expect(paths.filter((path) => path.startsWith("files/")).length).toBe(1);
	});

	test("its manifest names the format, versions, the Modules it needs and its counts, with each file's checksum", () => {
		const manifest = manifestIn(archive);
		expect(manifest).toMatchObject({
			format: "webcraft-site-export",
			formatVersion: 1,
			site: { id: site.siteId, workspaceId: site.workspaceId, name: "Acme Bakery", slug: "bakery" },
			secrets: { carried: false },
		});
		expect(manifest.modules.map((module: { id: string }) => module.id).sort()).toEqual([
			"forms",
			"redirects",
			"site-analytics",
		]);
		expect(manifest.counts).toMatchObject({ submissions: 1, redirectRules: 1, media: 1, members: 2 });
		expect(manifest.counts.analyticsEvents).toBeGreaterThan(0);
		expect(manifest.counts.revisions).toBeGreaterThan(0);
		for (const table of manifest.tables) expect(table.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("every table holding the Site's rows is carried or named as left out, with why", async () => {
		const manifest = manifestIn(archive);
		const accounted = new Set([
			...manifest.tables.map((table: { name: string }) => table.name),
			...manifest.leftOut.tables.map((table: { name: string }) => table.name),
		]);
		const holding = (await source.tablesHolding(site.siteId)).filter((name) => !name.startsWith("pgboss."));
		// The Site's own row is the manifest's `site`.
		expect(holding.filter((name) => !accounted.has(name))).toEqual(["public.sites"]);
		for (const table of manifest.leftOut.tables) expect(table.reason).toMatch(/^[a-z]+$/);
	});

	test("holds Media originals, never their variants, and nothing that signs anyone in", () => {
		const paths = tarFiles(archive).map((file) => file.path);
		expect(paths.filter((path) => /\.(avif|webp)$/.test(path))).toEqual([]);
		const manifest = manifestIn(archive);
		const leftOut = manifest.leftOut.tables.map((table: { name: string }) => table.name);
		expect(leftOut).toEqual(
			expect.arrayContaining(["public.secrets", "public.content_keys", "public.share_links", "public.edit_sessions"]),
		);
		expect(manifest.tables.map((table: { name: string }) => table.name)).not.toContain("public.sessions");
	});
});

describe("imported into another Workspace of the same Install", () => {
	let imported: Awaited<ReturnType<typeof importArchive>>;
	let newSiteId: string;
	let staff: TestBrowser;

	beforeAll(async () => {
		const otherWorkspaceId = (await source.createWorkspace("Beta Ltd")).id;
		staff = (await source.createStaff({ workspaces: [otherWorkspaceId] })).browser;
		imported = await importArchive(source, staff, otherWorkspaceId, archive, {
			name: "Beta Bakery",
			slug: "beta-bakery",
		});
		newSiteId = imported.site?.id ?? "";
	});

	test("makes a new Site, never touching the one it came from", async () => {
		expect(imported.status).toBe("done");
		expect(imported.site?.name).toBe("Beta Bakery");
		expect(newSiteId).not.toBe(site.siteId);
		const page = await source.request(`${site.origin}/blog/fresh-bread`);
		expect(mainOf(await page.text())).toBe(mainOf(site.page));
	});

	test("its Content arrives as Drafts, nothing published until someone publishes", async () => {
		const { postTypes } = await staff.api.postTypes.list({ siteId: newSiteId });
		const posts = postTypes.find((type) => type.key === "posts");
		const { entries } = await staff.api.entries.list({ siteId: newSiteId, postTypeId: posts?.id ?? "" });
		expect(entries.map((entry) => [entry.draft.title, entry.status, entry.path])).toEqual([
			["Fresh bread", "draft", null],
		]);
		expect(imported.report?.drafts.published).toBeGreaterThan(5);
	});

	test("its domains arrive paused: the Site it came from keeps serving them", async () => {
		expect(imported.report?.paused).toEqual([{ name: "bakery.live.test", role: "primary", language: null }]);
		expect((await staff.api.domains.list({ siteId: newSiteId })).domains).toEqual([]);
	});

	test("its pages render as they did once published: the Component, the related Entry and the image", async () => {
		await publishEverything(staff, newSiteId);
		const origin = await goLive(source, newSiteId);
		const main = mainOf(await (await source.request(`${origin}/blog/fresh-bread`)).text());
		expect(main).toContain("<h1>Fresh bread</h1>");
		expect(main).toContain("<p><em>Bread</em></p>");
		expect(main).toContain("<strong>Fresh</strong>");
		expect(main).toContain(`src="${site.mediaUrl}"`);
		expect(main).toBe(mainOf(site.page));
	});
});

describe("imported into a fresh Install", () => {
	let target: TestInstall;
	let admin: TestBrowser;
	let imported: Awaited<ReturnType<typeof importArchive>>;
	let newSiteId: string;
	let origin: string;

	beforeAll(async () => {
		target = await createTestInstall();
		await approveModules(target);
		admin = await target.superadmin();
		const workspaceId = (await target.createWorkspace("Acme Ltd")).id;
		imported = await importArchive(target, admin, workspaceId, archive, { name: "Acme Bakery", slug: "bakery" });
		newSiteId = imported.site?.id ?? "";
		await publishEverything(admin, newSiteId);
		origin = await goLive(target, newSiteId);
	});

	afterAll(async () => {
		await target?.close();
	});

	test("pages render as they did, the image served with the same bytes", async () => {
		expect(imported.status).toBe("done");
		const html = await (await target.request(`${origin}/blog/fresh-bread`)).text();
		expect(mainOf(html)).toBe(mainOf(site.page));
		const file = await target.request(`${origin}${site.mediaUrl}`);
		expect(file.status).toBe(200);
		expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(site.mediaBytes))).toBe(true);
	});

	test("the worker makes the image's variants again", async () => {
		expect((await target.drainJobs()).failed).toEqual([]);
		const { items: media } = await admin.api.media.list({ siteId: newSiteId });
		expect(media).toHaveLength(1);
		expect(media[0]?.variants.length).toBeGreaterThan(0);
		expect((await target.request(`${origin}${media[0]?.variants[0]?.url}`)).status).toBe(200);
	});

	test("its Form keeps its Submissions", async () => {
		const { forms: list } = await admin.api.forms.list({ siteId: newSiteId });
		const contact = list.find((form) => form.key === "contact");
		const { submissions } = await moduleApi<typeof forms>(admin, "forms").submissions.list({
			siteId: newSiteId,
			formId: contact?.id ?? "",
			folder: "inbox",
		});
		expect(submissions).toHaveLength(1);
		expect(JSON.stringify(submissions[0])).toContain("ada@example.com");
	});

	test("its analytics keep their counts", async () => {
		const range = dayOf(source.clock.now());
		const { totals } = await analyticsApi(admin).stats.totals({ siteId: newSiteId, ...range });
		expect(totals.pageviews).toBeGreaterThan(0);
	});

	test("its Redirect rules send visitors on", async () => {
		const moved = await target.request(`${origin}/old-bread`);
		expect(moved.status).toBe(301);
		expect(moved.headers.get("location")).toBe("/blog/fresh-bread");
	});

	test("its history keeps the Revisions of what was published where it came from, and the publish just made", async () => {
		const { postTypes } = await admin.api.postTypes.list({ siteId: newSiteId });
		const posts = postTypes.find((type) => type.key === "posts");
		const { entries } = await admin.api.entries.list({ siteId: newSiteId, postTypeId: posts?.id ?? "" });
		const history = await admin.api.history.list({
			siteId: newSiteId,
			item: { kind: "entry", id: entries[0]?.id ?? "" },
		});
		expect(JSON.stringify(history)).toContain("Fresh bread");
		// Two publishes where it came from, and the one just made here.
		expect(history.copies.filter((copy) => copy.type === "revision")).toHaveLength(3);
	});
});
