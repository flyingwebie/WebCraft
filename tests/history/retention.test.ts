// Retention (Install settings › Revisions): Revisions are kept 90 days and at least each item's newest 50
// (whichever keeps more), Checkpoints 30 days; the Superadmin changes these and may turn Revisions off for
// the Install; Staff turn them off per Post Type. Turning them off stops new ones; those saved before stay
// and follow the same rules. A daily job prunes what is past them, and the history of deleted items.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { type HistorySite, historySite } from "./support.ts";

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
});

afterAll(async () => {
	await install.close();
});

const DAY = 24 * 60 * 60 * 1000;

/** An Entry published `times` times, a minute apart. */
async function publishedEntry(site: HistorySite, times: number): Promise<string> {
	const { siteId, postTypeId, editor } = site;
	const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Loaf 0" });
	for (let n = 1; n <= times; n++) {
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: `Loaf ${n}` });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		await install.clock.advance(60_000);
	}
	return entry.id;
}

/** The types of an Entry's saved copies, newest first, read by a Superadmin signed in now (days pass in these tests). */
async function typesIn(site: HistorySite, entryId: string): Promise<string[]> {
	const { api } = await install.superadmin();
	const { copies } = await api.history.list({ siteId: site.siteId, item: { kind: "entry", id: entryId } });
	return copies.map((copy) => copy.type);
}

describe("Install settings › Revisions", () => {
	test("start at 90 days and the newest 50 for Revisions, 30 days for Checkpoints; only the Superadmin changes them", async () => {
		expect(await admin.api.install.history.get()).toEqual({
			revisionsOn: true,
			revisionDays: 90,
			revisionsKept: 50,
			checkpointDays: 30,
		});
		const site = await historySite(install);
		await expect(site.staff.api.install.history.update({ revisionDays: 10 })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(admin.api.install.history.update({ revisionDays: 0 })).rejects.toMatchObject({ status: 400 });

		const changed = await admin.api.install.history.update({ revisionDays: 120, checkpointDays: 7 });
		expect(changed).toEqual({ revisionsOn: true, revisionDays: 120, revisionsKept: 50, checkpointDays: 7 });
		const { entries } = await admin.api.audit.list({ limit: 5 });
		expect(entries[0]).toMatchObject({
			action: "historySettings.change",
			details: { revisionDays: { from: 90, to: 120 }, checkpointDays: { from: 30, to: 7 } },
		});
		await admin.api.install.history.update({ revisionDays: 90, checkpointDays: 30 });
	});
});

describe("pruning", () => {
	test("keeps Revisions within the days kept, and each item's newest ones however old; Checkpoints go after their days", async () => {
		const site = await historySite(install);
		await admin.api.install.history.update({ revisionDays: 10, revisionsKept: 2, checkpointDays: 3 });
		try {
			const many = await publishedEntry(site, 4);
			const few = await publishedEntry(site, 1);
			// A Checkpoint of `few`'s Draft, left alone.
			await site.editor.api.entries.saveDraft({ siteId: site.siteId, entryId: few, title: "Loaf left" });
			await site.editor.api.history.leave({ siteId: site.siteId, item: { kind: "entry", id: few } });
			expect(await typesIn(site, many)).toEqual(["revision", "revision", "revision", "revision"]);

			// Within the days kept, nothing goes.
			await install.clock.advance(2 * DAY);
			await install.drainJobs();
			expect(await typesIn(site, many)).toHaveLength(4);
			expect(await typesIn(site, few)).toEqual(["checkpoint", "revision"]);

			// Past them: Checkpoints go; Revisions past their days go unless among the newest 2.
			await install.clock.advance(20 * DAY);
			await install.drainJobs();
			expect(await typesIn(site, many)).toEqual(["revision", "revision"]);
			expect(await typesIn(site, few)).toEqual(["revision"]);
			const { api } = await install.superadmin();
			const { copies } = await api.history.list({ siteId: site.siteId, item: { kind: "entry", id: many } });
			const newest = await api.history.get({
				siteId: site.siteId,
				item: { kind: "entry", id: many },
				copy: { type: "revision", id: copies[0]?.id ?? "" },
			});
			expect(JSON.stringify(newest.content)).toContain("Loaf 4");
		} finally {
			await (await install.superadmin()).api.install.history.update({
				revisionDays: 90,
				revisionsKept: 50,
				checkpointDays: 30,
			});
		}
	});

	test("removes the history of an item once it is deleted", async () => {
		const site = await historySite(install);
		const entryId = await publishedEntry(site, 2);
		const deleting = await site.editor.api.entries.delete({ siteId: site.siteId, entryId });
		await site.editor.api.entries.delete({
			siteId: site.siteId,
			entryId,
			confirmation: (deleting as { confirmation: { id: string } }).confirmation.id,
		});
		await install.clock.advance(DAY);
		await install.drainJobs();
		// The Audit log keeps what happened, and finished jobs keep their payloads for a while; history goes.
		const holding = await install.tablesHolding(entryId);
		expect(holding.filter((table) => !["public.audit_log", "pgboss.job"].includes(table))).toEqual([]);
	});
});

describe("turning Revisions off", () => {
	test("for a Post Type stops new ones for its Entries only; those saved before stay", async () => {
		const site = await historySite(install);
		const { siteId, postTypeId, staff, editor } = site;
		const entryId = await publishedEntry(site, 1);
		const other = await staff.api.postTypes.create({ siteId, name: "Recipes", urlPattern: "/recipes/{slug}" });

		await expect(editor.api.postTypes.update({ siteId, postTypeId, revisions: false })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const { postType } = await staff.api.postTypes.update({ siteId, postTypeId, revisions: false });
		expect(postType.revisions).toBe(false);

		await editor.api.entries.saveDraft({ siteId, entryId, title: "Loaf again" });
		await editor.api.entries.publish({ siteId, entryId });
		const history = await editor.api.history.list({ siteId, item: { kind: "entry", id: entryId } });
		expect(history.revisions).toEqual({ on: false, off: "postType" });
		expect(history.copies.filter((copy) => copy.type === "revision")).toHaveLength(1);

		const { entry: recipe } = await editor.api.entries.create({
			siteId,
			postTypeId: other.postType.id,
			title: "Scones",
		});
		await editor.api.entries.publish({ siteId, entryId: recipe.id });
		const recipes = await editor.api.history.list({ siteId, item: { kind: "entry", id: recipe.id } });
		expect(recipes.revisions).toEqual({ on: true, off: null });
		expect(recipes.copies.map((copy) => copy.type)).toEqual(["revision"]);
	});

	test("for the Install stops every new one; Checkpoints are still saved", async () => {
		const site = await historySite(install);
		const { siteId, editor } = site;
		const entryId = await publishedEntry(site, 1);
		await (await install.superadmin()).api.install.history.update({ revisionsOn: false });
		try {
			await editor.api.entries.saveDraft({ siteId, entryId, title: "Loaf, no history" });
			await editor.api.entries.publish({ siteId, entryId });
			await install.clock.advance(60_000);
			await editor.api.entries.saveDraft({ siteId, entryId, title: "Loaf, edited" });
			await editor.api.history.leave({ siteId, item: { kind: "entry", id: entryId } });
			const history = await editor.api.history.list({ siteId, item: { kind: "entry", id: entryId } });
			expect(history.revisions).toEqual({ on: false, off: "install" });
			expect(history.copies.map((copy) => copy.reason ?? copy.type)).toEqual(["left", "revision"]);
		} finally {
			await (await install.superadmin()).api.install.history.update({ revisionsOn: true });
		}
	});
});
