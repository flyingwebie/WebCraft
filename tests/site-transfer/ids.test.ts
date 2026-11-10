// Every id of a Site export is replaced on import (ADR 0033), wherever it is written: in columns, in
// element trees (a Component placed, `media:<id>`), in Relationships and Media Fields, in a Module's
// data (a Redirect rule's target) and in storage keys. Imported into a fresh Install, none of the old
// ids is anywhere in its database, and every reference still points at what it pointed at.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { approveModules } from "./support.ts";

let source: TestInstall;
let target: TestInstall;
let admin: TestBrowser;
let newSiteId: string;
const old: Record<string, string> = {};

beforeAll(async () => {
	source = await createTestInstall();
	await approveModules(source);
	const staff = await source.superadmin();
	old.workspace = (await source.createWorkspace("Acme Ltd")).id;
	old.site = (await source.createSite(old.workspace, { name: "Acme Bakery", slug: "bakery" })).id;
	const siteId = old.site;
	await staff.api.modules.setOnSite({ siteId, moduleId: "redirects", on: true });
	const { media } = await staff.api.media.upload({
		siteId,
		file: upload(await photo({ width: 400, height: 300 }), "Loaf.jpg", "image/jpeg"),
	});
	old.media = media.id;
	await source.drainJobs();
	const { component } = await staff.api.components.create({ siteId, name: "Badge" });
	await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<strong>New</strong>" });
	old.component = component.id;
	const { postType: categories } = await staff.api.postTypes.create({
		siteId,
		name: "Categories",
		key: "categories",
		urlPattern: "/category/{slug}",
	});
	old.categories = categories.id;
	const { postType: posts } = await staff.api.postTypes.create({
		siteId,
		name: "Posts",
		key: "posts",
		urlPattern: "/posts/{slug}",
		fields: [
			{ key: "category", label: "Category", type: "relationship", postTypes: ["categories"], multiple: false },
			{ key: "photo", label: "Photo", type: "media" },
		],
	});
	old.posts = posts.id;
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: posts.id,
		markup: `<article><Badge/><img src="media:${media.id}" alt="Loaf"></article>`,
	});
	old.template = saved.template.id;
	const { entry: bread } = await staff.api.entries.create({ siteId, postTypeId: categories.id, title: "Bread" });
	old.bread = bread.id;
	const { entry: post } = await staff.api.entries.create({
		siteId,
		postTypeId: posts.id,
		title: "Rye",
		fields: { category: bread.id, photo: media.id },
	});
	old.post = post.id;
	await moduleApi<typeof redirects>(staff, "redirects").rules.add({
		siteId,
		from: "/loaf.jpg",
		to: `media:${media.id}`,
		status: 301,
	});
	const archive = await exportedArchive(source, staff, siteId);

	target = await createTestInstall();
	await approveModules(target);
	admin = await target.superadmin();
	const workspaceId = (await target.createWorkspace("Acme Ltd")).id;
	const imported = await importArchive(target, admin, workspaceId, archive, { name: "Acme Bakery", slug: "bakery" });
	expect(imported.status).toBe("done");
	newSiteId = imported.site?.id ?? "";
});

afterAll(async () => {
	await source?.close();
	await target?.close();
});

test("none of the old ids is anywhere in the new Install's database", async () => {
	for (const [what, id] of Object.entries(old)) {
		expect({ what, tables: await target.tablesHolding(id) }).toEqual({ what, tables: [] });
	}
});

test("references inside values point at the new items: the Relationship and the Media Field", async () => {
	const { postTypes } = await admin.api.postTypes.list({ siteId: newSiteId });
	const categories = postTypes.find((type) => type.key === "categories");
	const posts = postTypes.find((type) => type.key === "posts");
	const [bread] = (await admin.api.entries.list({ siteId: newSiteId, postTypeId: categories?.id ?? "" })).entries;
	const [rye] = (await admin.api.entries.list({ siteId: newSiteId, postTypeId: posts?.id ?? "" })).entries;
	const [media] = (await admin.api.media.list({ siteId: newSiteId })).items;
	expect(rye?.draft.fields).toMatchObject({ category: bread?.id, photo: media?.id });
	expect(bread?.linkedFrom.map((link) => link.entryId)).toEqual([rye?.id ?? ""]);
});

test("references inside element trees point at the new items: the Component placed and the Media image", async () => {
	const { postTypes } = await admin.api.postTypes.list({ siteId: newSiteId });
	const posts = postTypes.find((type) => type.key === "posts");
	const [media] = (await admin.api.media.list({ siteId: newSiteId })).items;
	const { markup } = await admin.api.templates.getEntryTemplateMarkup({
		siteId: newSiteId,
		postTypeId: posts?.id ?? "",
	});
	// Template markup writes each element's own id (`data-wc-id`), which stays as it was in the tree.
	const written = markup?.draft.replace(/ data-wc-id="[^"]*"/g, "");
	expect(written).toBe(`<article><Badge /><img src="media:${media?.id}" alt="Loaf"></article>`);
});

test("a Module's data points at the new items: the Redirect rule's target", async () => {
	const [media] = (await admin.api.media.list({ siteId: newSiteId })).items;
	const { rules } = await moduleApi<typeof redirects>(admin, "redirects").rules.list({ siteId: newSiteId });
	expect(rules.map((rule) => [rule.from, rule.to])).toEqual([["/loaf.jpg", `media:${media?.id}`]]);
});
