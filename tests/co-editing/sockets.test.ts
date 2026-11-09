// Who may open a Draft's socket, from where, and how much they may send (ADR 0025): the upgrade checks
// the admin session (or Edit mode's cookie and header token) and the page's origin, as every request
// carrying a cookie must; the data layer decides which Drafts a person reaches, so another
// Workspace's never opens; each connection has limits on message size and rate, and each person on
// the documents they have open. Several web processes share documents through Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DRAFT_LIMITS, DRAFTS_PROTOCOL, encodeFrame } from "@webcraft/core";

import { openDraft, upgradeDraft, upgradeDraftInEditMode } from "../harness/co-editing.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { coEditingSite, valueIn, withValue } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

/** The status of a refused upgrade (a socket accepted fails the test). */
async function refusedWith(answer: Promise<unknown>): Promise<number> {
	const got = await answer;
	if (!(got instanceof Response)) throw new Error("The socket opened.");
	return got.status;
}

describe("opening a Draft from the admin", () => {
	test("needs a signed-in person, WebCraft's subprotocol and the admin's own pages", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		expect(await refusedWith(upgradeDraft(install, install.browser(), site.siteId, item))).toBe(401);
		expect(
			await refusedWith(upgradeDraft(install, site.staff, site.siteId, item, { origin: "https://attacker.example" })),
		).toBe(403);
		expect(await refusedWith(upgradeDraft(install, site.staff, site.siteId, item, { origin: null }))).toBe(403);
		expect(await refusedWith(upgradeDraft(install, site.staff, site.siteId, item, { protocols: ["chat"] }))).toBe(400);
		const plain = await site.staff.request(install.adminUrl(`/api/drafts/${site.siteId}/entry/${site.entryId}`));
		expect(plain.status).not.toBe(101);
		const notUpgrade = await install.upgrade(
			new Request(install.adminUrl(`/api/drafts/${site.siteId}/entry/${site.entryId}`)),
		);
		expect(notUpgrade instanceof Response && notUpgrade.status).toBe(426);
	});

	test("never opens another Workspace's Draft, nor an item the person may not read", async () => {
		const site = await coEditingSite(install);
		const other = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		// Staff of another Workspace, and a Member of it, can't tell the Draft exists.
		expect(await refusedWith(upgradeDraft(install, other.staff, site.siteId, item))).toBe(404);
		expect(await refusedWith(upgradeDraft(install, other.editor, site.siteId, item))).toBe(404);
		// Nor through their own Site with this Site's Entry.
		expect(await refusedWith(upgradeDraft(install, other.staff, other.siteId, item))).toBe(404);
		// An unknown item, or a kind that can't be co-edited.
		expect(
			await refusedWith(upgradeDraft(install, site.staff, site.siteId, { kind: "entry", id: crypto.randomUUID() })),
		).toBe(404);
		const unknownKind = await site.staff.openSocket(
			install.adminUrl(`/api/drafts/${site.siteId}/loop/${site.entryId}`),
			{
				protocols: [DRAFTS_PROTOCOL],
			},
		);
		expect(unknownKind instanceof Response && unknownKind.status).toBe(404);

		// Structure is Staff's: a Member never opens a Template's Draft.
		const saved = await site.staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		const template = { kind: "template", id: saved.template.id } as const;
		expect(await refusedWith(upgradeDraft(install, site.editor, site.siteId, template))).toBe(403);
		const staffEditor = await openDraft(install, site.staff, site.siteId, template);
		expect(JSON.stringify(staffEditor.draft())).toContain("article");
		staffEditor.close();
	});

	test("ends when the person signs out", async () => {
		const site = await coEditingSite(install);
		const editor = await openDraft(install, site.editor, site.siteId, { kind: "entry", id: site.entryId });
		await site.editor.api.session.signOut();
		editor.change((draft) => withValue(draft, "summary", "After signing out"));
		await editor.until(() => editor.status() === "ended", "the editor to end");
		expect(editor.messages.at(-1)).toEqual({ type: "ended", code: "SESSION_ENDED" });
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.summary).toBe("Bake it today.");
	});
});

