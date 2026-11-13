import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install?.close();
});

test("the former published content stays recoverable when Revisions were off and the Draft differs", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("History")).id;
	const siteId = (await install.createSite(workspaceId, { slug: "history" })).id;
	const { postType } = await admin.api.postTypes.create({ siteId, key: "posts", name: "Posts", urlPattern: "/{slug}" });
	await admin.api.install.history.update({ revisionsOn: false });
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Published words" });
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await admin.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Unfinished words" });
	const archive = await exportedArchive(install, admin, siteId);
	const imported = await importArchive(install, admin, workspaceId, archive, { name: "Copy", slug: "copy" });
	expect(imported.status).toBe("done");
	const newSiteId = imported.site?.id ?? "";
	const posts = (await admin.api.postTypes.list({ siteId: newSiteId })).postTypes.find((type) => type.key === "posts");
	const [copy] = (await admin.api.entries.list({ siteId: newSiteId, postTypeId: posts?.id ?? "" })).entries;
	expect(copy?.draft.title).toBe("Unfinished words");
	expect(copy?.status).toBe("draft");
	const item = { kind: "entry" as const, id: copy?.id ?? "" };
	const history = await admin.api.history.list({ siteId: newSiteId, item });
	expect(history.copies).toHaveLength(1);
	const saved = await admin.api.history.get({
		siteId: newSiteId,
		item,
		copy: { type: "revision", id: history.copies[0]?.id ?? "" },
	});
	expect(JSON.stringify(saved.content)).toContain("Published words");

	const withoutDate = rewritten(archive, {
		rows: (table, rows) =>
			table === "public.entries" ? rows.map((row) => ({ ...row, published_at: null, last_published_at: null })) : rows,
	});
	const importedAt = install.clock.now();
	const untimed = await importArchive(install, admin, workspaceId, withoutDate, { name: "Undated", slug: "undated" });
	expect(untimed.status).toBe("done");
	const untimedSite = untimed.site?.id ?? "";
	const untimedType = (await admin.api.postTypes.list({ siteId: untimedSite })).postTypes.find(
		(type) => type.key === "posts",
	);
	const [untimedEntry] = (await admin.api.entries.list({ siteId: untimedSite, postTypeId: untimedType?.id ?? "" }))
		.entries;
	const untimedHistory = await admin.api.history.list({
		siteId: untimedSite,
		item: { kind: "entry", id: untimedEntry?.id ?? "" },
	});
	expect(untimedHistory.copies).toHaveLength(1);
	expect(untimedHistory.copies[0]?.at).toEqual(importedAt);
});
