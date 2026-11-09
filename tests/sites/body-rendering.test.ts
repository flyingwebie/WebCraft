// A Body field on the page: `{{ body }}` renders its Blocks as semantic HTML, escaped, with no
// classes but WebCraft's reserved `wc-callout` and `wc-embed` hooks. Images come from the Media
// library (alt text and caption in the page's language), videos load nothing from YouTube or Vimeo
// until the visitor clicks, and Templates read `body.excerpt`, `body.image`, `body.reading_time`
// and `body.toc`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let articlesId: string;
let topicsId: string;

type MediaView = Awaited<ReturnType<TestBrowser["api"]["media"]["get"]>>["media"];

/** A URL on the Site's Staging address. */
const onSite = (path: string) => `https://bakery.sites.test${path}`;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	// These tests are about the body itself: no Consent banner holds its videos back (tests/consent/).
	await staff.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" });
	topicsId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Topics",
			key: "topics",
			urlPattern: "/topics/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		})
	).postType.id;
	articlesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Articles",
			key: "articles",
			urlPattern: "/articles/{slug}",
			fields: [
				{ key: "body", label: "Body", type: "body" },
				{ key: "topic", label: "Topic", type: "relationship", postTypes: ["topics"] },
			],
		})
	).postType.id;
});

afterAll(async () => {
	await install.close();
});

/** Publishes the Articles Entry template, written as Template markup. */
async function template(markup: string) {
	const { template: saved } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: articlesId,
		markup,
	});
	await staff.api.templates.publish({ siteId, templateId: saved.id });
}

let articles = 0;

/** Publishes an Article with `body` (and other Fields), and answers its whole page. */
async function article(body: unknown, fields: Record<string, unknown> = {}): Promise<string> {
	const slug = `article-${++articles}`;
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: articlesId,
		title: "Spring menu",
		slug,
		fields: { body, ...fields },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const response = await install.request(onSite(`/articles/${slug}`));
	expect(response.status).toBe(200);
	return expectSafePage(response);
}

function mainOf(html: string): string {
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

async function uploadImage(name: string, options: { alt?: string; caption?: string } = {}): Promise<MediaView> {
	const { media } = await editor.api.media.upload({
		siteId,
		file: upload(await photo({ width: 800, height: 600 }), name),
	});
	if (options.alt || options.caption) {
		await editor.api.media.update({ siteId, mediaId: media.id, alt: options.alt, caption: options.caption });
	}
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await editor.api.media.get({ siteId, mediaId: media.id })).media;
}

/** The <picture> WebCraft writes for a Media image, as the API describes its files. */
function picture(media: MediaView, img: string): string {
	const srcset = (format: string) =>
		media.variants
			.filter((variant) => variant.format === format)
			.sort((a, b) => a.width - b.width)
			.map((variant) => `${variant.url} ${variant.width}w`)
			.join(", ");
	const sizes = `(min-width: ${media.width}px) ${media.width}px, 100vw`;
	return [
		"<picture>",
		`<source type="image/avif" srcset="${srcset("avif")}" sizes="${sizes}">`,
		`<source type="image/webp" srcset="${srcset("webp")}" sizes="${sizes}">`,
		img,
		"</picture>",
	].join("");
}

