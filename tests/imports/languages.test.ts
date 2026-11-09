// The language a CSV Import writes in: the Site's Default language unless it names another of the
// Site's languages. Translations come in by running a CSV in that language, matched by the same
// column: Translatable fields get their value in it, and a row matching no Entry isn't imported.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, importCsv } from "./support.ts";

let install: TestInstall;
let siteId: string;
let editor: TestBrowser;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Products",
		urlPattern: "/products/{slug}",
		fields: [
			{ key: "sku", label: "SKU", type: "text", translatable: false },
			{ key: "summary", label: "Summary", type: "text" },
		],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

describe("the language an Import writes in", () => {
	test("is the Default language unless it names another; a run in another language adds translations", async () => {
		const columns = [
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
			{ column: "summary", to: "fields.summary" },
		];
		await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postTypeId, columns, { match: "fields.sku" }),
			"name,sku,summary\nSeeded rye,RY-1,A dense loaf\nBrioche,BR-1,A soft bun\n",
		);

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postTypeId, columns, { match: "fields.sku", language: "it" }),
			"name,sku,summary\nSegale ai semi,RY-1,Un pane denso\nTorta,TO-1,Una torta\n",
		);

		expect(run).toMatchObject({ language: "it", counts: { created: 0, updated: 1, problemRows: 1 } });
		expect(run.problems).toEqual([{ row: 3, column: null, rule: "translationWithoutEntry", params: null }]);
		const values = async (language: string) =>
			Object.fromEntries(
				(await editor.api.entries.list({ siteId, postTypeId, language })).entries.map((entry) => [
					entry.draft.fields.sku,
					[entry.draft.title, entry.draft.fields.summary],
				]),
			);
		expect(await values("en")).toEqual({ "RY-1": ["Seeded rye", "A dense loaf"], "BR-1": ["Brioche", "A soft bun"] });
		// The Brioche has no Italian values yet, so it falls back to the Default language's.
		expect(await values("it")).toEqual({
			"RY-1": ["Segale ai semi", "Un pane denso"],
			"BR-1": ["Brioche", "A soft bun"],
		});
	});
});
