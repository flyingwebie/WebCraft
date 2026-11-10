// Social card choices are portable; the worker must regenerate derived PNGs for the new Site.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { metaProperty } from "../harness/seo.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import {
	exportedArchive,
	importArchive,
	manifestIn,
	rewritten,
	tarFiles,
	uploadArchive,
} from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "./support.ts";

let source: TestInstall;
let target: TestInstall;
let admin: TestBrowser;
let workspaceId: string;
let sourceWorkspaceId: string;
let sourceSiteId: string;
let logoId: string;
let archive: Uint8Array;
let disabledArchive: Uint8Array;
const originals = new Map<string, { entryId: string; url: string; input: Record<string, unknown> }>();

async function card(install: TestInstall, origin: string, key: string) {
	const page = await install.request(`${origin}/${key}/example`);
	expect(page.status).toBe(200);
	const url = metaProperty(await expectSafePage(page), "og:image") ?? "";
	expect(url).toContain(`${origin}/_wc/social/`);
	const response = await install.request(url);
	expectSiteHeaders(response);
	expect(response.status).toBe(200);
	const png = new Uint8Array(await response.arrayBuffer());
	expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");
	return { url, input: JSON.parse(new TextDecoder().decode(png.slice(8))) as Record<string, unknown> };
}

beforeAll(async () => {
	source = await createTestInstall();
	const staff = await source.superadmin();
	sourceWorkspaceId = (await source.createWorkspace("Social source")).id;
	sourceSiteId = (await source.createSite(sourceWorkspaceId, { name: "Social source", slug: "social-source" })).id;
	const origin = await goLive(source, sourceSiteId);
	const { media } = await staff.api.media.upload({
		siteId: sourceSiteId,
		file: upload(await photo({ width: 120, height: 80, format: "png" }), "logo.png"),
	});
	logoId = media.id;
	expect((await source.drainJobs({ only: ["media.process", "media.variants"] })).failed).toEqual([]);
	await staff.api.seoSettings.update({
		siteId: sourceSiteId,
		siteName: "Card source",
		organization: { logo: logoId },
		socialCards: { enabled: true, layout: "orbit" },
	});
	for (const key of ["news", "stories"]) {
		const { postType } = await staff.api.postTypes.create({
			siteId: sourceSiteId,
			name: key,
			key,
			urlPattern: `/${key}/{slug}`,
			seo: { socialCardLayout: key === "news" ? "frame" : null },
		});
		const { template } = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: sourceSiteId,
			postTypeId: postType.id,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		await staff.api.templates.publish({ siteId: sourceSiteId, templateId: template.id });
		const { entry } = await staff.api.entries.create({
			siteId: sourceSiteId,
			postTypeId: postType.id,
			title: `Published ${key}`,
			slug: "example",
		});
		await staff.api.entries.publish({ siteId: sourceSiteId, entryId: entry.id });
		originals.set(key, { entryId: entry.id, url: "", input: {} });
	}
	expect((await source.drainJobs()).failed).toEqual([]);
	for (const [key, original] of originals) Object.assign(original, await card(source, origin, key));
	expect(source.socialCards.rendered).toHaveLength(2);
	archive = await exportedArchive(source, staff, sourceSiteId);
	await staff.api.seoSettings.update({ siteId: sourceSiteId, socialCards: { enabled: false } });
	disabledArchive = await exportedArchive(source, staff, sourceSiteId);
	target = await createTestInstall();
	admin = await target.superadmin();
	workspaceId = (await target.createWorkspace("Destination")).id;
});

afterAll(async () => {
	await target?.close();
	await source?.close();
});

test("only Social card settings and the logo are exported, never derived rows or PNGs", () => {
	const manifest = manifestIn(archive);
	expect(manifest.tables.map((table: { name: string }) => table.name)).not.toContain("public.social_cards");
	expect(manifest.leftOut.tables).toContainEqual({ name: "public.social_cards", reason: "published" });
	expect(manifest.files.rows).toBe(1);
	expect(tarFiles(archive).filter((file) => file.path.startsWith("files/"))).toHaveLength(1);
	expect(manifest.secrets.names).toEqual([]);
});

