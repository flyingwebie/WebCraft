// What Template markup refuses, and how: every problem comes back with its line and column, so
// Code mode, the CLI and AI clients can point at it. Nothing of a refused save is kept.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

type Problem = { line: number; column: number; message: string };

/** The problems saving `markup` is refused with. */
async function problemsOf(markup: string): Promise<Problem[]> {
	const error = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup }).then(
		() => undefined,
		(refused: unknown) => refused,
	);
	expect(error).toMatchObject({ code: "TEMPLATE_MARKUP_INVALID", status: 400 });
	return (error as { data: { problems: Problem[] } }).data.problems;
}

/** Saving `markup` is refused with one problem, at `line` and `column`, whose message holds `says`. */
async function refuses(markup: string, line: number, column: number, says: string): Promise<void> {
	expect(await problemsOf(markup)).toEqual([{ line, column, message: expect.stringContaining(says) }]);
}

describe("scripts and event handlers", () => {
	test("a <script> element, wherever it is", async () => {
		await refuses("<article>\n  <script>alert(1)</script>\n</article>", 2, 3, "Scripts aren't allowed");
		await refuses("<SCRIPT src=/x.js></SCRIPT>", 1, 1, "Scripts aren't allowed");
	});

	test("on… attributes, with or without a value in them", async () => {
		await refuses('<p>\n  <a href="/x" onclick="steal()">x</a>\n</p>', 2, 16, "onclick: event handler attributes");
		await refuses('<p onMouseOver="{{ title }}">x</p>', 1, 4, "onmouseover: event handler attributes");
	});
});

describe("invalid HTML", () => {
	test("an element without its end tag", async () => {
		await refuses("<section>\n  <p>Hi\n</section>", 3, 1, "</section> doesn't close <p> on line 2");
		await refuses("<div>\n<p>Hi</p>", 1, 1, "<div> on line 1 has no end tag </div>");
	});

	test("an end tag that closes nothing, and end tags on elements that have none", async () => {
		await refuses("<p>Hi</p></div>", 1, 10, "</div> closes no element");
		await refuses("<p>a<br></br></p>", 1, 9, "<br> has no end tag");
	});

	test("an element closing itself, and nesting a browser would change", async () => {
		await refuses("<div/>", 1, 1, "<div> can't close itself");
		await refuses("<p>\n  <div>x</div>\n</p>", 2, 3, "<div> can't go inside <p>");
		await refuses('<a href="/a"><span><a href="/b">x</a></span></a>', 1, 20, "A link can't go inside another link");
		await refuses(
			"<table><tr><td>x</td></tr></table>",
			1,
			8,
			"<tr> goes directly inside <thead> or <tbody> or <tfoot>",
		);
		await refuses("<ul><li>a<li>b</li></li></ul>", 1, 10, "<li> can't go inside <li>");
	});

	test("an attribute given twice, a stray <, unfinished values and attributes, doctypes", async () => {
		await refuses('<p title="a" title="b">x</p>', 1, 14, "title is given twice");
		await refuses("<p>1 < 2</p>", 1, 6, "Write &lt; for a < in text");
		await refuses("<p>{{ title</p>", 1, 4, "{{ on line 1 has no closing }}");
		await refuses('<p title="x>y</p>', 1, 10, "This attribute value never ends");
		await refuses("<!DOCTYPE html><p>x</p>", 1, 1, "Doctypes");
		await refuses("<p>x<!-- note</p>", 1, 5, "The comment on line 1 never ends");
	});
});

describe("unknown names", () => {
	test("elements, Components, Template commands and reserved commands", async () => {
		await refuses("<blink>x</blink>", 1, 1, "There is no element named blink");
		await refuses('<Card title="x"></Card>', 1, 1, "There is no Component named Card");
		await refuses("{{@repeat items}}x{{/repeat}}", 1, 1, "There is no Template command {{@repeat}}");
		await refuses("{{@loop posts as post}}x{{/loop}}", 1, 1, "{{@loop}} isn't available yet");
		await refuses("<p>{{@outlet}}</p>", 1, 4, "{{@outlet}} isn't available yet");
	});

	test("values, formatters and Classes", async () => {
		await refuses("<h1>{{ title }}</h1>\n<p>{{ price }}</p>", 2, 7, "There is no value named price here");
		await refuses('<a href="/{{ site.url }}">x</a>', 1, 14, "There is no Global named url on this Site");
		await refuses("<p>{{ item.title }}</p>", 1, 7, "item. values are read inside a Loop, and there is none here");
		await refuses("<p>{{ props.title }}</p>", 1, 7, "props. values are read inside a Component, and this isn't one");
		await refuses("<p>{{ title | upper }}</p>", 1, 15, "There is no formatter upper");
		await refuses("<p>{{ title | truncate }}</p>", 1, 15, "truncate takes a length");
		await refuses('<p class="card">x</p>', 1, 11, "There is no Class named card on this Site");
	});

	test("values inside a Condition's test", async () => {
		await refuses("{{@if summary and price}}x{{/if}}", 1, 19, "There is no value named price here");
	});

	test("an element an Entry template can't hold", async () => {
		await refuses("<main><h1>{{ title }}</h1></main>", 1, 1, "An Entry template renders inside the page's <main>");
	});
});

