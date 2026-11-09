// Co-editing (ADR 0025, GLOSSARY.md › Co-editing): several people change the same Draft at once, with no
// locks, each seeing the others' changes as they are saved. Tested through the web handler's WebSocket
// upgrade with simulated editors (`tests/harness/co-editing.ts`), and what the API reads afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { coEditingSite, valueIn, valuesIn, withValue } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

const MINUTE = 60_000;

describe("two editors on one Draft", () => {
	test("each sees the Draft as it is, and the other's changes to other values as they are saved", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);
		expect(valueIn(ada.draft(), "title")).toBe("Fresh bread");
		expect(valueIn(eve.draft(), "summary")).toBe("Bake it today.");

		// Both change the Draft before either sees the other's change.
		ada.change((draft) => withValue(draft, "title", "Fresh rye bread"));
		eve.change((draft) => withValue(draft, "summary", "Bake it this morning."));
		await ada.saved();
		await eve.saved();
		await ada.untilDraft((draft) => valueIn(draft, "summary") === "Bake it this morning.", "Eve's summary at Ada's");
		await eve.untilDraft((draft) => valueIn(draft, "title") === "Fresh rye bread", "Ada's title at Eve's");

		// The Draft everyone else reads (the API, the Staging address) has both, each by who wrote it.
		const { entry } = await site.editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("Fresh rye bread");
		expect(entry.draft.fields.summary).toBe("Bake it this morning.");
		const comparison = await site.staff.api.history.list({ siteId: site.siteId, item });
		expect(comparison.item.name).toBe("Fresh rye bread");
		ada.close();
		eve.close();
	});

	test("two people typing in the same value keep both their words", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);

		ada.change((draft) => withValue(draft, "title", "Warm Fresh bread"));
		eve.change((draft) => withValue(draft, "title", "Fresh bread with seeds"));
		await ada.saved();
		await eve.saved();
		const both = "Warm Fresh bread with seeds";
		await ada.untilDraft((draft) => valueIn(draft, "title") === both, "both words at Ada's");
		await eve.untilDraft((draft) => valueIn(draft, "title") === both, "both words at Eve's");
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe(both);
		ada.close();
		eve.close();
	});

	test("rows of a Repeater and values of a Group merge, in every language", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.author, site.siteId, item);

		ada.change((draft) => ({
			values: {
				...valuesIn(draft),
				steps: {
					rows: [
						{ id: "knead", values: { text: { en: "Knead the dough" } } },
						{ id: "bake", values: { text: { en: "Bake for 40 minutes" } } },
					],
				},
			},
		}));
		await ada.saved();
		await eve.untilDraft((draft) => JSON.stringify(valuesIn(draft).steps).includes("bake"), "Ada's rows at Eve's");
		// Eve translates one step while Ada fills in the address.
		eve.change((draft) => {
			const steps = valuesIn(draft).steps as { rows: { id: string; values: Record<string, Record<string, string>> }[] };
			return {
				values: {
					...valuesIn(draft),
					steps: {
						rows: steps.rows.map((row) =>
							row.id === "knead" ? { ...row, values: { text: { ...row.values.text, fr: "Pétrir la pâte" } } } : row,
						),
					},
				},
			};
		});
		ada.change((draft) => ({ values: { ...valuesIn(draft), address: { values: { city: { en: "Cork" } } } } }));
		await ada.saved();
		await eve.saved();

		const english = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(english.entry.draft.fields.steps).toEqual([
			{ id: "knead", text: "Knead the dough" },
			{ id: "bake", text: "Bake for 40 minutes" },
		]);
		expect(english.entry.draft.fields.address).toEqual({ city: "Cork" });
		const french = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId, language: "fr" });
		expect(french.entry.draft.fields.steps).toEqual([
			{ id: "knead", text: "Pétrir la pâte" },
			{ id: "bake", text: "Bake for 40 minutes" },
		]);
		ada.close();
		eve.close();
	});
});

