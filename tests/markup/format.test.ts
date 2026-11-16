// Format at its interface (SPEC 5.1): `format(text, language, { range, caret })` tidies HTML with
// Template markup, CSS and JavaScript in one house style, formats only the selected lines when asked,
// keeps the caret on its word, and answers a problem with its line when the code can't be read.
import { describe, expect, test } from "bun:test";

import { format } from "@webcraft/server/code-format";

async function formatted(text: string, language: "html" | "css" | "js", options = {}) {
	const result = await format(text, language, options);
	if (!result.ok) throw new Error(`can't format: ${result.reason} on line ${result.line}`);
	return result;
}

describe("the house style", () => {
	test("CSS: a rule per line, 2 spaces", async () => {
		const result = await formatted(
			".hero__title{font-family:var(--font-display);font-size:var(--step-5);line-height:1.05;color:var(--ink)}\n.hero__title:hover{color:var(--brand)}",
			"css",
		);
		expect(result.text).toBe(
			[
				".hero__title {",
				"  font-family: var(--font-display);",
				"  font-size: var(--step-5);",
				"  line-height: 1.05;",
				"  color: var(--ink);",
				"}",
				".hero__title:hover {",
				"  color: var(--brand);",
				"}",
			].join("\n"),
		);
		expect(result.changedLines).toBe(9);
	});

	test("CSS: bare declarations (a Class's styles) and nesting", async () => {
		expect((await formatted("color:red;font-size:var(--step-5)", "css")).text).toBe(
			"color: red;\nfont-size: var(--step-5);",
		);
		expect((await formatted("&:hover{color:red}", "css")).text).toBe("&:hover {\n  color: red;\n}");
	});

	test("JS: double quotes, semicolons, 2 spaces, lines up to 100", async () => {
		const result = await formatted(
			"const hero=document.querySelector('.hero');if(hero){hero.classList.add('is-ready')}\ndocument.querySelectorAll('.bake').forEach(function(card){card.addEventListener('click',()=>{card.classList.toggle('is-open')})})",
			"js",
		);
		expect(result.text).toBe(
			[
				'const hero = document.querySelector(".hero");',
				"if (hero) {",
				'  hero.classList.add("is-ready");',
				"}",
				'document.querySelectorAll(".bake").forEach(function (card) {',
				'  card.addEventListener("click", () => {',
				'    card.classList.toggle("is-open");',
				"  });",
				"});",
			].join("\n"),
		);
		expect(result.changedLines).toBe(9);
	});

	test("JS: a script may return at its top level", async () => {
		expect((await formatted("if(x)return 1", "js")).text).toBe("if (x) return 1;");
	});

	test("a blank line stays where there was one, and several become one", async () => {
		expect((await formatted("a{color:red}\n\n\n\nb{color:blue}", "css")).text).toBe(
			"a {\n  color: red;\n}\n\nb {\n  color: blue;\n}",
		);
		expect((await formatted("const a=1\n\nconst b=2", "js")).text).toBe("const a = 1;\n\nconst b = 2;");
		expect((await formatted("<p>a</p>\n\n\n<p>b</p>", "html")).text).toBe("<p>a</p>\n\n<p>b</p>");
	});

	test("already tidy: the same text, no line changed; formatting twice is formatting once", async () => {
		const tidy = ".hero__lead {\n  color: var(--ink-soft);\n  max-inline-size: 48ch;\n}";
		const result = await formatted(tidy, "css");
		expect(result.text).toBe(tidy);
		expect(result.changedLines).toBe(0);
		const once = (await formatted("<section><div><h1>{{ props.headline }}</h1></div></section>", "html")).text;
		expect(await formatted(once, "html")).toMatchObject({ text: once, changedLines: 0 });
	});

	test("an empty box is already tidy", async () => {
		expect(await formatted("", "js")).toMatchObject({ text: "", changedLines: 0 });
	});

	test("the end of the text stays as it was: a line break only where there was one", async () => {
		expect((await formatted("a{color:red}", "css")).text.endsWith("}")).toBe(true);
		expect((await formatted("a{color:red}\n", "css")).text.endsWith("}\n")).toBe(true);
	});
});

