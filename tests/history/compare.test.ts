// Compare: a Revision or Checkpoint next to the item's Draft as it is now, part by part, one language at
// a time. Each part says whether it differs (in words, not only colour, in the admin), how each side
// reads (a choice's label, a Body Block by Block, markup line by line) and who changed the Draft's value
// last and when: "<person> via <client>" when an API client changed it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ComparedPart } from "@webcraft/core";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type HistorySite, historySite } from "./support.ts";

let install: TestInstall;
let site: HistorySite;

beforeAll(async () => {
	install = await createTestInstall();
	site = await historySite(install);
});

afterAll(async () => {
	await install.close();
});

/** A part of a comparison by key. */
function part(parts: readonly ComparedPart[], key: string): ComparedPart {
	const found = parts.find((candidate) => candidate.key === key);
	if (!found) throw new Error(`No part ${key}`);
	return found;
}

describe("an Entry", () => {
	let entryId: string;
	let revisionId: string;

	beforeAll(async () => {
		const { siteId, postTypeId, workspaceId, staff, editor, author } = site;
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Fresh bread",
			fields: {
				summary: "Crusty",
				topic: "bread",
				ingredients: [{ name: "Flour" }],
				body: [
					{ id: "b1", type: "paragraph", text: "Bake it slowly." },
					{ id: "b2", type: "paragraph", text: "Serve it warm." },
				],
			},
		});
		entryId = entry.id;
		await editor.api.entries.saveDraft({ siteId, entryId, language: "fr", title: "Pain frais" });
		await editor.api.entries.publish({ siteId, entryId });
		const { copies } = await editor.api.history.list({ siteId, item: { kind: "entry", id: entryId } });
		revisionId = copies.find((copy) => copy.type === "revision")?.id ?? "";

		await install.clock.advance(60_000);
		await editor.api.entries.saveDraft({
			siteId,
			entryId,
			title: "Fresh bread, sliced",
			fields: {
				topic: "cakes",
				body: [
					{ id: "b1", type: "paragraph", text: "Bake it very slowly." },
					{ id: "b3", type: "quote", text: "Best in town." },
				],
			},
		});
		await install.clock.advance(60_000);
		await author.api.entries.saveDraft({ siteId, entryId, language: "fr", title: "Pain frais, tranché" });
		await install.clock.advance(60_000);
		const { secret } = await createApiToken(staff, { workspaceId, name: "Nightly sync" });
		await tokenClient(install, secret).api.entries.saveDraft({
			siteId,
			entryId,
			fields: { summary: "Crusty and warm" },
		});
	});

	test("marks the parts that differ in the Default language, with who changed each and when", async () => {
		const { siteId, editorId, staffId } = site;
		const comparison = await site.editor.api.history.compare({
			siteId,
			item: { kind: "entry", id: entryId },
			copy: { type: "revision", id: revisionId },
		});
		expect(comparison.language).toBe("en");
		expect(comparison.parts.filter((each) => each.changed).map((each) => each.key)).toEqual([
			"title",
			"summary",
			"body",
			"topic",
		]);
		expect(comparison.changes).toBe(4);

		const title = part(comparison.parts, "title");
		expect(title).toMatchObject({
			label: null,
			shared: false,
			copy: { kind: "text", text: "Fresh bread" },
			draft: { kind: "text", text: "Fresh bread, sliced" },
			changedBy: { person: { id: editorId, name: "Eve Editor" }, client: null },
		});
		expect(title.changedAt).toEqual(new Date(install.clock.now().getTime() - 2 * 60_000));
		expect(part(comparison.parts, "summary")).toMatchObject({
			label: "Summary",
			copy: { kind: "text", text: "Crusty" },
			draft: { kind: "text", text: "Crusty and warm" },
			changedBy: {
				person: { id: staffId, name: "Ada Staff" },
				via: { kind: "token", name: "Nightly sync" },
				client: "Nightly sync",
			},
		});
		// A choice reads as its label; a Field kept once for every language says so.
		expect(part(comparison.parts, "topic")).toMatchObject({
			shared: true,
			copy: { kind: "text", text: "Bread" },
			draft: { kind: "text", text: "Cakes" },
		});
		// A Body compares Block by Block, by their ids.
		expect(part(comparison.parts, "body")).toMatchObject({
			copy: {
				kind: "blocks",
				blocks: [
					{ id: "b1", type: "paragraph", text: "Bake it slowly.", status: "changed" },
					{ id: "b2", type: "paragraph", text: "Serve it warm.", status: "removed" },
				],
			},
			draft: {
				kind: "blocks",
				blocks: [
					{ id: "b1", type: "paragraph", text: "Bake it very slowly.", status: "changed" },
					{ id: "b3", type: "quote", text: "Best in town.", status: "added" },
				],
			},
		});
		// Unchanged parts are there too, for "Show all".
		expect(part(comparison.parts, "ingredients")).toMatchObject({
			changed: false,
			copy: {
				kind: "rows",
				rows: [{ status: "same", fields: [{ key: "name", shown: { kind: "text", text: "Flour" } }] }],
			},
		});
		expect(part(comparison.parts, "featured")).toMatchObject({
			changed: false,
			copy: { kind: "boolean", value: false },
		});
	});

	test("compares each language on its own, counting what differs in each", async () => {
		const { siteId, authorId } = site;
		const comparison = await site.editor.api.history.compare({
			siteId,
			item: { kind: "entry", id: entryId },
			copy: { type: "revision", id: revisionId },
			language: "fr",
		});
		expect(comparison.language).toBe("fr");
		expect(comparison.languages).toEqual([
			{ code: "en", name: "English", changes: 4 },
			{ code: "fr", name: "Français", changes: 2 },
		]);
		expect(part(comparison.parts, "title")).toMatchObject({
			changed: true,
			copy: { kind: "text", text: "Pain frais" },
			draft: { kind: "text", text: "Pain frais, tranché" },
			changedBy: { person: { id: authorId, name: "Al Author" } },
		});
		// No French summary of its own on either side: it shows the English one, and nothing differs.
		expect(part(comparison.parts, "summary")).toMatchObject({
			changed: false,
			copy: { kind: "fallback" },
			draft: { kind: "fallback" },
		});
		expect(part(comparison.parts, "topic")).toMatchObject({ changed: true, shared: true });
	});

	test("a Checkpoint compares the same way; an unknown one is refused", async () => {
		const { siteId, editor } = site;
		const item = { kind: "entry", id: entryId } as const;
		await install.clock.advance(60_000);
		await editor.api.history.leave({ siteId, item });
		const { copies } = await editor.api.history.list({ siteId, item });
		expect(copies[0]?.type).toBe("checkpoint");
		const comparison = await editor.api.history.compare({
			siteId,
			item,
			copy: { type: "checkpoint", id: copies[0]?.id ?? "" },
		});
		expect(comparison.changes).toBe(0);

		await expect(
			editor.api.history.compare({ siteId, item, copy: { type: "checkpoint", id: revisionId } }),
		).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND", status: 404 });
	});
});

