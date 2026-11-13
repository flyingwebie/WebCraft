// Pasting into a body (spec story 84): what is pasted from documents and web pages (their HTML),
// Markdown and plain text becomes Blocks of the existing types, never HTML. Structure, links, bold
// and italic are kept; fonts and colours are dropped; an H1 becomes an H2; anything with no Block
// becomes its text. A pasted image's address becomes an image Block with no image yet, never
// fetched. The block editors (the admin's and Edit mode's) ask the server to convert what is pasted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let siteId: string;
let postTypeId: string;
let noTablesId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	postTypeId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Articles",
			key: "articles",
			urlPattern: "/articles/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		})
	).postType.id;
	noTablesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Notes",
			key: "notes",
			urlPattern: "/notes/{slug}",
			fields: [{ key: "body", label: "Body", type: "body", blocksOff: ["table", "callout"] }],
		})
	).postType.id;
});

afterAll(async () => {
	await install.close();
});

async function paste(pasted: { html?: string; text?: string }, into = postTypeId) {
	const { blocks } = await author.api.entries.pasteBody({ siteId, postTypeId: into, ...pasted });
	return blocks.map(({ id, ...rest }) => {
		expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
		return rest;
	});
}

describe("pasting from documents and web pages", () => {
	test("a word processor's HTML keeps headings, lists, links, bold and italic, and drops fonts and colours", async () => {
		const html = [
			'<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234">',
			'<h1 dir="ltr" style="line-height:1.38"><span style="font-size:20pt;font-family:Arial;color:#000000">Spring menu</span></h1>',
			'<p dir="ltr"><span style="font-family:Arial;color:#ff0000;font-weight:700">Fresh</span>',
			'<span style="font-family:Arial"> bread, </span><span style="font-style:italic">every</span>',
			'<span> day. See </span><a href="https://example.com/menu"><span style="color:#1155cc;text-decoration:underline">the menu</span></a>',
			'<span style="text-decoration:line-through">.</span></p>',
			'<ul><li dir="ltr"><p dir="ltr"><span>Sourdough</span></p></li><li><p><span>Rye</span></p></li></ul>',
			"<h4>Small print</h4><h6>Tiny</h6>",
			"</b>",
		].join("");

		expect(await paste({ html, text: "Spring menu …" })).toEqual([
			{ type: "heading", level: 2, text: [{ text: "Spring menu" }] },
			{
				type: "paragraph",
				text: [
					{ text: "Fresh", marks: ["bold"] },
					{ text: " bread, " },
					{ text: "every", marks: ["italic"] },
					{ text: " day. See " },
					{ text: "the menu", link: "https://example.com/menu" },
					{ text: ".", marks: ["strike"] },
				],
			},
			{ type: "list", style: "bulleted", items: [{ text: [{ text: "Sourdough" }] }, { text: [{ text: "Rye" }] }] },
			{ type: "heading", level: 4, text: [{ text: "Small print" }] },
			{ type: "heading", level: 4, text: [{ text: "Tiny" }] },
		]);
	});

	test("a word processor's list paragraphs become a list", async () => {
		const html = [
			'<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span></span>Flour</p>',
			'<p class="MsoListParagraph" style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o<span>&nbsp;</span></span>Strong</p>',
			'<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;</span></span>Water<o:p></o:p></p>',
			'<p class="MsoNormal">After<o:p></o:p></p>',
			'<p class="MsoListParagraph" style="mso-list:l1 level1 lfo2"><span style="mso-list:Ignore">1.<span>&nbsp;</span></span>Mix</p>',
		].join("");

		expect(await paste({ html })).toEqual([
			{
				type: "list",
				style: "bulleted",
				items: [{ text: [{ text: "Flour" }], items: [{ text: [{ text: "Strong" }] }] }, { text: [{ text: "Water" }] }],
			},
			{ type: "paragraph", text: [{ text: "After" }] },
			{ type: "list", style: "numbered", items: [{ text: [{ text: "Mix" }] }] },
		]);
	});

	test("a web page's HTML: its layout read through, scripts dropped, images and videos as Blocks, nothing as HTML", async () => {
		const html = [
			'<div class="container"><div class="row"><div class="col">',
			"<h2>Method</h2><script>alert(1)</script><style>p{color:red}</style>",
			'<p onclick="steal()">Knead <code>10 min</code>.</p>',
			'<img src="https://cdn.example.com/loaf.jpg" alt="A loaf">',
			'<figure><img src="data:image/png;base64,AAAA"><figcaption>Proved</figcaption></figure>',
			"<blockquote><p>Bread is life</p></blockquote>",
			'<pre><code class="language-js">const a = 1;</code></pre>',
			"<table><thead><tr><th>Step</th><th>Time</th></tr></thead><tbody><tr><td>Rise</td><td>8 h</td></tr></tbody></table>",
			'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Kneading"></iframe>',
			'<iframe src="https://maps.example.com/embed?x=1"></iframe>',
			"<custom-card><span>Made by hand</span></custom-card>",
			"<details><summary>Why?</summary><p>Because.</p></details><hr>",
			"</div></div></div>",
		].join("");

		const blocks = await paste({ html });

		expect(blocks).toEqual([
			{ type: "heading", level: 2, text: [{ text: "Method" }] },
			{ type: "paragraph", text: [{ text: "Knead " }, { text: "10 min", marks: ["code"] }, { text: "." }] },
			{ type: "image", media: null },
			{ type: "image", media: null },
			{ type: "paragraph", text: [{ text: "Proved" }] },
			{ type: "quote", text: [{ text: "Bread is life" }] },
			{ type: "code", code: "const a = 1;", language: "js" },
			{
				type: "table",
				headerRow: true,
				rows: [
					[[{ text: "Step" }], [{ text: "Time" }]],
					[[{ text: "Rise" }], [{ text: "8 h" }]],
				],
			},
			{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Kneading" },
			{ type: "paragraph", text: [{ text: "Made by hand" }] },
			{ type: "toggle", summary: [{ text: "Why?" }], text: [{ text: "Because." }] },
			{ type: "divider" },
		]);
		// Pasted images are never fetched.
		expect(install.http.requests.filter((request) => request.url.includes("example.com"))).toEqual([]);
	});
});

describe("pasting text", () => {
	test("a pasted image URL becomes an empty image Block without fetching it", async () => {
		expect(await paste({ text: "https://cdn.example.com/loaf.JPG?size=large#photo" })).toEqual([
			{ type: "image", media: null },
		]);
		expect(install.http.requests.filter((request) => request.url.includes("cdn.example.com"))).toEqual([]);
	});
	test("Markdown becomes Blocks, with its extensions; what has no Block becomes text", async () => {
		const text = [
			"# Spring menu",
			"",
			"Fresh **bread**, *every* day: [menu](https://example.com/menu).",
			"",
			"- Sourdough",
			"- Rye",
			"",
			':::callout{tone="warning"}',
			"Hot oven",
			":::",
			"",
			"<div>Raw</div>",
			"",
			"![A loaf](https://cdn.example.com/loaf.jpg)",
		].join("\n");

		expect(await paste({ text })).toEqual([
			{ type: "heading", level: 2, text: [{ text: "Spring menu" }] },
			{
				type: "paragraph",
				text: [
					{ text: "Fresh " },
					{ text: "bread", marks: ["bold"] },
					{ text: ", " },
					{ text: "every", marks: ["italic"] },
					{ text: " day: " },
					{ text: "menu", link: "https://example.com/menu" },
					{ text: "." },
				],
			},
			{ type: "list", style: "bulleted", items: [{ text: [{ text: "Sourdough" }] }, { text: [{ text: "Rye" }] }] },
			{ type: "callout", tone: "warning", text: [{ text: "Hot oven" }] },
			{ type: "paragraph", text: [{ text: "Raw" }] },
			{ type: "image", media: null },
		]);
		expect(install.http.requests.filter((request) => request.url.includes("example.com"))).toEqual([]);
	});

	test("plain text becomes paragraphs, a blank line between them and line breaks kept, with nothing read as Markdown", async () => {
		expect(await paste({ text: "Price: 2 * 3 = 6\nTotal: *6*\n\n\nNext paragraph" })).toEqual([
			{ type: "paragraph", text: [{ text: "Price: 2 * 3 = 6\nTotal: *6*" }] },
			{ type: "paragraph", text: [{ text: "Next paragraph" }] },
		]);
	});

	test("Blocks the Field switched off become text", async () => {
		const text = ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", ":::callout", "Note", ":::"].join("\n");
		expect(await paste({ text }, noTablesId)).toEqual([
			{ type: "paragraph", text: [{ text: "A B\n1 2" }] },
			{ type: "paragraph", text: [{ text: "Note" }] },
		]);
	});

	test("only people who may edit Entries paste, and only on Sites they reach", async () => {
		const outsider = (
			await install.createMember({ workspaceId: (await install.createWorkspace("Other")).id, role: "owner" })
		).browser;
		await expect(outsider.api.entries.pasteBody({ siteId, postTypeId, text: "Hi" })).rejects.toMatchObject({
			code: "SITE_NOT_FOUND",
		});
	});
});
