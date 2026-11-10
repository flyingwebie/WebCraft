// Every action while impersonating is recorded under both names, "<Staff> as <Member>" (ADR 0008):
// in the Audit log, in the person's own activity (and the impersonator's), in Co-editing's presence
// and in history's "who changed it". Starting and stopping are recorded the same way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type CoEditingSite, coEditingSite, withValue } from "../co-editing/support.ts";
import { openDraft } from "../harness/co-editing.ts";
import { impersonate, type WithSecondFactor, withSecondFactor } from "../harness/impersonation.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let site: CoEditingSite;
let ada: WithSecondFactor<{ personId: string; browser: TestBrowser }>;
let owner: { personId: string; browser: TestBrowser };

beforeAll(async () => {
	install = await createTestInstall();
	site = await coEditingSite(install);
	ada = await withSecondFactor(install, { personId: site.staffId, browser: site.staff });
	owner = await install.createMember({ workspaceId: site.workspaceId, role: "owner", name: "Olive Owner" });
});

afterAll(async () => {
	await install.close();
});

const asAda = () => ({ kind: "impersonation", name: "Ada Staff", by: site.staffId }) as const;

describe("the Audit log", () => {
	test("records what is done as the Member under both names, with the start and the stop", async () => {
		await impersonate(ada.browser, site.editorId, { reason: "Ticket 4021" });
		await ada.browser.api.entries.saveDraft({ siteId: site.siteId, entryId: site.entryId, title: "Fresh bread, warm" });
		await ada.browser.api.entries.publish({ siteId: site.siteId, entryId: site.entryId });
		await install.clock.advance(10 * 60_000);
		await ada.browser.api.impersonation.stop();

		const { entries, people } = await owner.browser.api.audit.list({ workspaceId: site.workspaceId, limit: 3 });
		expect(entries.map((entry) => [entry.action, entry.personId, entry.via])).toEqual([
			["impersonation.stop", site.editorId, asAda()],
			["entry.publish", site.editorId, asAda()],
			["impersonation.start", site.editorId, asAda()],
		]);
		expect(entries[0]?.details).toMatchObject({ reason: "stopped", minutes: 10 });
		expect(entries[2]?.details).toMatchObject({
			impersonator: { id: site.staffId, name: "Ada Staff" },
			person: { id: site.editorId, name: "Eve Editor" },
			reason: "Ticket 4021",
		});
		// The page names both people.
		expect(people[site.editorId]?.name).toBe("Eve Editor");
		expect(people[site.staffId]?.name).toBe("Ada Staff");
	});

	test("filtering by who finds what Staff did as someone else", async () => {
		const { entries } = await owner.browser.api.audit.list({ workspaceId: site.workspaceId, personId: site.staffId });

		expect(entries.map((entry) => entry.action)).toEqual(
			expect.arrayContaining(["impersonation.start", "entry.publish", "impersonation.stop"]),
		);
	});

	test("the hour running out is recorded as its end", async () => {
		await impersonate(ada.browser, site.authorId);
		await install.clock.advance(61 * 60_000);
		await install.drainJobs();

		const [stop] = (await owner.browser.api.audit.list({ workspaceId: site.workspaceId, action: "impersonation.stop" }))
			.entries;
		expect(stop).toMatchObject({ personId: site.authorId, via: asAda(), details: { reason: "time", minutes: 60 } });
	});
});

describe("a person's own activity", () => {
	test("lists what Staff did as them, under both names", async () => {
		const { entries } = await site.editor.api.me.activity({});

		expect(entries.filter((entry) => entry.via.kind === "impersonation").map((entry) => entry.action)).toEqual([
			"impersonation.stop",
			"entry.publish",
			"impersonation.start",
		]);
	});

	test("lists what the impersonator did as others too", async () => {
		const { entries } = await ada.browser.api.me.activity({ limit: 200 });

		expect(entries.map((entry) => [entry.action, entry.personId])).toEqual(
			expect.arrayContaining([
				["entry.publish", site.editorId],
				["impersonation.start", site.authorId],
			]),
		);
	});

	test("pages through, newest first", async () => {
		const first = await site.editor.api.me.activity({ limit: 1 });
		const second = await site.editor.api.me.activity({ limit: 1, after: first.next ?? "" });

		expect([first.entries[0]?.action, second.entries[0]?.action]).toEqual(["impersonation.stop", "entry.publish"]);
	});
});

describe("Drafts", () => {
	test("presence and history show who changed it as '<Staff> as <Member>'", async () => {
		const item = { kind: "entry", id: site.entryId } as const;
		const watcher = await openDraft(install, site.author, site.siteId, item);
		await impersonate(ada.browser, site.editorId);
		const editor = await openDraft(install, ada.browser, site.siteId, item);

		await watcher.until(
			() =>
				watcher.participants().some((someone) => someone.name === "Eve Editor" && someone.impersonator === "Ada Staff"),
			"the impersonated Editor in the Author's list",
		);
		editor.change((draft) => withValue(draft, "summary", "Changed as Eve"));
		await editor.saved();

		const { copies } = await site.editor.api.history.list({ siteId: site.siteId, item });
		const revisionId = copies.find((copy) => copy.type === "revision")?.id ?? "";
		const comparison = await site.editor.api.history.compare({
			siteId: site.siteId,
			item,
			copy: { type: "revision", id: revisionId },
		});
		expect(comparison.parts.find((part) => part.key === "summary")?.changedBy).toMatchObject({
			person: { id: site.editorId, name: "Eve Editor" },
			via: asAda(),
			impersonator: "Ada Staff",
			client: null,
		});
		watcher.close();
		editor.close();
		await ada.browser.api.impersonation.stop();
	});

	test("a Draft opened while impersonating closes when it stops", async () => {
		const item = { kind: "entry", id: site.entryId } as const;
		await impersonate(ada.browser, site.editorId);
		const editor = await openDraft(install, ada.browser, site.siteId, item);

		await ada.browser.api.impersonation.stop();
		editor.change((draft) => withValue(draft, "summary", "After the stop"));

		await editor.until(() => editor.status() === "ended", "the editor to end");
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.summary).not.toBe("After the stop");
	});
});