test("an import queues current card work, keeps Drafts unpublished, and regenerates both layouts on first publish", async () => {
	const uploaded = await uploadArchive(admin, workspaceId, archive);
	await admin.api.siteImports.start({
		workspaceId,
		importId: uploaded.id,
		name: "Social copy",
		slug: "social-copy",
		passphrase: null,
	});
	expect((await target.drainJobs({ only: ["siteImports.run"] })).failed).toEqual([]);
	const { import: imported } = await admin.api.siteImports.get({ workspaceId, importId: uploaded.id });
	expect(imported.status).toBe("done");
	const siteId = imported.site?.id ?? "";
	const cards = await target.drainJobs({ only: ["socialCards.render"] });
	expect(cards.failed).toEqual([]);
	expect(cards.completed).toContainEqual({
		name: "socialCards.render",
		data: expect.objectContaining({ siteId }),
	});
	expect(target.socialCards.rendered).toEqual([]);
	expect((await target.drainJobs()).failed).toEqual([]);
	const { settings } = await admin.api.seoSettings.get({ siteId });
	const [logo] = (await admin.api.media.list({ siteId })).items;
	expect(logo?.id).not.toBe(logoId);
	expect(settings).toMatchObject({ socialCards: { enabled: true, layout: "orbit" }, organization: { logo: logo?.id } });
	const { postTypes } = await admin.api.postTypes.list({ siteId });
	expect(postTypes.find((type) => type.key === "news")?.seo.socialCardLayout).toBe("frame");
	expect(postTypes.find((type) => type.key === "stories")?.seo.socialCardLayout).toBeNull();
	for (const type of postTypes.filter((type) => originals.has(type.key))) {
		const [entry] = (await admin.api.entries.list({ siteId, postTypeId: type.id })).entries;
		expect(entry?.published).toBeNull();
	}
	expect(target.socialCards.rendered).toEqual([]);
	await publishEverything(admin, siteId);
	expect((await target.drainJobs()).failed).toEqual([]);
	const origin = await goLive(target, siteId);
	expect(target.socialCards.rendered).toHaveLength(2);
	for (const [key, original] of originals) {
		const current = await card(target, origin, key);
		expect(current.input).toEqual(original.input);
		expect(current.url).not.toContain(original.entryId);
		const oldUrl = new URL(original.url);
		const response = await target.request(origin + oldUrl.pathname);
		expectSiteHeaders(response);
		expect(response.status).toBe(404);
	}
});

test("a disabled Site retains its layout and Post Type override without generating cards", async () => {
	const imported = await importArchive(target, admin, workspaceId, disabledArchive, {
		name: "Disabled copy",
		slug: "disabled-copy",
	});
	expect(imported.status).toBe("done");
	const siteId = imported.site?.id ?? "";
	expect((await admin.api.seoSettings.get({ siteId })).settings.socialCards).toEqual({
		enabled: false,
		layout: "orbit",
	});
	expect(
		(await admin.api.postTypes.list({ siteId })).postTypes.find((type) => type.key === "news")?.seo.socialCardLayout,
	).toBe("frame");
	const before = target.socialCards.rendered.length;
	await publishEverything(admin, siteId);
	expect((await target.drainJobs()).failed).toEqual([]);
	expect(target.socialCards.rendered).toHaveLength(before);
	const origin = await goLive(target, siteId);
	const page = await target.request(`${origin}/news/example`);
	expect(page.status).toBe(200);
	expect(metaProperty(await expectSafePage(page), "og:image")).toBeUndefined();
});

test("an older archive's derived cache is ignored and regenerated from imported content", async () => {
	const original = originals.get("news");
	if (!original) throw new Error("Missing card fixture.");
	const hash = /([a-f0-9]{64})\.png$/.exec(original.url)?.[1];
	const withCache = rewritten(archive, {
		rows: (table, rows) => (table === "public.social_cards" ? null : rows),
		extraTables: [
			{
				name: "public.social_cards",
				module: null,
				rows: [
					{
						id: crypto.randomUUID(),
						workspace_id: sourceWorkspaceId,
						site_id: sourceSiteId,
						entry_id: original.entryId,
						language: "en",
						hash,
						png: "\\x89504e470d0a1a0a00",
						created_at: source.clock.now().toISOString(),
					},
				],
			},
		],
	});
	const imported = await importArchive(target, admin, workspaceId, withCache, {
		name: "Old cache copy",
		slug: "old-cache-copy",
	});
	expect(imported.status).toBe("done");
	const siteId = imported.site?.id ?? "";
	const before = target.socialCards.rendered.length;
	await publishEverything(admin, siteId);
	expect((await target.drainJobs()).failed).toEqual([]);
	expect(target.socialCards.rendered).toHaveLength(before + 2);
	const origin = await goLive(target, siteId);
	expect((await card(target, origin, "news")).input).toEqual(original.input);
});