describe("{{ body }} on a page", () => {
	test("every Block renders as semantic HTML, escaped, with no classes but the reserved hooks", async () => {
		await template("<article><h1>{{ title }}</h1><div>{{ body }}</div></article>");
		const html = await article([
			{
				type: "paragraph",
				text: [
					{ text: "Bake at " },
					{ text: "220 °C", marks: ["bold"] },
					{ text: " & rest " },
					{ text: "40 min", link: "/guides/timing?x=1&y=2" },
					{ text: "\nthen cool <script>." },
				],
			},
			{
				type: "paragraph",
				text: [
					{ text: "See " },
					{ text: "our ", link: 'https://example.com/a"b' },
					{ text: "guide", link: 'https://example.com/a"b', marks: ["italic", "strike", "code"] },
				],
			},
			{ type: "heading", level: 2, text: "How we bake" },
			{ type: "heading", level: 3, text: "Crème brûlée" },
			{ type: "heading", level: 2, text: "How we bake" },
			{ type: "heading", level: 4, text: "Notes", anchor: "notes-2027" },
			{ type: "list", style: "bulleted", items: ["Flour", { text: "Water", items: ["Warm"] }] },
			{ type: "list", style: "numbered", items: ["Mix", "Bake"] },
			{ type: "quote", text: "Bread is <life>." },
			{
				type: "table",
				rows: [
					["Loaf", "Price"],
					["Rye", "€4"],
				],
			},
			{ type: "table", headerRow: false, rows: [["a", "b"]] },
			{ type: "callout", tone: "warning", text: "Hot surfaces." },
			{ type: "code", code: "<b>bake</b>\n  done", language: "html" },
			{ type: "divider" },
			{ type: "toggle", summary: "Allergens", text: "Gluten." },
			{ type: "toggle", summary: "Nothing inside" },
			// Blocks with nothing in them show nothing.
			{ type: "paragraph", text: "  " },
			{ type: "image", media: null },
			{ type: "video", url: "" },
			{ type: "list", items: [""] },
		]);

		expect(mainOf(html)).toBe(
			[
				"<article><h1>Spring menu</h1><div>",
				'<p>Bake at <strong>220 °C</strong> &amp; rest <a href="/guides/timing?x=1&amp;y=2">40 min</a><br>then cool &lt;script&gt;.</p>',
				'<p>See <a href="https://example.com/a&quot;b">our <em><s><code>guide</code></s></em></a></p>',
				'<h2 id="how-we-bake">How we bake</h2>',
				'<h3 id="creme-brulee">Crème brûlée</h3>',
				'<h2 id="how-we-bake-2">How we bake</h2>',
				'<h4 id="notes-2027">Notes</h4>',
				"<ul><li>Flour</li><li>Water<ul><li>Warm</li></ul></li></ul>",
				"<ol><li>Mix</li><li>Bake</li></ol>",
				"<blockquote><p>Bread is &lt;life&gt;.</p></blockquote>",
				'<table><thead><tr><th scope="col">Loaf</th><th scope="col">Price</th></tr></thead><tbody><tr><td>Rye</td><td>€4</td></tr></tbody></table>',
				"<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>",
				'<aside class="wc-callout" data-tone="warning"><p>Hot surfaces.</p></aside>',
				'<pre><code data-language="html">&lt;b&gt;bake&lt;/b&gt;\n  done</code></pre>',
				"<hr>",
				"<details><summary>Allergens</summary><p>Gluten.</p></details>",
				"<details><summary>Nothing inside</summary></details>",
				"</div></article>",
			].join(""),
		);
		// Without a video, the page links no script.
		expect(html).not.toContain("<script");
	});

	test("an image shows the Media item's alt text and caption; the first in <main> loads first", async () => {
		await template("<article>{{ body }}</article>");
		const loaf = await uploadImage("loaf.jpg", { alt: "A round loaf", caption: "Our <best> loaf" });
		const crumb = await uploadImage("crumb.jpg");

		const html = await article([
			{ type: "image", media: loaf.id },
			{ type: "image", media: crumb.id },
		]);

		expect(mainOf(html)).toBe(
			[
				"<article><figure>",
				picture(
					loaf,
					`<img src="${loaf.url}" alt="A round loaf" width="800" height="600" loading="eager" fetchpriority="high">`,
				),
				"<figcaption>Our &lt;best&gt; loaf</figcaption></figure><figure>",
				picture(crumb, `<img src="${crumb.url}" alt="" width="800" height="600" loading="lazy">`),
				"</figure></article>",
			].join(""),
		);
	});

	test("a video is a link to it until the visitor clicks: the embed script, a file of the Site, swaps in the player", async () => {
		await template("<article>{{ body }}</article>");
		const html = await article([
			{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90", title: 'Shaping a "loaf"' },
			{ type: "video", url: "https://vimeo.com/76979871" },
			// Anything but YouTube and Vimeo shows nothing (and keeps the Entry from being published).
		]);

		expect(mainOf(html)).toBe(
			[
				"<article>",
				'<figure class="wc-embed"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s" data-wc-embed="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&amp;start=90" data-wc-title="Shaping a &quot;loaf&quot;">Play video: Shaping a "loaf"</a></figure>',
				'<figure class="wc-embed"><a href="https://vimeo.com/76979871" data-wc-embed="https://player.vimeo.com/video/76979871?autoplay=1&amp;dnt=1" data-wc-title="Video">Play video</a></figure>',
				"</article>",
			].join(""),
		);
		// Nothing loads from the providers before a click: no frame, no image, no script of theirs.
		expect(html).not.toContain("<iframe");
		expect(html).not.toMatch(/src="https:\/\/[^"]*(youtube|vimeo|ytimg)/);

		const script = /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer><\/script>/.exec(html)?.[1];
		expect(script).toBeDefined();
		const served = await install.request(onSite(script ?? ""));
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(served.headers.get("cache-control")).toContain("immutable");
		const text = await served.text();
		expect(text).toContain("https://www.youtube-nocookie.com");
		expect(text).toContain("https://player.vimeo.com");
	});

	test("in an attribute or through a formatter, a body is its text", async () => {
		await template('<article data-text="{{ body }}"><p>{{ body | truncate: 12 }}</p></article>');
		const html = await article([
			{ type: "heading", level: 2, text: "Rye" },
			{ type: "paragraph", text: [{ text: 'Dark "and" ' }, { text: "sour", marks: ["bold"] }] },
		]);

		expect(mainOf(html)).toBe('<article data-text="Rye Dark &quot;and&quot; sour"><p>Rye Dark…</p></article>');
	});
});

