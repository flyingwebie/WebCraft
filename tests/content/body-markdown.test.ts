// Bodies as Markdown (ADR 0018, spec story 88): API clients, the MCP server and the CLI read and write
// a Body field as Markdown with a few extensions (callouts, toggles, videos, empty images and
// Components), or as the exact JSON Blocks. One converter works both ways, so every Block type comes
// back as it went out, and Markdown that doesn't convert cleanly is refused with its line number:
// nothing is dropped silently.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let siteId: string;
let postTypeId: string;

const MEDIA = "0b9b6f1e-3c1a-4c2e-9d55-6c0f4f7e2a10";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "body", label: "Body", type: "body" },
		],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

/** One Block of every type, with marks, links, line breaks and the characters Markdown reads as syntax. */
const EVERY_BLOCK = [
	{
		type: "paragraph",
		text: [
			{ text: "Plain, " },
			{ text: "bold", marks: ["bold"] },
			{ text: " and " },
			{ text: "both", marks: ["bold", "italic"] },
			{ text: ", " },
			{ text: "gone", marks: ["strike"] },
			{ text: ", " },
			{ text: "a `tick`", marks: ["code"] },
			{ text: " and " },
			{ text: "a link", link: "https://example.com/a_(b)?q=1&r=2" },
			{ text: ".\nNext line: * stars _ and # hashes & <tags> [brackets] | pipes ~ tildes \\ slash." },
		],
	},
	{ type: "heading", level: 2, text: "Method" },
	{ type: "heading", level: 3, text: "Step one", anchor: "first" },
	{ type: "heading", level: 4, text: [{ text: "Small " }, { text: "print", marks: ["italic"] }] },
	{
		type: "list",
		style: "bulleted",
		items: ["Flour", { text: "Water", items: [{ text: "Warm", items: ["Not hot"] }] }, "- not a marker"],
	},
	{ type: "list", style: "numbered", items: ["Mix", { text: "Bake", items: ["At 220 °C"] }] },
	{ type: "quote", text: "Bread is life\nand more" },
	{ type: "image", media: MEDIA },
	{ type: "image", media: null },
	{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "How to knead [video]" },
	{
		type: "table",
		headerRow: true,
		rows: [
			["Step", "Time"],
			["Rise | prove", [{ text: "8 h", marks: ["bold"] }]],
		],
	},
	{ type: "table", headerRow: false, rows: [["a", "b"]] },
	{ type: "callout", tone: "warning", text: "Preheat **the** oven" },
	{
		type: "callout",
		tone: "info",
		text: [{ text: "Tip: " }, { text: "rest", marks: ["bold"] }, { text: "\nthen bake" }],
	},
	{ type: "code", code: "const a = `x`;\n```\nnested fence", language: "js" },
	{ type: "code", code: "plain text", language: null },
	{ type: "divider" },
	{
		type: "toggle",
		summary: [{ text: "Why " }, { text: "so", marks: ["italic"] }, { text: " [long]?" }],
		text: "Because.\nReally.",
	},
	{ type: "paragraph", text: "1. Not a list, and :::callout isn't a directive" },
];

type Body = Record<string, unknown>[];

/** An Entry of Recipes with a body given as Blocks or Markdown. */
async function recipe(body: unknown, bodyFormat?: "blocks" | "markdown") {
	const { entry } = await author.api.entries.create({
		siteId,
		postTypeId,
		title: "Sourdough",
		fields: { body },
		...(bodyFormat ? { bodyFormat } : {}),
	});
	return entry;
}

async function bodyOf(entryId: string, bodyFormat?: "blocks" | "markdown") {
	const { entry } = await author.api.entries.get({ siteId, entryId, ...(bodyFormat ? { bodyFormat } : {}) });
	return entry.draft.fields.body;
}

function withoutIds(blocks: unknown): unknown {
	return (blocks as Body).map(({ id: _, ...rest }) => rest);
}

/** A refusal's problems, as API clients get them. */
async function refusal(markdown: string) {
	try {
		await recipe(markdown, "markdown");
	} catch (error) {
		return error as { code: string; data: { problems: { at: string; line?: number; message: string }[] } };
	}
	throw new Error("The Markdown was accepted.");
}