describe("values where they could run or change the page's structure", () => {
	test("in style, srcdoc and on… attributes", async () => {
		await refuses('<p style="color: {{ summary }}">x</p>', 1, 11, "Values can't be used in style");
		await refuses('<p srcdoc="{{ summary }}">x</p>', 1, 4, "srcdoc isn't allowed");
		await refuses('<a onclick="{{ summary }}">x</a>', 1, 4, "onclick: event handler attributes");
	});

	test("in script and style content", async () => {
		await refuses("<script>var t = '{{ title }}';</script>", 1, 1, "Scripts aren't allowed");
		await refuses("<style>p::before { content: '{{ title }}' }</style>", 1, 1, "Style elements aren't allowed");
	});

	test("in <meta http-equiv>", async () => {
		expect(await problemsOf('<meta http-equiv="refresh" content="0;url={{ slug }}">')).toEqual([
			{ line: 1, column: 1, message: expect.stringContaining("Meta elements aren't allowed") },
			{ line: 1, column: 7, message: expect.stringContaining("http-equiv isn't allowed") },
		]);
	});

	test("in tag and attribute names", async () => {
		await refuses("<h{{ summary }}>x</h{{ summary }}>", 1, 1, "Values can't be used in tag names");
		await refuses('<p {{ summary }}="x">y</p>', 1, 4, "Values can't be used in attribute names");
		await refuses('<p data-{{ summary }}="1">y</p>', 1, 4, "Values can't be used in attribute names");
	});

	test("in class and data-wc-id, and Template commands inside attribute values", async () => {
		await refuses('<p class="{{ summary }}">x</p>', 1, 11, "Values can't be used in class");
		await refuses('<p data-wc-id="{{ summary }}">x</p>', 1, 16, "data-wc-id is 1 to 64 letters");
		await refuses(
			'<p title="{{@if summary}}x{{/if}}">y</p>',
			1,
			11,
			"Template commands can't be used inside attribute values",
		);
	});

	test("media: images, which come with the Media library", async () => {
		await refuses('<img src="media:abc123" alt="">', 1, 11, "media: images aren't available yet");
	});
});

describe("Conditions written wrongly", () => {
	test("a test that isn't one", async () => {
		await refuses('{{@if title = "x"}}y{{/if}}', 1, 13, "Compare with ==");
		await refuses("{{@if title and}}y{{/if}}", 1, 16, "Expected a value");
		await refuses("{{@if}}y{{/if}}", 1, 1, "{{@if}} needs a test");
		await refuses("{{@if summary}}a{{@else summary}}b{{/if}}", 1, 24, "{{@else}} takes no test");
	});

	test("branches outside their Condition, and Conditions never closed", async () => {
		await refuses(
			"{{@if title}}<div>{{@else}}</div>{{/if}}",
			1,
			19,
			"must be directly inside {{@if}}: <div> on line 1",
		);
		await refuses("<p>x</p>{{@else}}", 1, 9, "{{@else}} belongs inside {{@if}}");
		await refuses("{{@if title}}\n<p>x</p>", 1, 1, "{{@if}} on line 1 has no {{/if}}");
		await refuses("<div>{{@if title}}x</div>{{/if}}", 1, 20, "</div> comes before {{/if}}");
		await refuses("{{@if title}}x{{@else}}y{{@else if summary}}z{{/if}}", 1, 25, "{{@else if}} goes before {{@else}}");
	});
});

test("every problem is reported, in order, up to 20", async () => {
	const problems = await problemsOf(
		["<article>", "  <p>{{ price }}</p>", '  <a onclick="x">y</a>', "  <p>{{ cost }}</p>", "</article>"].join("\n"),
	);
	expect(problems.map(({ line, column }) => [line, column])).toEqual([
		[2, 9],
		[3, 6],
		[4, 9],
	]);

	const many = await problemsOf(Array.from({ length: 30 }, (_, index) => `<p>{{ missing${index} }}</p>`).join("\n"));
	expect(many).toHaveLength(20);
	expect(many[19]).toMatchObject({ line: 20, column: 7 });
});

describe("limits", () => {
	test("elements nest at most 64 deep", async () => {
		const deep = (levels: number) => `${"<div>".repeat(levels)}x${"</div>".repeat(levels)}`;

		await expect(
			staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: deep(63) }),
		).resolves.toBeDefined();
		await refuses(deep(64), 1, 321, "Elements nest at most 64 deep");
		await refuses(`${"{{@if title}}".repeat(64)}x${"{{/if}}".repeat(64)}`, 1, 833, "Elements nest at most 64 deep");
	});

	test("a test nests at most 32 deep", async () => {
		const chain = Array.from({ length: 33 }, () => "title").join(" and ");

		await refuses(`{{@if ${chain}}}x{{/if}}`, 1, 6, "A test nests at most 32 deep");
	});

	test("a very long and/or chain is refused the same way, not crashed on", async () => {
		for (const joiner of [" and ", " or "]) {
			const chain = Array.from({ length: 40_000 }, () => "title").join(joiner);

			await refuses(`{{@if ${chain}}}x{{/if}}`, 1, 6, "A test nests at most 32 deep");
		}
	});

	test("a Template holds at most 10,000 nodes", async () => {
		const problems = await problemsOf("<br>".repeat(10_001));

		expect(problems).toEqual([{ line: 1, column: 40_001, message: expect.stringContaining("at most 10000 nodes") }]);
	});
});

test("a refused save changes nothing", async () => {
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<h1>{{ title }}</h1>",
	});

	await problemsOf("<h1>{{ title }}</h1><script></script>");

	expect((await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft).toBe(saved.markup);
});