describe("a change the server refuses", () => {
	test("is dropped for everyone, and its editor starts again from the Draft as the server holds it", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);

		// Minutes is a whole number: words are the wrong kind of value, refused as the API refuses them.
		eve.change((draft) => withValue(draft, "minutes", "a long while"));
		await eve.until(() => eve.refusals.length === 1, "the refusal");
		expect(eve.refusals[0]).toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "fields.minutes" }] } });
		await eve.untilDraft((draft) => valueIn(draft, "minutes") === undefined, "Eve's copy back as the server holds it");

		// Eve goes on editing from there; Ada never saw the refused value.
		eve.change((draft) => withValue(draft, "minutes", 45));
		await eve.saved();
		await ada.untilDraft((draft) => valueIn(draft, "minutes") === 45, "Eve's next change at Ada's");
		expect(ada.refusals).toEqual([]);
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.minutes).toBe(45);
		ada.close();
		eve.close();
	});

	test("an editor whose access ends is stopped, and its change goes nowhere", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const al = await openDraft(install, site.author, site.siteId, item);

		await site.staff.api.members.remove({ workspaceId: site.workspaceId, personId: site.authorId });

		al.change((draft) => withValue(draft, "summary", "Written after leaving"));
		await al.until(() => al.status() === "ended", "Al's editor to end");
		expect(al.messages.at(-1)).toEqual({ type: "ended", code: "ACCESS_LOST" });
		expect(al.closedWith()?.code).toBe(4403);
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.summary).toBe("Bake it today.");
		expect(valueIn(ada.draft(), "summary")).toBe("Bake it today.");
		ada.close();
	});
});

describe("presence", () => {
	test("each editor sees who else has the Draft open, by name, and the value each is in", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);

		eve.place("summary");
		await ada.until(
			() => ada.participants().some((someone) => someone.name === "Eve Editor" && someone.at === "summary"),
			"Eve in the summary, at Ada's",
		);
		const shown = ada.participants();
		expect(shown.map((someone) => [someone.name, someone.self ?? false]).sort()).toEqual([
			["Ada Staff", true],
			["Eve Editor", false],
		]);
		const eveShown = shown.find((someone) => someone.name === "Eve Editor");
		expect(eveShown?.via).toBeNull();
		expect(eveShown?.colour).toBeGreaterThanOrEqual(0);
		expect(eveShown?.colour).toBeLessThan(8);

		eve.close();
		await ada.until(() => ada.participants().length === 1, "Eve gone from Ada's list");
		ada.close();
	});
});

describe("without the server", () => {
	test("changes made offline are sent when the connection is back, and merge with what happened meanwhile", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);

		ada.disconnect();
		await ada.until(() => ada.status() === "offline", "Ada offline");
		expect(ada.change((draft) => withValue(draft, "summary", "Written on the train"))).toBe(true);
		eve.change((draft) => withValue(draft, "title", "Fresh bread, revised"));
		await eve.saved();

		await ada.reconnect();
		await ada.saved();
		await ada.untilDraft((draft) => valueIn(draft, "title") === "Fresh bread, revised", "Eve's change at Ada's");
		await eve.untilDraft(
			(draft) => valueIn(draft, "summary") === "Written on the train",
			"Ada's offline change at Eve's",
		);
		const { entry } = await site.staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("Fresh bread, revised");
		expect(entry.draft.fields.summary).toBe("Written on the train");
		ada.close();
		eve.close();
	});
});

describe("history while co-editing", () => {
	test("a Checkpoint is saved after 10 minutes of live changes, and when the last participant leaves", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);

		await install.clock.advance(11 * MINUTE);
		eve.change((draft) => withValue(draft, "summary", "Rewritten live"));
		await eve.saved();
		let { copies } = await site.staff.api.history.list({ siteId: site.siteId, item });
		expect(copies.map((copy) => [copy.type, copy.reason])).toEqual([["checkpoint", "activity"]]);
		expect(copies[0]?.by?.person?.name).toBe("Ada Staff");

		// One leaving isn't the last.
		ada.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		({ copies } = await site.staff.api.history.list({ siteId: site.siteId, item }));
		expect(copies).toHaveLength(1);
		await install.clock.advance(MINUTE);
		eve.close();
		const started = Date.now();
		while (Date.now() - started < 3000) {
			({ copies } = await site.staff.api.history.list({ siteId: site.siteId, item }));
			if (copies.length === 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(copies.map((copy) => [copy.type, copy.reason])).toEqual([
			["checkpoint", "left"],
			["checkpoint", "activity"],
		]);
		expect(copies[0]?.by?.person?.name).toBe("Eve Editor");
	});
});