describe("what Templates read from a body", () => {
	test("body.excerpt, body.image, body.reading_time and body.toc", async () => {
		await template(
			[
				"<article>",
				"<p>{{ body.excerpt | truncate: 30 }}</p>",
				'<img src="{{ body.image }}">',
				"<p>{{ body.reading_time }} min read</p>",
				'{{@if body.toc}}<nav aria-label="Contents">{{ body.toc }}</nav>{{/if}}',
				"{{ body }}",
				"</article>",
			].join(""),
		);
		const cover = await uploadImage("cover.jpg", { alt: "Loaves on a shelf" });
		const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");

		const html = await article([
			{ type: "code", code: "not an excerpt" },
			{ type: "paragraph", text: "  " },
			{
				type: "paragraph",
				text: [{ text: "Three new loaves\n" }, { text: "and a tart", marks: ["bold"] }, { text: " for spring." }],
			},
			{ type: "image", media: null },
			{ type: "image", media: cover.id },
			{ type: "heading", level: 2, text: "Rye & spelt" },
			{ type: "heading", level: 3, text: "Starter" },
			{ type: "heading", level: 4, text: "Feeding" },
			{ type: "heading", level: 2, text: "Tart" },
			{ type: "paragraph", text: words(400) },
		]);

		const main = mainOf(html);
		expect(main).toStartWith(
			[
				"<article>",
				"<p>Three new loaves and a tart…</p>",
				picture(
					cover,
					`<img src="${cover.url}" alt="Loaves on a shelf" width="800" height="600" loading="eager" fetchpriority="high">`,
				),
				// 416 words in all (code and headings too): three minutes at 200 a minute.
				"<p>3 min read</p>",
				'<nav aria-label="Contents"><ol>',
				'<li><a href="#rye-spelt">Rye &amp; spelt</a><ol><li><a href="#starter">Starter</a><ol><li><a href="#feeding">Feeding</a></li></ol></li></ol></li>',
				'<li><a href="#tart">Tart</a></li>',
				"</ol></nav>",
			].join(""),
		);
		// The body's own copy of the image is the page's second, so it loads lazily.
		expect(main).toContain(
			`<figure>${picture(cover, `<img src="${cover.url}" alt="Loaves on a shelf" width="800" height="600" loading="lazy">`)}</figure>`,
		);
	});

	test("an empty body reads as nothing", async () => {
		await template(
			"<article><p>[{{ body.excerpt }}][{{ body.image }}][{{ body.reading_time }}][{{ body.toc }}]</p>{{@if body}}<div>{{ body }}</div>{{@else}}<p>Empty</p>{{/if}}{{@if body.toc}}<nav>Contents</nav>{{/if}}</article>",
		);

		expect(mainOf(await article([{ type: "paragraph", text: "" }]))).toBe(
			"<article><p>[][][0][]</p><p>Empty</p></article>",
		);
	});

	test("what a body's Entry points at shows through a Relationship", async () => {
		await template(
			"<article>{{ topic.title }}: {{ topic.body.excerpt }} ({{ topic.body.reading_time }} min)</article>",
		);
		const { entry: topic } = await editor.api.entries.create({
			siteId,
			postTypeId: topicsId,
			title: "Baking",
			fields: { body: [{ type: "paragraph", text: "All about bread." }] },
		});
		await editor.api.entries.publish({ siteId, entryId: topic.id });

		expect(mainOf(await article(null, { topic: topic.id }))).toBe(
			"<article>Baking: All about bread. (1 min)</article>",
		);
	});

	test("a Template can't read a part a body doesn't have", async () => {
		await expect(
			staff.api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: articlesId,
				markup: "<p>{{ body.summary }}</p>",
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
		await expect(
			staff.api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: articlesId,
				markup: "<p>{{ body.toc.text }}</p>",
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
	});
});

describe("in Edit mode", () => {
	test("the body shows its Draft and isn't an editable region (Blocks are edited in the admin for now)", async () => {
		await template("<article><h1>{{ title }}</h1><div>{{ body }}</div></article>");
		const slug = `article-${++articles}`;
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId: articlesId,
			title: "Spring menu",
			slug,
			fields: { body: [{ type: "paragraph", text: "Published text." }] },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { body: [{ type: "callout", tone: "info", text: "Draft text." }] },
		});

		const editing = await openEditMode(install, editor, siteId, `/articles/${slug}`);
		const main = mainOf(await (await editing.page(`/articles/${slug}`)).text());
		expect(main).toContain('<div><aside class="wc-callout" data-tone="info"><p>Draft text.</p></aside></div>');
		expect(main).toContain(`data-wc-item="entry:${entry.id}" data-wc-field="title"`);
		expect(main).not.toContain('data-wc-field="body"');

		// Visitors still see what is published.
		expect(mainOf(await (await install.request(onSite(`/articles/${slug}`))).text())).toContain(
			"<div><p>Published text.</p></div>",
		);
	});
});