describe("Template markup", () => {
	test("a block command indents what it holds like a tag; values and commands stay whole", async () => {
		const result = await formatted(
			'<h2 class="posts__title">{{ props.title }}</h2>{{@loop latest-posts as post}}<article class="post"><h3>{{ post.title }}</h3><p>{{ post.excerpt }}</p></article>{{@empty}}<p>No posts yet.</p>{{/loop}}',
			"html",
		);
		expect(result.text).toBe(
			[
				'<h2 class="posts__title">{{ props.title }}</h2>',
				"{{@loop latest-posts as post}}",
				'  <article class="post">',
				"    <h3>{{ post.title }}</h3>",
				"    <p>{{ post.excerpt }}</p>",
				"  </article>",
				"{{@empty}}",
				"  <p>No posts yet.</p>",
				"{{/loop}}",
			].join("\n"),
		);
		expect(result.changedLines).toBe(9);
	});

	test("Conditions: every branch indented, the test as written", async () => {
		expect(
			(
				await formatted(
					'<div>{{@if summary and status != "draft"}}<p>{{ summary }}</p>{{@else if author}}<p>By {{ author }}</p>{{@else}}<p>None</p>{{/if}}</div>',
					"html",
				)
			).text,
		).toBe(
			[
				"<div>",
				'  {{@if summary and status != "draft"}}',
				"    <p>{{ summary }}</p>",
				"  {{@else if author}}",
				"    <p>By {{ author }}</p>",
				"  {{@else}}",
				"    <p>None</p>",
				"  {{/if}}",
				"</div>",
			].join("\n"),
		);
	});

	test("a command inside text adds no white space a page would show", async () => {
		const text = "<p>Hello{{@if name}}, {{ name }}{{/if}}!</p>";
		expect((await formatted(text, "html")).text).toBe(text);
	});

	test("a long value is never split, and a value with quotes keeps its attribute's quotes", async () => {
		const long = `<p>${"word ".repeat(16)}{{ post.summary | truncate: 80 }} ${"more ".repeat(6)}</p>`;
		const result = (await formatted(long, "html")).text;
		expect(result).toContain("{{ post.summary | truncate: 80 }}");
		const quoted = `<img src="{{ image.url }}" alt='{{ "A photo" fr: "Une photo" }}'>`;
		const tidy = (await formatted(quoted, "html")).text;
		expect(tidy).toContain(`alt='{{ "A photo" fr: "Une photo" }}'`);
		expect(tidy).toContain(`src="{{ image.url }}"`);
	});

	test("Component tags stay whole, their Props as written", async () => {
		const tag = `<PostCard title="{{ post.title }}" heading='Say "hi"' data-wc-retained='{"a":1}' summary="A summary that is long enough to make the line go past one hundred characters" />`;
		const result = (await formatted(`<section>${tag}</section>`, "html")).text;
		expect(result).toContain(tag);
	});

	test("the Outlet and a Form: a block of their own between blocks", async () => {
		expect((await formatted("<main><h1>Title</h1>{{@outlet}}{{@form contact}}</main>", "html")).text).toBe(
			"<main>\n  <h1>Title</h1>\n  {{@outlet}}\n  {{@form contact}}\n</main>",
		);
	});

	test("a Component's {{@props}} block is kept as written", async () => {
		const props = "{{@props}}\ntitle:   text required\n{{/props}}";
		const result = (await formatted(`${props}\n<section><h2>{{ props.title }}</h2></section>`, "html")).text;
		expect(result.startsWith(`${props}\n`)).toBe(true);
	});

	test("literal {{ and entities are left as written", async () => {
		const text = "<p>Write \\{{ summary }} &amp; more</p>";
		expect((await formatted(text, "html")).text).toBe(text);
	});
});

