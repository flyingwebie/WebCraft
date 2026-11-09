// What visitors get: WebCraft's own renderer turns the published Entry template and the published
// Entry into semantic HTML, every value escaped for where it lands, with no JavaScript (ADR 0005).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { stylesheetIn } from "../harness/site-styles.ts";
import { element, type TestTree, text, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let editorName: string;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-05T10:30:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme <Bakery> & Co", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const member = await install.createMember({ workspaceId, role: "editor", name: "Edie <Editor>" });
	editor = member.browser;
	editorName = member.account.name;
});

afterAll(async () => {
	await install.close();
});

let postTypes = 0;

/** A Post Type at /<key>/{slug} with a `note` Field and a published Entry template, then one published Entry. */
async function publishedPage(
	template: TestTree,
	entry: { title: string; slug?: string; note?: string },
): Promise<{ html: string; response: Response; entryId: string }> {
	const key = `kind-${++postTypes}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${postTypes}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: [{ key: "note", label: "Note", type: "text" }],
	});
	const saved = await staff.api.templates.saveEntryTemplate({ siteId, postTypeId: postType.id, tree: template });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const created = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: entry.title,
		slug: entry.slug,
		fields: { note: entry.note ?? null },
	});
	const { entry: published } = await editor.api.entries.publish({ siteId, entryId: created.entry.id });
	const response = await install.request(`https://bakery.sites.test/${key}/${published.published?.slug}`);
	return { html: await response.text(), response, entryId: created.entry.id };
}

describe("semantic HTML", () => {
	test("a whole page: lang and dir, the title with the Site's name, a skip link, the template inside <main>", async () => {
		const { html, response } = await publishedPage(
			tree(
				element("article", [
					element("header", [element("h1", [value("title")]), element("p", [text("By "), value("author")])]),
					element("section", [element("h2", [text("Note")]), element("p", [value("note")])]),
				]),
			),
			{ title: "Daily bread", note: "Fresh at seven." },
		);

		expect(response.status).toBe(200);
		expect(html).toBe(
			[
				"<!doctype html>",
				'<html lang="en" dir="ltr">',
				"<head>",
				'<meta charset="utf-8">',
				'<meta name="viewport" content="width=device-width, initial-scale=1">',
				"<title>Daily bread · Acme &lt;Bakery&gt; &amp; Co</title>",
				// The Site's stylesheet, named by the hash of what it holds.
				`<link rel="stylesheet" href="${stylesheetIn(html)}">`,
				"</head>",
				"<body>",
				'<a class="wc-skip-link" href="#wc-main">Skip to main content</a>',
				'<main id="wc-main" tabindex="-1"><article><header><h1>Daily bread</h1><p>By Edie &lt;Editor&gt;</p></header>' +
					"<section><h2>Note</h2><p>Fresh at seven.</p></section></article></main>",
				"</body>",
				"</html>",
				"",
			].join("\n"),
		);
		expect(editorName).toBe("Edie <Editor>");
	});

	test("the built-in Fields can be shown: slug, status and dates", async () => {
		const { html } = await publishedPage(
			tree(
				element("p", [value("slug"), text(" "), value("status")]),
				element("time", [value("publishedAt")], { datetime: [value("publishedAt")] }),
			),
			{ title: "Spring menu" },
		);

		expect(html).toContain('<p>spring-menu published</p><time datetime="2026-04-05">2026-04-05</time>');
	});

	test("an empty Field renders as nothing", async () => {
		const { html } = await publishedPage(tree(element("p", [text("["), value("note"), text("]")])), { title: "Plain" });

		expect(html).toContain("<p>[]</p>");
	});

	test("void elements have no end tag, and <pre> keeps a leading newline", async () => {
		const { html } = await publishedPage(
			tree(element("p", [text("a"), element("br"), text("b")]), element("hr"), element("pre", [text("\n  indented")])),
			{ title: "Shapes" },
		);

		expect(html).toContain('<main id="wc-main" tabindex="-1"><p>a<br>b</p><hr><pre>\n\n  indented</pre></main>');
	});
});

