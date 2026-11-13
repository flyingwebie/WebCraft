// Access that moves while a Draft's socket stays open (ADR 0025, hub.ts): before the fix,
// `connection.editable` was read once in `open()`'s welcome and never refreshed, so access granted
// after that needed a reconnect before an edit went through, and access taken away was refused
// (FORBIDDEN) by a stale `editable: true` connection without ever telling the editor its state had
// moved. No built-in role moves `site.view` and `entry.edit` apart (every one of `owner`, `editor`,
// `author`, `staff` and `superadmin` holds both together: `permissions/roles.ts`), so a real admin or
// Edit mode session never shows the gap. A Module actor does: `can()` always gives it `site.view` (a
// Module's own place) and `entry.edit` only when it is listed among what it adds. This test opens the
// hub directly with one (`install.openDraftWithAccess`, see its doc on `TestInstall`), through the
// same `attach`/`SocketSession` contract and the same client the admin uses (`editorOver`); past
// `access`/`recheck`, everything is the real hub, the real document, the real save.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Access, DRAFTS_PROTOCOL, type HistoryItem } from "@webcraft/core";

import { editorOver, openDraft, type TestEditor } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { coEditingSite, withValue } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

/** A Module's access to a Site: `site.view` always (its own place), `entry.edit` only when listed. */
function moduleAccess(workspaceId: string, siteId: string, editable: boolean): Access {
	return {
		actor: {
			kind: "module",
			moduleId: "test-probe",
			permissions: editable ? ["entry.edit"] : [],
			place: { level: "site", workspaceId, siteId },
		},
		via: { kind: "module", name: "Test module" },
	};
}

/**
 * Opens an item's Draft through `openDraftWithAccess`, adapted to the `{protocol, open}` shape a
 * WebSocket upgrade answers with (`sockets.ts`'s `accept` does exactly this), so `editorOver` gives
 * back the same kind of editor `openDraft` does, over a Module's access that `editableNow` controls.
 */
function moverOver(
	workspaceId: string,
	siteId: string,
	item: HistoryItem,
	editableNow: () => boolean,
): Promise<TestEditor> {
	return editorOver(async () => {
		const opened = await install.openDraftWithAccess({
			siteId,
			item,
			access: moduleAccess(workspaceId, siteId, editableNow()),
			recheck: async () => moduleAccess(workspaceId, siteId, editableNow()),
		});
		return { protocol: DRAFTS_PROTOCOL, open: (peer) => opened.attach(peer) };
	});
}

describe("a connection whose access moves while it stays open", () => {
	test("gains edit access, and can edit at once, without reconnecting", async () => {
		const site = await coEditingSite(install);
		let editableNow = false;
		const item = { kind: "entry", id: site.entryId } as const;
		const mover = await moverOver(site.workspaceId, site.siteId, item, () => editableNow);
		expect(mover.messages[0]).toMatchObject({ type: "welcome", editable: false });
		expect(mover.status()).toBe("readOnly");
		// Locked locally too: the client itself won't send a change while it thinks it can't.
		expect(mover.change((draft) => withValue(draft, "summary", "Too soon"))).toBe(false);

		editableNow = true;
		// A presence update isn't held back by read-only, and it re-reads access like any other message:
		// the person moving their cursor is enough to notice access widened, without a reconnect.
		mover.place("summary");
		await mover.until(() => mover.status() !== "readOnly", "unlocked once access widened");
		expect(mover.messages).toContainEqual({ type: "editable", editable: true });

		// A value set back to exactly what it already is nets to no change (`sameValue`): the item's own
		// save (which always records who wrote a value, something only a person can be) is never
		// attempted, so this proves the gate and the round trip the fix is about, without needing a
		// person. `applyChange` refusing it with FORBIDDEN is exactly the bug: it no longer does.
		expect(mover.change((draft) => withValue(draft, "summary", "Bake it today., typing"))).toBe(true);
		expect(mover.change((draft) => withValue(draft, "summary", "Bake it today."))).toBe(true);
		await mover.saved();
		expect(mover.refusals).toEqual([]);
		mover.close();
	});

	test("narrowed to read-only: refused, and told, without the session ending", async () => {
		const site = await coEditingSite(install);
		let editableNow = true;
		const item = { kind: "entry", id: site.entryId } as const;
		const mover = await moverOver(site.workspaceId, site.siteId, item, () => editableNow);
		expect(mover.messages[0]).toMatchObject({ type: "welcome", editable: true });

		editableNow = false;
		mover.change((draft) => withValue(draft, "summary", "Too late"));
		await mover.until(() => mover.refusals.length === 1, "the refusal");
		expect(mover.refusals[0]?.code).toBe("FORBIDDEN");
		expect(mover.messages).toContainEqual({ type: "editable", editable: false });
		await mover.until(() => mover.status() === "readOnly", "locked once told");
		// Only edit access moved, not read access: the session itself never ends.
		expect(mover.closedWith()).toBeNull();

		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.summary).toBe("Bake it today.");
		mover.close();
	});
});

describe("the last one leaving", () => {
	test("keeps the Draft as a Checkpoint only for someone who may edit it: a reader leaving writes nothing", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		await site.staff.api.entries.saveDraft({ siteId: site.siteId, entryId: site.entryId, title: "Changed since" });

		const reader = await moverOver(site.workspaceId, site.siteId, item, () => false);
		reader.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		// Then someone who may edit opens and leaves: their leaving keeps the Draft, unless the reader's did.
		const ada = await openDraft(install, site.staff, site.siteId, item);
		ada.close();
		let copies: { type: string; reason: string | null; by?: { person?: { name: string } | null } | null }[] = [];
		const started = Date.now();
		while (Date.now() - started < 3000) {
			({ copies } = await site.staff.api.history.list({ siteId: site.siteId, item }));
			if (copies.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(copies.map((copy) => [copy.type, copy.reason, copy.by?.person?.name])).toEqual([
			["checkpoint", "left", "Ada Staff"],
		]);
	});
});