describe("a selection: only the lines it touches", () => {
	test("the selected lines are formatted at their indentation; the others stay", async () => {
		const text = [
			'<section class="hero">',
			'  <div class="hero__copy">',
			'      <h1 class="hero__title">',
			"   {{ props.headline }}",
			"        </h1>",
			"    <p>untouched   text</p>",
			"  </div>",
			"</section>",
		].join("\n");
		const start = text.indexOf("<h1");
		const end = text.indexOf("</h1>") + 5;
		const result = await formatted(text, "html", { range: { start, end } });
		expect(result.text.split("\n")).toEqual([
			'<section class="hero">',
			'  <div class="hero__copy">',
			'      <h1 class="hero__title">{{ props.headline }}</h1>',
			"    <p>untouched   text</p>",
			"  </div>",
			"</section>",
		]);
		expect(result.changedLines).toBe(3);
	});

	test("CSS declarations and JS statements on their own", async () => {
		const css = ".a {\n  color:red;font-size:2px;\n  margin:0;\n}";
		const start = css.indexOf("color");
		const result = await formatted(css, "css", { range: { start, end: start + 5 } });
		expect(result.text).toBe(".a {\n  color: red;\n  font-size: 2px;\n  margin:0;\n}");
		const js = "function f() {\n  const a=1;const b=2\n  return a+b\n}";
		const at = js.indexOf("const");
		expect((await formatted(js, "js", { range: { start: at, end: at + 3 } })).text).toBe(
			"function f() {\n  const a = 1;\n  const b = 2;\n  return a+b\n}",
		);
	});
});

describe("broken code: nothing changes, the problem and its line", () => {
	test("CSS: an unexpected }", async () => {
		const css =
			".hero__title {\n  font-size: var(--step-5);\n  line-height: 1.05;\n}}\n.hero__lead {\n  color: red;\n}";
		expect(await format(css, "css")).toEqual({ ok: false, line: 4, reason: "unexpected }" });
	});

	test("JS: an unexpected token", async () => {
		const result = await format("const a = 1;\nconst x = {a:1\nfoo(", "js");
		expect(result).toMatchObject({ ok: false, line: 3 });
	});

	test("Template markup: an element or a command left open, an end that closes nothing, a {{ never closed", async () => {
		expect(await format("<div>\n  <p>open\n</div>", "html")).toMatchObject({ ok: false, line: 3 });
		expect(await format("<div>\n{{@if a}}\n<p>x</p>\n</div>", "html")).toMatchObject({ ok: false, line: 4 });
		expect(await format("<p>a</p>\n</div>", "html")).toMatchObject({ ok: false, line: 2 });
		expect(await format("<p>a</p>\n{{/loop}}", "html")).toMatchObject({ ok: false, line: 2 });
		expect(await format("<p>\n{{ title</p>", "html")).toMatchObject({ ok: false, line: 2 });
		expect(await format("<ul>\n  <li>{{@loop a as b}}x</li>\n</ul>", "html")).toMatchObject({ ok: false, line: 2 });
		expect(await format("{{@props}}\ntitle: text\n", "html")).toMatchObject({ ok: false, line: 1 });
	});

	test("in a selection, the problem's line is the line of the whole text", async () => {
		const text = "a {\n  color: red;\n}\nb {\n  color: blue;;}}\n}";
		const start = text.indexOf("b {");
		expect(await format(text, "css", { range: { start, end: text.length } })).toMatchObject({ ok: false, line: 5 });
	});
});

describe("the caret", () => {
	test("stays on the same word", async () => {
		const text = ".hero__title{font-family:var(--font-display);font-size:var(--step-5)}";
		const caret = text.indexOf("step-5") + 2;
		const result = await formatted(text, "css", { caret });
		expect(result.text.slice(result.caret - 2, result.caret + 4)).toBe("step-5");
		const markup = "<div><p>{{ post.excerpt }}</p></div>";
		const at = markup.indexOf("excerpt");
		const moved = await formatted(markup, "html", { caret: at });
		expect(moved.text.slice(moved.caret, moved.caret + 7)).toBe("excerpt");
	});
});