describe("escaping", () => {
	test("values are escaped as text, in attributes, and in the title", async () => {
		const attack = `"><script>alert('x')</script><img src=x onerror=alert(1)> & co`;
		const { html } = await publishedPage(
			tree(
				element("h1", [value("title")]),
				element("p", [value("note")], { title: [value("note")], "data-note": [value("note")] }),
			),
			{ title: `<b>Bold</b> & "quoted"`, note: attack },
		);

		expect(html).toContain('<title>&lt;b&gt;Bold&lt;/b&gt; &amp; "quoted" · Acme &lt;Bakery&gt; &amp; Co</title>');
		expect(html).toContain('<h1>&lt;b&gt;Bold&lt;/b&gt; &amp; "quoted"</h1>');
		const escapedAttribute =
			"&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; co";
		expect(html).toContain(`<p title="${escapedAttribute}" data-note="${escapedAttribute}">`);
		expect(html).toContain("&lt;script&gt;alert('x')&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; co</p>");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
	});

	test("URLs: only http, https, mailto, tel, relative paths and #anchors; anything else becomes #", async () => {
		const links = [
			"https://example.com/a?b=1&c=2",
			"mailto:hi@example.com",
			"/blog/x",
			"#top",
			"tel:+353",
			"javascript:alert(1)",
			" JavaScript:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:x",
		];
		const { html } = await publishedPage(
			tree(
				...links.map((_, index) =>
					element("a", [text(String(index))], { href: index === 0 ? [value("note")] : (links[index] ?? "") }),
				),
			),
			{ title: "Links", note: links[0] },
		);

		expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">0</a>');
		expect(html).toContain('<a href="mailto:hi@example.com">1</a>');
		expect(html).toContain('<a href="/blog/x">2</a><a href="#top">3</a><a href="tel:+353">4</a>');
		expect(html).toContain('<a href="#">5</a><a href="#">6</a><a href="#">7</a><a href="#">8</a><a href="#">9</a>');
	});

	test("a URL from a Field is checked the same way", async () => {
		const { html } = await publishedPage(
			tree(
				element("a", [text("Go")], { href: [value("note")] }),
				element("img", [], { src: [value("note")], alt: "" }),
			),
			{ title: "Field URL", note: "javascript:alert(document.cookie)" },
		);

		expect(html).toContain('<a href="#">Go</a><img src="#" alt="">');
	});
});

describe("no JavaScript", () => {
	test("published pages carry no script element, no event handler attribute and no javascript: URL", async () => {
		const { html } = await publishedPage(
			tree(element("article", [element("h1", [value("title")]), element("a", [text("x")], { href: [value("note")] })])),
			{ title: "<script>alert(1)</script>", note: "javascript:alert(1)" },
		);

		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/\son[a-z]+=/i);
		expect(html).not.toMatch(/javascript:/i);
	});
});

describe("Drafts", () => {
	test("an Entry that was never published has no page", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Drafts only",
			urlPattern: "/drafts/{slug}",
		});
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("h1", [value("title")])),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Work in progress" });

		expect((await install.request("https://bakery.sites.test/drafts/work-in-progress")).status).toBe(404);
	});

	test("a Template's Draft changes nothing until it is published", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Notices", urlPattern: "/notices/{slug}" });
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("h1", [value("title")])),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Closed Monday" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("h2", [value("title")])),
		});
		expect(await (await install.request("https://bakery.sites.test/notices/closed-monday")).text()).toContain(
			"<h1>Closed Monday</h1>",
		);

		await staff.api.templates.publish({ siteId, templateId: template.id });
		expect(await (await install.request("https://bakery.sites.test/notices/closed-monday")).text()).toContain(
			"<h2>Closed Monday</h2>",
		);
	});
});