describe("in the Site's other languages", () => {
	test("each language keeps its own Blocks, each naming the Block it translates; a language without falls back", async () => {
		const french = (await install.createSite((await install.createWorkspace("Maison Ltd")).id, { slug: "maison" })).id;
		const owner = await install.superadmin();
		await owner.api.consentBanner.setSettings({ siteId: french, mode: "none", layout: "bar" });
		await owner.api.languages.add({ siteId: french, code: "fr" });
		const { postType } = await owner.api.postTypes.create({
			siteId: french,
			name: "Articles",
			urlPattern: "/articles/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		});
		const saved = await owner.api.templates.saveEntryTemplateMarkup({
			siteId: french,
			postTypeId: postType.id,
			markup: "<article>{{ body }}</article>",
		});
		await owner.api.templates.publish({ siteId: french, templateId: saved.template.id });
		const create = async (slug: string) =>
			(
				await owner.api.entries.create({
					siteId: french,
					postTypeId: postType.id,
					title: "Bread",
					slug,
					fields: {
						body: [
							{ id: "intro", type: "paragraph", text: "Fresh bread." },
							{ id: "film", type: "video", url: "https://vimeo.com/76979871" },
						],
					},
				})
			).entry;
		const translated = await create("translated");
		const untranslated = await create("untranslated");

		const { entry } = await owner.api.entries.saveDraft({
			siteId: french,
			entryId: translated.id,
			language: "fr",
			fields: {
				body: [
					{ id: "intro-fr", type: "paragraph", text: "Pain frais.", source: { id: "intro", by: "person" } },
					{ id: "film-fr", type: "video", url: "https://vimeo.com/76979871", source: { id: "film", by: "ai" } },
				],
			},
		});
		expect(entry.draft.fields.body).toEqual([
			{ id: "intro-fr", type: "paragraph", text: [{ text: "Pain frais." }], source: { id: "intro", by: "person" } },
			{ id: "film-fr", type: "video", url: "https://vimeo.com/76979871", title: "", source: { id: "film", by: "ai" } },
		]);
		const english = (await owner.api.entries.get({ siteId: french, entryId: translated.id })).entry;
		expect((english.draft.fields.body as { id: string }[]).map((block) => block.id)).toEqual(["intro", "film"]);

		await owner.api.entries.publish({ siteId: french, entryId: translated.id });
		await owner.api.entries.publish({ siteId: french, entryId: untranslated.id });
		const page = async (path: string) =>
			mainOf(await (await install.request(`https://maison.sites.test${path}`)).text());
		expect(await page("/fr/articles/translated")).toStartWith(
			'<article><p>Pain frais.</p><figure class="wc-embed"><a href="https://vimeo.com/76979871" data-wc-embed="https://player.vimeo.com/video/76979871?autoplay=1&amp;dnt=1" data-wc-title="Vidéo">Lire la vidéo</a></figure>',
		);
		expect(await page("/articles/translated")).toStartWith("<article><p>Fresh bread.</p>");
		expect(await page("/fr/articles/untranslated")).toStartWith("<article><p>Fresh bread.</p>");
	});
});