describe("a round trip", () => {
	test("every Block type comes back from Markdown as it was", async () => {
		const original = await recipe(EVERY_BLOCK);
		const blocks = original.draft.fields.body;

		const markdown = await bodyOf(original.id, "markdown");
		expect(typeof markdown).toBe("string");

		const copy = await recipe(markdown, "markdown");
		expect(withoutIds(copy.draft.fields.body)).toEqual(withoutIds(blocks));
		// And the same Markdown again.
		expect(await bodyOf(copy.id, "markdown")).toBe(markdown);
	});

	test("Markdown written back keeps the ids of the Blocks it still holds, so translations follow them", async () => {
		const original = await recipe(EVERY_BLOCK);
		const before = original.draft.fields.body as Body;
		const markdown = (await bodyOf(original.id, "markdown")) as string;

		const changed = markdown.replace("## Method", "## The method").replace("plain text", "plainer text");
		const { entry } = await author.api.entries.saveDraft({
			siteId,
			entryId: original.id,
			fields: { body: changed },
			bodyFormat: "markdown",
		});
		const after = entry.draft.fields.body as Body;

		expect(after.map((block) => block.id)).toEqual(before.map((block) => block.id));
		expect(after[1]).toMatchObject({ type: "heading", text: [{ text: "The method" }] });
	});

	test("an empty body reads as empty Markdown, and empty Markdown clears it", async () => {
		const original = await recipe([{ type: "paragraph", text: "Something" }]);
		const { entry } = await author.api.entries.saveDraft({
			siteId,
			entryId: original.id,
			fields: { body: "" },
			bodyFormat: "markdown",
		});
		expect(entry.draft.fields.body).toEqual([]);
		expect(await bodyOf(original.id, "markdown")).toBe("");
	});
});

