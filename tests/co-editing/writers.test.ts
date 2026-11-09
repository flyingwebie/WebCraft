// Every Draft writer goes through the shared document (ADR 0025): API tokens and AI clients as named
// participants ("<person> via <client>"), AI translation, restores, Edit mode's saves and publishing.
// Nothing writes a Draft behind the document's back, so a person editing live never loses what they
// typed to another write of the same Draft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { openDraft, openDraftInEditMode } from "../harness/co-editing.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { freshBread, translatedSite } from "../translation/support.ts";
import { coEditingSite, valueIn, withValue } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

describe("an API client writing a Draft someone edits live", () => {
	test("changes only what it wrote, reaches the editor at once, and shows as <person> via <client>", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const eve = await openDraft(install, site.editor, site.siteId, item);
		const { secret } = await createApiToken(site.staff, { workspaceId: site.workspaceId, name: "Deploy script" });
		const script = tokenClient(install, secret);

		// Eve types a summary; before it reaches anyone, the script saves the title.
		eve.change((draft) => withValue(draft, "summary", "Typed live by Eve"));
		await script.api.entries.saveDraft({ siteId: site.siteId, entryId: site.entryId, title: "Saved by a script" });
		await eve.saved();
		await eve.untilDraft((draft) => valueIn(draft, "title") === "Saved by a script", "the script's title at Eve's");
		expect(valueIn(eve.draft(), "summary")).toBe("Typed live by Eve");
		await eve.until(
			() => eve.participants().some((someone) => someone.name === "Ada Staff" && someone.via === "Deploy script"),
			"Ada Staff via Deploy script among the participants",
		);

		const { entry } = await site.editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("Saved by a script");
		expect(entry.draft.fields.summary).toBe("Typed live by Eve");

		// The same value: the script's whole value replaces what was there, and Eve's copy follows it.
		await script.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: site.entryId,
			fields: { summary: "Set by the script" },
		});
		await eve.untilDraft((draft) => valueIn(draft, "summary") === "Set by the script", "the script's summary at Eve's");
		eve.change((draft) => withValue(draft, "summary", "Set by the script, then Eve"));
		await eve.saved();
		const after = await site.editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(after.entry.draft.fields.summary).toBe("Set by the script, then Eve");
		eve.close();
	});
});

describe("publishing a Draft someone edits live", () => {
	test("publishes it as it is, and the editors see who published it", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const al = await openDraft(install, site.author, site.siteId, item);

		al.change((draft) => withValue(draft, "summary", "Ready to go"));
		await al.saved();
		const { entry } = await site.editor.api.entries.publish({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.published?.fields.summary).toBe("Ready to go");
		expect(entry.status).toBe("published");

		for (const editor of [ada, al]) {
			await editor.until(
				() => editor.messages.some((message) => message.type === "published"),
				"the publish at each editor",
			);
			expect(editor.messages.find((message) => message.type === "published")).toEqual({
				type: "published",
				by: { personId: site.editorId, name: "Eve Editor", via: null },
			});
		}
		ada.close();
		al.close();
	});
});

describe("a restore into a Draft someone edits live", () => {
	test("is one more change to the shared Draft", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: site.entryId });
		const eve = await openDraft(install, site.editor, site.siteId, item);
		eve.change((draft) => withValue(draft, "summary", "Changed my mind"));
		await eve.saved();

		const { copies } = await site.staff.api.history.list({ siteId: site.siteId, item });
		const revision = copies.find((copy) => copy.type === "revision");
		if (!revision) throw new Error("The publish saved no Revision.");
		await site.staff.api.history.restore({ siteId: site.siteId, item, copy: { type: "revision", id: revision.id } });
		await eve.untilDraft((draft) => valueIn(draft, "summary") === "Bake it today.", "the restored summary at Eve's");
		eve.close();
	});
});

describe("Edit mode", () => {
	test("opens the Draft on the Site's own domain, and its saves reach the admin's editors", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const edit = await openEditMode(install, site.editor, site.siteId, "/");
		const inPlace = await openDraftInEditMode(edit, item);
		expect(valueIn(inPlace.draft(), "title")).toBe("Fresh bread");

		inPlace.change((draft) => withValue(draft, "title", "Fresh bread, edited in place"));
		await inPlace.saved();
		await ada.untilDraft((draft) => valueIn(draft, "title") === "Fresh bread, edited in place", "the change at Ada's");

		// The editing bar's own save goes through the shared document too.
		const saved = await edit.edit("save", {
			item: `entry:${site.entryId}`,
			field: "summary",
			value: "Saved by the bar",
		});
		expect(saved.status).toBe(200);
		await ada.untilDraft((draft) => valueIn(draft, "summary") === "Saved by the bar", "the bar's save at Ada's");
		await inPlace.untilDraft((draft) => valueIn(draft, "summary") === "Saved by the bar", "the bar's save in place");
		ada.close();
		inPlace.close();
	});
});

describe("AI translation writing a Draft someone edits live", () => {
	test("its values reach the editor and it shows among the participants", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		const item = { kind: "entry", id: entryId } as const;
		const editor = await openDraft(install, site.editor, site.siteId, item);
		editor.change((draft) => withValue(draft, "summary", "Crusty sourdough, typed live"));
		await editor.saved();

		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		expect((await install.drainJobs()).failed).toEqual([]);
		await editor.untilDraft(
			(draft) => typeof valueIn(draft, "title", "it") === "string",
			"the Italian title AI translation wrote, at the editor's",
		);
		expect(valueIn(editor.draft(), "title", "it")).toBe("[it] Fresh bread");
		expect(valueIn(editor.draft(), "summary")).toBe("Crusty sourdough, typed live");
		expect(editor.participants().some((someone) => someone.translation === true)).toBe(true);
		editor.close();
	});
});