describe("Structure", () => {
	test("compares its sections as text, line by line", async () => {
		const { siteId, staff } = site;
		const { component } = await staff.api.components.create({ siteId, name: "PriceTag" });
		await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<p>Price</p>\n<p>Per loaf</p>",
		});
		await staff.api.components.publish({ siteId, componentId: component.id });
		const item = { kind: "component", id: component.id } as const;
		const revision = (await staff.api.history.list({ siteId, item })).copies.find((copy) => copy.type === "revision");
		await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<p>Price</p>\n<p>Per dozen</p>",
		});

		const comparison = await staff.api.history.compare({
			siteId,
			item,
			copy: { type: "revision", id: revision?.id ?? "" },
		});
		expect(comparison.language).toBeNull();
		expect(comparison.languages).toEqual([]);
		const tree = part(comparison.parts, "tree");
		expect(tree.changed).toBe(true);
		expect(tree.copy).toMatchObject({ kind: "code" });
		// Element ids are left out of the markup shown, so only the line that changed differs.
		expect(tree.lines).toEqual([
			{ status: "same", text: "<p>Price</p>" },
			{ status: "removed", text: "<p>Per loaf</p>" },
			{ status: "added", text: "<p>Per dozen</p>" },
		]);
		expect(part(comparison.parts, "props").changed).toBe(false);
	});
});
