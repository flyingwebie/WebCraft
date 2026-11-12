// What a shared document holds after a change is saved (ADR 0025, audit A3-1): the Draft as the save
// stored it. An editor's socket takes any Yjs update, so someone who may edit a Draft can send rich
// text no editor of the admin would write (a script, an `onerror` handler). The save cleans it for
// the Draft's row; the document must hold the cleaned value too, because the other editors, the ones
// who open it later and the other web processes all read the document, and the admin shows what it
// holds. Tested over the web handler's WebSocket upgrade with the admin's own client.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";

import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { valueIn, valuesIn, withValue } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

/** Rich text no editor writes: a paragraph, then an image that runs script when it fails to load, and a script. */
const HOSTILE = '<p>Proof</p><img src="x" onerror="window.pwned = 1"><script>window.pwned = 2</script>';
/** What the rich text cleaner keeps of it. */
const CLEANED = "<p>Proof</p>";

let sites = 0;

/**
 * A Site whose Recipes hold a Summary (text), an Intro (rich text) and Notes (a Repeater of rich
 * text), with one Entry its Author wrote, and Globals holding a Notice (rich text).
 */
async function richTextSite(): Promise<{
	siteId: string;
	entryId: string;
	staff: TestBrowser;
	author: TestBrowser;
}> {
	const n = ++sites;
	const workspaceId = (await install.createWorkspace(`Cleaned ${n}`)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `cleaned-${n}` })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" })).browser;
	const author = (await install.createMember({ workspaceId, role: "author", name: "Al Author" })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "notes", label: "Notes", type: "repeater", fields: [{ key: "note", label: "Note", type: "richText" }] },
		],
	});
	await staff.api.globals.setFields({ siteId, fields: [{ key: "notice", label: "Notice", type: "richText" }] });
	const { entry } = await author.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	return { siteId, entryId: entry.id, staff, author };
}

/** The Draft with a row added to its Notes, as an editor adds one. */
function withNote(draft: DocumentJson, id: string, note: string): DocumentJson {
	const values = valuesIn(draft);
	const rows = (values.notes as { rows?: DocumentJson[] } | undefined)?.rows ?? [];
	return {
		...(draft as Record<string, DocumentJson>),
		values: { ...values, notes: { rows: [...rows, { id, values: { note: { en: note } } }] } },
	};
}

/** Whether anything the document holds still carries what the cleaner drops. */
function holdsScript(draft: DocumentJson): boolean {
	return /onerror|<script|<img/i.test(JSON.stringify(draft));
}

describe("rich text an editor sends over the socket", () => {
	test("reaches the other editors, later ones and the sender's own copy cleaned, as the Draft keeps it", async () => {
		const site = await richTextSite();
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const al = await openDraft(install, site.author, site.siteId, item);

		al.change((draft) => withNote(withValue(draft, "intro", HOSTILE), "row1", HOSTILE));
		await al.saved();
		expect(al.refusals).toEqual([]);

		// The Draft everyone else reads holds the cleaned values.
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.intro).toBe(CLEANED);
		expect(entry.draft.fields.notes).toEqual([{ id: "row1", note: CLEANED }]);

		// So does the document: at the editor who had it open, at the one who sent it, and at one opening it now.
		await ada.untilDraft((draft) => valueIn(draft, "intro") !== undefined, "Al's change at Ada's");
		expect(valueIn(ada.draft(), "intro")).toBe(CLEANED);
		expect(valuesIn(ada.draft()).notes).toEqual({ rows: [{ id: "row1", values: { note: { en: CLEANED } } }] });
		expect(holdsScript(ada.draft())).toBe(false);
		await al.untilDraft((draft) => !holdsScript(draft), "Al's own copy as the server keeps it");
		expect(valueIn(al.draft(), "intro")).toBe(CLEANED);
		const late = await openDraft(install, site.staff, site.siteId, item);
		expect(holdsScript(late.draft())).toBe(false);
		expect(valueIn(late.draft(), "intro")).toBe(CLEANED);
		ada.close();
		al.close();
		late.close();
	});

	test("is replayed cleaned to another web process", async () => {
		const site = await richTextSite();
		const item = { kind: "entry", id: site.entryId } as const;
		const other = await install.webProcess();
		const al = await openDraft(install, site.author, site.siteId, item);
		const ada = await openDraft(install, site.staff, site.siteId, item, { through: other.upgrade });

		al.change((draft) => withNote(draft, "row1", HOSTILE));
		await al.saved();
		await ada.untilDraft((draft) => "notes" in valuesIn(draft), "Al's row at Ada's, on the other process");
		expect(valuesIn(ada.draft()).notes).toEqual({ rows: [{ id: "row1", values: { note: { en: CLEANED } } }] });
		// One who opens it on that process once nobody has it open there reads the kept changes.
		ada.close();
		al.close();
		const later = await install.webProcess();
		const eve = await openDraft(install, site.staff, site.siteId, item, { through: later.upgrade });
		expect(holdsScript(eve.draft())).toBe(false);
		eve.close();
	});

	test("is cleaned in the Globals' document too", async () => {
		const site = await richTextSite();
		const item = { kind: "globals" } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.staff, site.siteId, item);

		eve.change((draft) => withValue(draft, "notice", HOSTILE));
		await eve.saved();
		await ada.untilDraft((draft) => valueIn(draft, "notice") !== undefined, "the notice at Ada's");
		expect(valueIn(ada.draft(), "notice")).toBe(CLEANED);
		await eve.untilDraft((draft) => valueIn(draft, "notice") === CLEANED, "the sender's own copy cleaned");
		const { globals } = await site.staff.api.globals.get({ siteId: site.siteId });
		expect(globals.draft.notice).toBe(CLEANED);
		ada.close();
		eve.close();
	});
});

describe("text someone is still typing", () => {
	test("keeps the space at its end in the document, while the Draft keeps it trimmed", async () => {
		const site = await richTextSite();
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const al = await openDraft(install, site.author, site.siteId, item);

		// Al is between two words: the save trims the value, his text box must not lose the space.
		al.change((draft) => withValue(withValue(draft, "summary", "Crusty "), "title", "Fresh bread "));
		await al.saved();
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.summary).toBe("Crusty");
		expect(entry.draft.title).toBe("Fresh bread");
		await ada.untilDraft((draft) => valueIn(draft, "summary") !== undefined, "Al's summary at Ada's");
		expect(valueIn(ada.draft(), "summary")).toBe("Crusty ");
		expect(valueIn(al.draft(), "summary")).toBe("Crusty ");
		expect(valueIn(al.draft(), "title")).toBe("Fresh bread ");

		al.change((draft) => withValue(draft, "summary", "Crusty and warm"));
		await al.saved();
		await ada.untilDraft((draft) => valueIn(draft, "summary") === "Crusty and warm", "the next word at Ada's");
		ada.close();
		al.close();
	});
});