describe("opening a Draft in Edit mode", () => {
	test("needs the edit cookie, the session's header token and the Site's own pages", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const edit = await openEditMode(install, site.editor, site.siteId, "/");
		expect(await refusedWith(upgradeDraftInEditMode(edit, item, { token: null }))).toBe(403);
		expect(await refusedWith(upgradeDraftInEditMode(edit, item, { token: "0".repeat(64) }))).toBe(403);
		expect(await refusedWith(upgradeDraftInEditMode(edit, item, { origin: "https://attacker.example" }))).toBe(403);
		const accepted = await upgradeDraftInEditMode(edit, item);
		expect(accepted instanceof Response).toBe(false);

		// Another Site's Entry is no Draft of this Site.
		const other = await coEditingSite(install);
		expect(await refusedWith(upgradeDraftInEditMode(edit, { kind: "entry", id: other.entryId }))).toBe(404);
	});
});

describe("limits", () => {
	test("a message over the size limit ends the connection", async () => {
		const site = await coEditingSite(install);
		const editor = await openDraft(install, site.editor, site.siteId, { kind: "entry", id: site.entryId });
		const answer = await upgradeDraft(install, site.editor, site.siteId, { kind: "entry", id: site.entryId });
		if (answer instanceof Response) throw new Error("The socket didn't open.");
		const sent: (string | Uint8Array)[] = [];
		const closed: number[] = [];
		const session = answer.open({ send: (data) => sent.push(data), close: (code) => closed.push(code) });
		session.receive(encodeFrame("change", new Uint8Array(DRAFT_LIMITS.messageBytes + 1), 1));
		expect(closed).toEqual([1009]);
		expect(sent.at(-1)).toBe(JSON.stringify({ type: "ended", code: "MESSAGE_TOO_LARGE" }));
		editor.close();
	});

	test("too many messages a minute end the connection", async () => {
		const site = await coEditingSite(install);
		const answer = await upgradeDraft(install, site.editor, site.siteId, { kind: "entry", id: site.entryId });
		if (answer instanceof Response) throw new Error("The socket didn't open.");
		const closed: number[] = [];
		const sent: (string | Uint8Array)[] = [];
		const session = answer.open({ send: (data) => sent.push(data), close: (code) => closed.push(code) });
		for (let n = 0; n <= DRAFT_LIMITS.messagesPerMinute; n++) {
			session.receive(JSON.stringify({ type: "presence", at: null }));
		}
		expect(closed).toEqual([1008]);
		expect(sent.at(-1)).toBe(JSON.stringify({ type: "ended", code: "TOO_MANY_MESSAGES" }));
	});

	test("one person may have only so many Drafts open at once", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const sessions = [];
		for (let n = 0; n < DRAFT_LIMITS.openPerPerson; n++) {
			const answer = await upgradeDraft(install, site.editor, site.siteId, item);
			if (answer instanceof Response) throw new Error(`Socket ${n} didn't open: ${answer.status}`);
			sessions.push(answer.open({ send: () => {}, close: () => {} }));
		}
		expect(await refusedWith(upgradeDraft(install, site.editor, site.siteId, item))).toBe(429);
		// Someone else still opens it.
		const ada = await openDraft(install, site.staff, site.siteId, item);
		ada.close();
		sessions[0]?.closed();
		const again = await upgradeDraft(install, site.editor, site.siteId, item);
		expect(again instanceof Response).toBe(false);
		for (const session of sessions) session.closed();
	});
});

describe("several web processes", () => {
	test("share each Draft through Postgres: changes and presence reach the editors of the other", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const second = install.webProcess();
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item, { through: second.upgrade });

		ada.change((draft) => withValue(draft, "title", "From the first process"));
		eve.change((draft) => withValue(draft, "summary", "From the second process"));
		await ada.saved();
		await eve.saved();
		await ada.untilDraft(
			(draft) => valueIn(draft, "summary") === "From the second process",
			"the second's change at Ada's",
		);
		await eve.untilDraft(
			(draft) => valueIn(draft, "title") === "From the first process",
			"the first's change at Eve's",
		);

		eve.place("summary");
		await ada.until(
			() => ada.participants().some((someone) => someone.name === "Eve Editor" && someone.at === "summary"),
			"Eve (on the second process) at Ada's",
		);
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("From the first process");
		expect(entry.draft.fields.summary).toBe("From the second process");
		ada.close();
		eve.close();
	});
});
