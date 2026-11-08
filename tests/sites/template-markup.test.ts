// What visitors get from Templates written as Template markup: values through the fixed formatters,
// escaped for where they land (text, attribute, URL), Conditions, comments left out, `\{{` as a
// literal `{{`, and inline styles turned into generated Classes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	// A Sunday, mid-morning: Entries published now have publishedAt 2026-04-05T10:30:00Z.
	install = await createTestInstall({ now: new Date("2026-04-05T10:30:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let postTypes = 0;

/**
 * A Post Type with `note` and `extra` text Fields whose Entry template is `markup`, published, then
 * one published Entry. Answers what the Entry template rendered inside <main>.
 */
async function rendered(
	markup: string,
	entry: { title?: string; note?: string; extra?: string } = {},
): Promise<{ main: string; html: string }> {
	const key = `kind-${++postTypes}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${postTypes}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: [
			{ key: "note", label: "Note", type: "text" },
			{ key: "extra", label: "Extra", type: "text" },
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const created = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: entry.title ?? "An Entry",
		fields: { note: entry.note ?? null, extra: entry.extra ?? null },
	});
	const { entry: published } = await editor.api.entries.publish({ siteId, entryId: created.entry.id });
	const response = await install.request(`https://bakery.sites.test/${key}/${published.published?.slug}`);
	expect(response.status).toBe(200);
	const html = await response.text();
	return { main: /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "", html };
}

describe("values and their formatters", () => {
	test("dates: plain, and each date style, in the page's language and in UTC", async () => {
		const { main } = await rendered(
			[
				'<time datetime="{{ publishedAt | date: datetime }}">{{ publishedAt | date: long }}</time>',
				"<p>{{ publishedAt }}|{{ publishedAt | date }}|{{ publishedAt | date: short }}|{{ publishedAt | date: full }}|{{ publishedAt | date: iso }}</p>",
				"<p>{{ publishedAt | date: time }}</p>",
			].join(""),
		);

		expect(main).toStartWith(
			'<time datetime="2026-04-05T10:30:00Z">April 5, 2026</time>' +
				"<p>2026-04-05|Apr 5, 2026|4/5/26|Sunday, April 5, 2026|2026-04-05</p>",
		);
		expect(main).toMatch(/<p>10:30\sAM<\/p>$/u);
	});

	test("a date written in a text Field formats too; text that isn't a date stays as it is", async () => {
		const { main } = await rendered("<p>{{ note | date: long }}</p><p>{{ extra | date: long }}</p>", {
			note: "2026-12-25",
			extra: "Christmas Day",
		});

		expect(main).toBe("<p>December 25, 2026</p><p>Christmas Day</p>");
	});

	test("numbers: grouped for the page's language, with a fixed number of decimals when asked", async () => {
		const { main } = await rendered(
			'<data value="{{ note }}">{{ note | number }} / {{ note | number: 2 }} / {{ note | number: 0 }}</data><p>{{ extra | number }}</p>',
			{ note: "1234.5", extra: "about twelve" },
		);

		expect(main).toBe('<data value="1234.5">1,234.5 / 1,234.50 / 1,235</data><p>about twelve</p>');
	});

	test("truncate: cut at a word boundary to at most that many characters, then …", async () => {
		const { main } = await rendered(
			"<h1>{{ title | truncate: 12 }}</h1><p>{{ note | truncate: 12 }}|{{ note | truncate: 5 }}</p><p>{{ extra | truncate: 12 }}</p>",
			{ title: "Spring bakes are back in town", note: "Croissants and more", extra: "Short enough" },
		);

		// "Spring bakes" ends on a word; "Croissants a" is cut back to the word; "Croissants" has no
		// space in its first 5 characters, so it is cut there.
		expect(main).toBe("<h1>Spring bakes…</h1><p>Croissants…|Crois…</p><p>Short enough</p>");
	});
});

describe("escaping for where a value lands", () => {
	const attack = `"><script>alert('x')</script><img src=x onerror=alert(1)> & co`;
	const escapedText = "&quot;&gt;&lt;script&gt;alert('x')&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; co";

	test("text, attributes and formatted values", async () => {
		const { main } = await rendered(
			'<p title="{{ note }}">{{ note }}</p><p data-note="before {{ note | truncate: 500 }} after">{{ note | truncate: 500 }}</p>',
			{ note: attack },
		);

		const asText = escapedText.replaceAll("&quot;", '"');
		const asAttribute = escapedText.replaceAll("'", "&#39;");
		expect(main).toBe(
			`<p title="${asAttribute}">${asText}</p>` + `<p data-note="before ${asAttribute} after">${asText}</p>`,
		);
		expect(main).not.toContain("<script");
		expect(main).not.toContain("<img");
	});

	test("URLs keep only https, http, mailto, tel, relative paths and #anchors; anything else becomes #", async () => {
		const links = [
			"https://example.com/a?b=1&c=2",
			"http://example.com",
			"mailto:hi@example.com",
			"tel:+353",
			"/blog/x",
			"#top",
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:x",
			"file:///etc/passwd",
		];
		const answers: string[] = [];
		for (const link of links) {
			const { main } = await rendered('<a href="{{ note }}">x</a><img src="{{ note }}" alt="">', { note: link });
			answers.push(main);
		}

		const expected = [
			"https://example.com/a?b=1&amp;c=2",
			"http://example.com",
			"mailto:hi@example.com",
			"tel:+353",
			"/blog/x",
			"#top",
			"#",
			"#",
			"#",
			"#",
			"#",
		];
		expect(answers).toEqual(expected.map((url) => `<a href="${url}">x</a><img src="${url}" alt="">`));
	});

	test("written URLs, srcset candidates and a URL made of text and a value are checked the same way", async () => {
		const { main } = await rendered(
			[
				'<a href="javascript:alert(1)">a</a>',
				'<a href="{{ note }}{{ extra }}">b</a>',
				'<img srcset="/a.png 1x, {{ note }}x 2x" alt="">',
				'<a href="/ok" ping="/p {{ note }}x">c</a>',
			].join(""),
			{ note: "javascript:", extra: "alert(1)" },
		);

		expect(main).toBe(
			'<a href="#">a</a><a href="#">b</a><img srcset="/a.png 1x, # 2x" alt=""><a href="/ok" ping="/p #">c</a>',
		);
	});
});

describe("Conditions", () => {
	const markup = [
		"{{@if note}}<p>Note: {{ note }}</p>",
		'{{@else if extra == "soon"}}<p>Coming soon</p>',
		"{{@else if extra}}<p>Extra: {{ extra }}</p>",
		"{{@else}}<p>Nothing yet</p>{{/if}}",
	].join("");

	test("the first branch whose test passes renders; else the {{@else}}", async () => {
		expect((await rendered(markup, { note: "Hello", extra: "soon" })).main).toBe("<p>Note: Hello</p>");
		expect((await rendered(markup, { extra: "soon" })).main).toBe("<p>Coming soon</p>");
		expect((await rendered(markup, { extra: "later" })).main).toBe("<p>Extra: later</p>");
		expect((await rendered(markup, {})).main).toBe("<p>Nothing yet</p>");
	});

	test("not, and, or, brackets, != and literals; blank text counts as empty", async () => {
		const tests = [
			"{{@if not note}}A{{/if}}",
			"{{@if note and extra}}B{{/if}}",
			"{{@if note or extra}}C{{/if}}",
			'{{@if (note or extra) and title != "Hidden"}}D{{/if}}',
			'{{@if note == ""}}E{{/if}}',
			"{{@if extra == 12}}F{{/if}}",
			"{{@if extra == 12.0 and not (note == 1)}}G{{/if}}",
			"{{@if true and not false}}H{{/if}}",
		].join("");

		expect((await rendered(tests, { note: "  ", extra: "12" })).main).toBe("ACDEFGH");
		expect((await rendered(tests, { title: "Hidden", note: "x", extra: "13" })).main).toBe("BCH");
	});

	test("Conditions nest, and wrap elements, text and values alike", async () => {
		const { main } = await rendered(
			"<ul>{{@if note}}<li>{{ note }}</li>{{@if extra}}<li>{{ extra }}</li>{{/if}}{{/if}}</ul>",
			{ note: "One", extra: "Two" },
		);

		expect(main).toBe("<ul><li>One</li><li>Two</li></ul>");
	});
});

describe("comments and literal {{", () => {
	test("HTML comments are kept in the markup but never sent to visitors", async () => {
		const markup = "<!-- Hero: keep it short --><h1>{{ title }}</h1><!--{{ note }} is secret-->";
		const { html, main } = await rendered(markup, { note: "Top" });

		expect(main).toBe("<h1>An Entry</h1>");
		expect(html).not.toContain("<!--");
		expect(html).not.toContain("Hero");
	});

	test("\\{{ shows a literal {{, in text and in attributes", async () => {
		const { main } = await rendered('<p title="\\{{ title }}">Write \\{{ title }} for {{ title }}</p>');

		expect(main).toBe('<p title="{{ title }}">Write {{ title }} for An Entry</p>');
	});
});
