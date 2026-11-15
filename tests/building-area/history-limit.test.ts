// The tab's Undo history (`ui/editor/editor-history.ts`, one instance in the building area's shell):
// - it keeps the last 200 finished steps, and Undo goes back through exactly those;
// - a new step after Undo ends Redo;
// - typing while Redo waits for its save still leaves 200 steps at most;
// - typing while a compound action (a Class being made) is under way is a step of its own.
// The shell-free counterpart of `editor-history.browser.ts` 475, 521 and 822, whose 201 saved steps
// through the old Builder's markup box the building area's boxes can't make (they save only markup
// that reads).
import { describe, expect, test } from "bun:test";
import type { Json } from "@webcraft/core/draft-document";

import { EditorHistory, type HistoryLocation } from "../../apps/server/src/ui/editor/editor-history.ts";

const where: HistoryLocation = { siteId: "site", panel: "html", title: "Home" };

/** A Draft of one number, its history port, and every value it was set to. */
function counter(history: EditorHistory, resource = "draft:counter") {
	const draft = { value: 0 as Json, writes: [] as Json[], held: null as Promise<void> | null };
	history.register(resource, {
		async reverse(from, to) {
			if (draft.held) await draft.held;
			if (draft.value !== from) return { ok: false, code: "HISTORY_OBSOLETE" };
			draft.value = to;
			draft.writes.push(to);
			return { ok: true, before: from, after: to };
		},
	});
	const step = (to: number) => {
		const before = draft.value;
		draft.value = to;
		history.record({ resource, before, after: to, label: `Typed ${to}`, location: where });
	};
	return { draft, step };
}

describe("the tab's Undo history", () => {
	test("keeps only the last 200 steps; Undo takes back exactly those, then nothing", async () => {
		const history = new EditorHistory();
		const { draft, step } = counter(history);
		for (let n = 1; n <= 201; n++) step(n);
		expect(history.state().undo).toBe("Typed 201");
		for (let n = 200; n >= 1; n--) await history.undo();
		// The first step fell out of the history: the Draft is back at what step 2 found.
		expect(draft.value).toBe(1);
		expect(history.state().undo).toBeNull();
		await history.undo();
		expect(draft.value).toBe(1);
		// Redo goes forward again; a new step ends Redo.
		await history.redo();
		expect(draft.value).toBe(2);
		expect(history.state().redo).toBe("Typed 3");
		step(42);
		expect(history.state()).toMatchObject({ undo: "Typed 42", redo: null });
		await history.undo();
		expect(draft.value).toBe(2);
	});

	test("typing while Redo waits for its save still leaves 200 steps at most", async () => {
		const history = new EditorHistory();
		const { draft, step } = counter(history);
		for (let n = 1; n <= 200; n++) step(n);
		await history.undo();
		expect(draft.value).toBe(199);
		// Redo's write is held; meanwhile something else is typed elsewhere.
		const held = Promise.withResolvers<void>();
		draft.held = held.promise;
		const redone = history.redo();
		const other = counter(history, "draft:other");
		for (let n = 1; n <= 5; n++) other.step(n);
		draft.held = null;
		held.resolve();
		await redone;
		let steps = 0;
		while (history.state().undo !== null) {
			await history.undo();
			steps++;
			if (steps > 400) break;
		}
		expect(steps).toBeLessThanOrEqual(200);
	});

	test("typing while a compound action is under way is a step of its own", async () => {
		const history = new EditorHistory();
		const { draft, step } = counter(history);
		const classes = counter(history, "draft:classes");
		const release = Promise.withResolvers<void>();
		const making = history.compound("Create Class lead", async (id) => {
			classes.draft.value = 1;
			history.record({
				resource: "draft:classes",
				before: 0,
				after: 1,
				label: "Create Class lead",
				location: where,
				step: id,
			});
			await release.promise;
		});
		// Typed while the Class is being made.
		step(7);
		release.resolve();
		await making;
		expect(history.state().undo).toBe("Typed 7");
		await history.undo();
		expect(draft.value).toBe(0);
		expect(classes.draft.value).toBe(1);
		expect(history.state().undo).toBe("Create Class lead");
		await history.undo();
		expect(classes.draft.value).toBe(0);
	});
});
