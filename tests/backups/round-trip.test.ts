// A Backup holds a whole Install (ADR 0032): taken from one with Sites, Entries, Media, a Module's
// rows and an Import, and restored into a fresh, empty database, it brings everything back. Media
// variants aren't in it: the restore queues them, and the worker makes them again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEBCRAFT_VERSION } from "@webcraft/core";
import type redirects from "@webcraft/module-redirects";

import { analyticsApi, analyticsVisitor, dayOf, liveSite } from "../harness/analytics.ts";
import { photo, upload } from "../harness/images.ts";
import {
	createTestInstall,
	TEST_MASTER_KEY,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";
import { csvSettings, importCsv } from "../imports/support.ts";

const SITE = "https://bakery.live.test";

let source: TestInstall;
let restored: TestInstall;
let folder: string;
let superadmin: TestAccount;
let editorAccount: TestAccount;
let siteId: string;
let mediaId: string;
let importId: string;
let archive: string;
let original: { url: string; bytes: Uint8Array<ArrayBuffer> };
let staffAccount: TestAccount;
let analyticsSiteId: string;

beforeAll(async () => {
	folder = await mkdtemp(join(tmpdir(), "webcraft-backup-test-"));
	source = await createTestInstall();
	superadmin = await source.createSuperadmin();
	const admin = await source.superadmin();
	await admin.api.modules.approve({ moduleId: "redirects", version: "1.1.0" });
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	const workspaceId = (await source.createWorkspace("Acme Ltd")).id;
	siteId = (await source.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(source, siteId);
	const staffMember = await source.createStaff({ workspaces: [workspaceId] });
	const staff = staffMember.browser;
	staffAccount = staffMember.account;
	const editor = await source.createMember({ workspaceId, role: "editor" });
	editorAccount = editor.account;

	const { media } = await editor.browser.api.media.upload({
		siteId,
		file: upload(await photo({ width: 800, height: 600 }), "Sourdough.jpg", "image/jpeg"),
	});
	mediaId = media.id;
	expect((await source.drainJobs()).failed).toEqual([]);
	const ready = (await editor.browser.api.media.get({ siteId, mediaId })).media;
	expect(ready.variants.length).toBeGreaterThan(0);
	original = {
		url: ready.url ?? "",
		bytes: new Uint8Array(await (await source.request(`${SITE}${ready.url}`)).arrayBuffer()),
	};

	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<article><h1>{{ title }}</h1><img src="media:${mediaId}" alt="A loaf"></article>`,
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await editor.browser.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.browser.api.entries.publish({ siteId, entryId: entry.id });

	await moduleApi<typeof redirects>(editor.browser, "redirects").rules.add({
		siteId,
		from: "/old-bread",
		to: "/blog/fresh-bread",
		status: 301,
	});
	({ importId } = await importCsv(
		source,
		editor.browser.api,
		siteId,
		csvSettings(postType.id, [{ column: "Name", to: "title" }]),
		"Name\nRye loaf\nSpelt loaf\n",
	));

	// Site analytics keeps its raw events in a table of monthly partitions: one visit makes this month's.
	const counted = await liveSite(source, staff, workspaceId, "counted.example");
	analyticsSiteId = counted.siteId;
	await staff.api.consentBanner.setSettings({ siteId: counted.siteId, mode: "none", layout: "bar" });
	expect((await analyticsVisitor(source, counted.origin).view("/")).status).toBeLessThan(300);

	archive = (await source.backup({ to: folder })).location;
	restored = await createTestInstall({ database: "empty" });
});

afterAll(async () => {
	await source?.close();
	await restored?.close();
	await rm(folder, { recursive: true, force: true });
});

describe("a Backup", () => {
	test("is one tar archive holding a manifest, the database and the local files", async () => {
		const listing = Bun.spawnSync(["tar", "-tf", archive]).stdout.toString().trim().split("\n");

		expect(listing[0]).toBe("manifest.json");
		expect(listing.some((path) => path.startsWith("database/"))).toBe(true);
		expect(listing.filter((path) => path.startsWith("files/")).length).toBeGreaterThan(0);
	});

	test("its manifest names versions, the migration level and the Master key's fingerprint, never the key", async () => {
		const manifest = JSON.parse(Bun.spawnSync(["tar", "-xOf", archive, "manifest.json"]).stdout.toString());

		expect(manifest).toMatchObject({
			format: "webcraft-backup",
			formatVersion: 1,
			reason: "command",
			webcraft: { version: WEBCRAFT_VERSION, takenBy: WEBCRAFT_VERSION },
			files: { storage: "disk", bucket: null },
		});
		expect(manifest.sdk).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.modules).toContainEqual({ id: "redirects", version: "1.1.0" });
		expect(manifest.migrations.core.length).toBeGreaterThan(30);
		expect(manifest.migrations.modules.redirects).toEqual(["0001-rules-and-misses"]);
		expect(manifest.database.partitions).toContainEqual(
			expect.objectContaining({ parent: "m_site_analytics.events", name: "events_2026_03" }),
		);
		expect(manifest.masterKey.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(readFileSync(archive).includes(Buffer.from(TEST_MASTER_KEY))).toBe(false);
	});

	test("holds Media originals but not their variants, which can be made again", async () => {
		const files = Bun.spawnSync(["tar", "-tf", archive])
			.stdout.toString()
			.split("\n")
			.filter((path) => path.startsWith("files/"));

		expect(files.some((path) => path.endsWith(original.url.replace("/_media/", "/media/")))).toBe(true);
		expect(files.filter((path) => /\.(avif|webp)$/.test(path))).toEqual([]);
	});
});

describe("restored into a fresh database", () => {
	let report: Awaited<ReturnType<TestInstall["restore"]>>;
	let editor: TestBrowser;

	beforeAll(async () => {
		report = await restored.restore(archive);
		editor = await restored.signIn(editorAccount);
	});

	test("says what it brought back", () => {
		expect(report.tables).toBeGreaterThan(50);
		expect(report.rows).toBeGreaterThan(0);
		expect(report.files).toBeGreaterThan(0);
		expect(report.queued.variants).toBe(1);
	});

	test("people sign in with their passwords, and the Superadmin is the Superadmin", async () => {
		const admin = await restored.signIn(superadmin);
		expect((await admin.api.session.current()).person?.email).toBe(superadmin.email);
		expect((await admin.api.workspaces.list()).workspaces.map((each) => each.name)).toEqual(["Acme Ltd"]);
	});

	test("published pages render as they did, the image at first without its variants", async () => {
		const page = await restored.request(`${SITE}/blog/fresh-bread`);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("<h1>Fresh bread</h1>");
		expect(html).toContain(`src="${original.url}"`);
		expect(html).not.toContain("<picture>");

		const file = await restored.request(`${SITE}${original.url}`);
		expect(file.status).toBe(200);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(original.bytes);
	});

	test("the worker makes the image's variants again, and pages show them", async () => {
		expect((await restored.drainJobs()).failed).toEqual([]);

		const media = (await editor.api.media.get({ siteId, mediaId })).media;
		expect(media.status).toBe("ready");
		expect(media.variants.length).toBeGreaterThan(0);
		const html = await (await restored.request(`${SITE}/blog/fresh-bread`)).text();
		expect(html).toContain("<picture>");
		const variant = await restored.request(`${SITE}${media.variants[0]?.url}`);
		expect(variant.status).toBe(200);
	});

	test("a Module's rows come back: the Redirect rule still sends visitors on", async () => {
		const moved = await restored.request(`${SITE}/old-bread`);
		expect(moved.status).toBe(301);
		expect(moved.headers.get("location")).toBe("/blog/fresh-bread");
	});

	test("a Module's monthly partitions come back with their rows", async () => {
		const staff = await restored.signIn(staffAccount);
		const { totals } = await analyticsApi(staff).stats.totals({
			siteId: analyticsSiteId,
			...dayOf(restored.clock.now()),
		});
		expect(totals.pageviews).toBe(1);
	});

	test("Imports come back with their Import reports", async () => {
		const { imports } = await editor.api.imports.list({ siteId });
		expect(imports.map((each) => each.id)).toEqual([importId]);
		const runs = (await editor.api.imports.get({ siteId, importId })).runs;
		expect(runs[0]).toMatchObject({ status: "done", counts: { created: 2 } });
	});

	test("Entries keep their Drafts, and new ones can be made (their ids don't collide)", async () => {
		const postTypes = (await editor.api.postTypes.list({ siteId })).postTypes;
		const blog = postTypes.find((each) => each.name === "Blog posts");
		const entries = (await editor.api.entries.list({ siteId, postTypeId: blog?.id ?? "" })).entries;
		expect(entries.map((entry) => entry.draft.title).sort()).toEqual(["Fresh bread", "Rye loaf", "Spelt loaf"]);
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: blog?.id ?? "", title: "Brioche" });
		expect(entry.draft.title).toBe("Brioche");
	});

	test("each item's history comes back: the Revision its publish saved, and who published it", async () => {
		const postTypes = (await editor.api.postTypes.list({ siteId })).postTypes;
		const blog = postTypes.find((each) => each.name === "Blog posts");
		const entries = (await editor.api.entries.list({ siteId, postTypeId: blog?.id ?? "" })).entries;
		const fresh = entries.find((entry) => entry.draft.title === "Fresh bread");
		const item = { kind: "entry", id: fresh?.id ?? "" } as const;
		const { copies } = await editor.api.history.list({ siteId, item });
		expect(copies.map((copy) => copy.type)).toEqual(["revision"]);
		expect(copies[0]?.by?.person?.name).toEqual(expect.any(String));
		const revision = await editor.api.history.get({
			siteId,
			item,
			copy: { type: "revision", id: copies[0]?.id ?? "" },
		});
		expect(JSON.stringify(revision.content)).toContain("Fresh bread");
	});

	test("the Audit log comes back, and keeps counting from where it was", async () => {
		const admin = await restored.signIn(superadmin);
		const { entries } = await admin.api.audit.list({ limit: 200 });
		expect(entries.some((entry) => entry.action === "module.approve")).toBe(true);
		const newest = entries[0]?.id ?? 0;
		await admin.api.workspaces.create({ name: "Nimbus Bikes" });
		const after = (await admin.api.audit.list({ limit: 1 })).entries[0];
		expect(Number(after?.id)).toBeGreaterThan(Number(newest));
	});
});