describe("Markdown written by hand", () => {
	test("converts to Blocks, with the extensions for what Markdown has no syntax for", async () => {
		const markdown = [
			"# Big title",
			"",
			"Some *soft*",
			'wrapped __text__ with <https://example.com> and [a path](/about "About").',
			"Then a hard break  ",
			"here, and ***both*** marks.",
			"",
			"Setext heading",
			"--------------",
			"",
			"## Anchored {#my-anchor}",
			"",
			"* one",
			"* two",
			"    * nested",
			"",
			"3) three",
			"4) four",
			"",
			"> quoted",
			"lazily",
			"",
			':::callout{tone="success"}',
			"Well **done**",
			":::",
			"",
			":::toggle[Show *more*]",
			"Hidden text",
			":::",
			"",
			`![Alt text is the Media item's own](media:${MEDIA})`,
			"",
			"::image",
			"",
			'::video[Kneading]{url="https://vimeo.com/76979871"}',
			"",
			"| Left | Right |",
			"|:-----|------:|",
			"| `a|b` | 2 |",
			"",
			"~~~python",
			"print(1)",
			"~~~",
			"",
			"***",
			"",
			"[ref link][r]",
			"",
			"[r]: https://example.com/ref",
		].join("\n");

		const entry = await recipe(markdown, "markdown");

		expect(withoutIds(entry.draft.fields.body)).toEqual([
			// A body starts at H2: the page's H1 is the Entry's title.
			{ type: "heading", level: 2, text: [{ text: "Big title" }] },
			{
				type: "paragraph",
				text: [
					{ text: "Some " },
					{ text: "soft", marks: ["italic"] },
					{ text: " wrapped " },
					{ text: "text", marks: ["bold"] },
					{ text: " with " },
					{ text: "https://example.com", link: "https://example.com" },
					{ text: " and " },
					{ text: "a path", link: "/about" },
					{ text: ". Then a hard break\nhere, and " },
					{ text: "both", marks: ["bold", "italic"] },
					{ text: " marks." },
				],
			},
			{ type: "heading", level: 2, text: [{ text: "Setext heading" }] },
			{ type: "heading", level: 2, text: [{ text: "Anchored" }], anchor: "my-anchor" },
			{
				type: "list",
				style: "bulleted",
				items: [{ text: [{ text: "one" }] }, { text: [{ text: "two" }], items: [{ text: [{ text: "nested" }] }] }],
			},
			{ type: "list", style: "numbered", items: [{ text: [{ text: "three" }] }, { text: [{ text: "four" }] }] },
			{ type: "quote", text: [{ text: "quoted lazily" }] },
			{ type: "callout", tone: "success", text: [{ text: "Well " }, { text: "done", marks: ["bold"] }] },
			{
				type: "toggle",
				summary: [{ text: "Show " }, { text: "more", marks: ["italic"] }],
				text: [{ text: "Hidden text" }],
			},
			{ type: "image", media: MEDIA },
			{ type: "image", media: null },
			{ type: "video", url: "https://vimeo.com/76979871", title: "Kneading" },
			{
				type: "table",
				headerRow: true,
				rows: [
					[[{ text: "Left" }], [{ text: "Right" }]],
					[[{ text: "a|b", marks: ["code"] }], [{ text: "2" }]],
				],
			},
			{ type: "code", code: "print(1)", language: "python" },
			{ type: "divider" },
			{ type: "paragraph", text: [{ text: "ref link", link: "https://example.com/ref" }] },
		]);
	});

	test("Markdown that doesn't convert is refused with each problem's line number, and nothing is saved", async () => {
		const markdown = [
			"Intro", // 1
			"", // 2
			'<div class="box">Raw HTML</div>', // 3
			"", // 4
			"##### Too deep", // 5
			"", // 6
			"Text with <span>inline HTML</span>.", // 7
			"", // 8
			"![A photo](https://example.com/photo.jpg)", // 9
			"", // 10
			":::gallery", // 11
			"x", // 12
			":::", // 13
			"", // 14
			':::callout{tone="loud"}', // 15
			"Shout", // 16
			":::", // 17
			"", // 18
			"- one", // 19
			"  - two", // 20
			"    - three", // 21
			"      - four", // 22
			"", // 23
			"> > nested quote", // 24
			"", // 25
			"```js", // 26
			"never closed", // 27
		].join("\n");

		const refused = await refusal(markdown);

		expect(refused.code).toBe("ENTRY_INVALID");
		expect(refused.data.problems.map((problem) => [problem.at, problem.line])).toEqual([
			["fields.body", 3],
			["fields.body", 5],
			["fields.body", 7],
			["fields.body", 9],
			["fields.body", 11],
			["fields.body", 15],
			["fields.body", 22],
			["fields.body", 24],
			["fields.body", 26],
		]);
		for (const problem of refused.data.problems) expect(problem.message).toMatch(/\S/);
	});

	test("a Block that breaks the body's limits is refused at the line it starts on", async () => {
		const row = `| ${Array.from({ length: 21 }, (_, index) => `c${index}`).join(" | ")} |`;
		const markdown = ["Fine", "", row, `| ${Array.from({ length: 21 }, () => "---").join(" | ")} |`].join("\n");
		const refused = await refusal(markdown);
		expect(refused.data.problems).toEqual([expect.objectContaining({ at: "fields.body", line: 3 })]);
	});

	test("a body given as Markdown is refused for a Field that isn't a body", async () => {
		await expect(
			author.api.entries.create({
				siteId,
				postTypeId,
				title: "Sourdough",
				fields: { summary: "Short", body: ["not Markdown"] },
				bodyFormat: "markdown",
			}),
		).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "fields.body" }] } });
	});
});

describe("reading bodies as Markdown", () => {
	test("Entries answer their Draft's and published bodies as Markdown when asked, and as Blocks otherwise", async () => {
		const entry = await recipe([
			{ type: "heading", level: 2, text: "Method" },
			{ type: "paragraph", text: "Fold & wait." },
		]);
		await staff.api.entries.publish({ siteId, entryId: entry.id });

		const { entry: read } = await author.api.entries.get({ siteId, entryId: entry.id, bodyFormat: "markdown" });
		expect(read.draft.fields.body).toBe("## Method\n\nFold \\& wait.");
		expect(read.published?.fields.body).toBe("## Method\n\nFold \\& wait.");

		const { entries } = await author.api.entries.list({ siteId, postTypeId, bodyFormat: "markdown" });
		expect(entries.find((each) => each.id === entry.id)?.draft.fields.body).toBe("## Method\n\nFold \\& wait.");

		expect(await bodyOf(entry.id)).toEqual([
			{ id: expect.any(String), type: "heading", level: 2, text: [{ text: "Method" }] },
			{ id: expect.any(String), type: "paragraph", text: [{ text: "Fold & wait." }] },
		]);
	});
});
