// Rich text: short formatted text kept as HTML, cleaned against an allowlist when it is saved and
// again when it renders, so nothing outside the allowlist ever reaches a page (ADR 0017).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let postTypes = 0;

/** A Post Type with a rich text Field `body` and a published Entry template written as `markup`. */
async function postTypeWith(markup: string): Promise<{ postTypeId: string; key: string }> {
	const key = `notes-${++postTypes}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Notes ${postTypes}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: [{ key: "body", label: "Body text", type: "richText" }],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	return { postTypeId: postType.id, key };
}

const DIRTY = [
	'<p onclick="steal()" class="lead" style="color:red">Hello <strong>world</strong><script>alert(1)</script></p>',
	'<img src="x" onerror="alert(1)">',
	'<a href="javascript:alert(1)" target="_blank">link</a> ',
	'<a href="https://example.com/" title="Example" rel="nofollow">ok</a>',
	"<div><h1>Heading</h1><ul><li>One<li>Two</ul></div>",
	"<!-- note --><style>p { color: red }</style>",
	'<a href=" java\tscript:alert(1)">tabbed</a><br/><em>end &amp; <code>&lt;b&gt;</code></em>',
	'<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
	// Never closed: a browser reads the rest of the text inside it, so all of it is dropped.
	'<svg><a href="/x">in svg</a></svg><math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
].join("");

const CLEAN = [
	"<p>Hello <strong>world</strong></p>",
	'<a href="#">link</a> ',
	'<a href="https://example.com/" title="Example">ok</a>',
	"Heading<ul><li>One</li><li>Two</li></ul>",
	'<a href="#">tabbed</a><br><em>end &amp; <code>&lt;b&gt;</code></em>',
	// <noscript> is read as plain text up to </noscript>, as browsers read it: what follows the
	// dropped <img> is text.
	'"&gt;',
].join("");

describe("on save", () => {
	test("only allowed elements and attributes are kept, and link addresses keep only safe schemes", async () => {
		const { postTypeId } = await postTypeWith("<div>{{ body }}</div>");

		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Dirty", fields: { body: DIRTY } });

		expect(entry.draft.fields.body).toBe(CLEAN);
		expect((await editor.api.entries.get({ siteId, entryId: entry.id })).entry.draft.fields.body).toBe(CLEAN);
	});

	test("saving clean rich text keeps it as it is", async () => {
		const { postTypeId } = await postTypeWith("<div>{{ body }}</div>");
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Clean", fields: { body: CLEAN } });

		expect(entry.draft.fields.body).toBe(CLEAN);
	});

	test("rich text with no text left after cleaning is empty", async () => {
		const { postTypeId } = await postTypeWith("{{@if body}}<div>{{ body }}</div>{{@else}}<p>No text</p>{{/if}}");

		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Empty",
			fields: { body: "<script>alert(1)</script><p> </p>" },
		});

		expect(entry.draft.fields.body).toBeNull();
	});
});

describe("on render", () => {
	test("rich text renders as its HTML in text, as its text in attributes and through formatters", async () => {
		const { postTypeId, key } = await postTypeWith(
			'<article title="{{ body }}"><div>{{ body }}</div><p>{{ body | truncate: 11 }}</p></article>',
		);
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Shown",
			fields: { body: '<p>Fresh <em>"bread"</em> &amp; <a href="/menu">more</a></p>' },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const html = await (await install.request(`https://bakery.sites.test/${key}/shown`)).text();

		expect(html).toContain(
			'<main id="wc-main" tabindex="-1"><article title="Fresh &quot;bread&quot; &amp; more">' +
				'<div><p>Fresh <em>"bread"</em> &amp; <a href="/menu">more</a></p></div>' +
				"<p>Fresh…</p></article></main>",
		);
	});

	test("rich text changed outside WebCraft is cleaned again before it reaches a page", async () => {
		const { postTypeId, key } = await postTypeWith("<div>{{ body }}</div>");
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Tampered",
			fields: { body: "<p>Fine</p>" },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		// Act as someone with write access to the database, as tests/secrets/tampering.test.ts does:
		// there is no other way to store rich text that wasn't cleaned on save.
		const database = new pg.Client({ connectionString: install.databaseUrl });
		await database.connect();
		try {
			await database.query(
				`UPDATE entries SET published = jsonb_set(published, '{values,body,en,value}', to_jsonb($1::text)) WHERE id = $2`,
				[DIRTY, entry.id],
			);
		} finally {
			await database.end();
		}

		// The page is rendered for the first time now, from the changed published version.
		const html = await (await install.request(`https://bakery.sites.test/${key}/tampered`)).text();

		expect(html).toContain(`<main id="wc-main" tabindex="-1"><div>${CLEAN}</div></main>`);
	});
});
