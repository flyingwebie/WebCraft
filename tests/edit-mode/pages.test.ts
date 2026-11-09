// A page in Edit mode is the real page on the Site's own domain, showing the Drafts of its Content,
// with every editable region tagged from the Template's bindings and WebCraft's editing bar loaded
// first. It is never cached and never indexed. Visitors get the published page, with none of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = { siteId: string; origin: string; entryId: string; postTypeId: string };

/**
 * A Site whose Site template shows two Globals, and a published Blog post at /blog/fresh-bread with
 * a text, a rich text, a Group and a number Field, shown alone and in ways that can't be edited in place.
 */
async function bakery(): Promise<Bakery> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await staff.api.globals.setFields({
		siteId,
		fields: [
			{ key: "tagline", label: "Tagline", type: "text" },
			{ key: "phone", label: "Phone", type: "text" },
		],
	});
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily", phone: "021 455 0199" } });
	await editor.api.globals.publish({ siteId });
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			"<header><p>{{ site.tagline }}</p></header><main>{{@outlet}}</main><footer><p>Call {{ site.phone }}</p></footer>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
			{ key: "price", label: "Price", type: "number" },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article>",
			"<h1>{{ title }}</h1>",
			"<p>{{ subtitle }}</p>",
			"<div>{{ intro }}</div>",
			"<p>{{ address.city }}</p>",
			"<p>{{ price }}</p>",
			"<p>{{ title | truncate: 8 }}</p>",
			"<p>By {{ subtitle }}</p>",
			"</article>",
		].join(""),
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: {
			subtitle: "Out of the oven",
			intro: "<p>Baked at <strong>seven</strong>.</p>",
			address: { city: "Cork" },
			price: 4,
		},
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, origin: `https://${slug}.sites.test`, entryId: entry.id, postTypeId: postType.id };
}

/** The <body> of a page's HTML. */
function bodyOf(html: string): string {
	return /<body>\n([\s\S]*)\n<\/body>/.exec(html)?.[1] ?? "";
}

/** The <head> of a page's HTML. */
function headOf(html: string): string {
	return /<head>\n([\s\S]*)\n<\/head>/.exec(html)?.[1] ?? "";
}

describe("a page in Edit mode", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: site.entryId,
			title: "Fresher bread",
			fields: { subtitle: "Still warm" },
		});
		await editor.api.globals.saveDraft({ siteId: site.siteId, fields: { tagline: "Baked twice daily" } });
		editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
	});

	test("shows the Drafts of its Entry and of the Globals, its editable regions tagged with what they hold", async () => {
		const response = await editing.page("/blog/fresh-bread");
		expect(response.status).toBe(200);
		const body = bodyOf(await response.text());
		const entry = `entry:${site.entryId}`;
		const id = '="[A-Za-z0-9_-]+"';

		expect(body).toMatch(
			new RegExp(
				`<p data-wc-item="globals" data-wc-field="tagline" data-wc-type="text" data-wc-label="Tagline" data-wc-id${id}>Baked twice daily</p>`,
			),
		);
		expect(body).toMatch(
			new RegExp(
				`<h1 data-wc-item="${entry}" data-wc-field="title" data-wc-type="text" data-wc-id${id}>Fresher bread</h1>`,
			),
		);
		expect(body).toMatch(
			new RegExp(
				`<p data-wc-item="${entry}" data-wc-field="subtitle" data-wc-type="text" data-wc-label="Subtitle" data-wc-id${id}>Still warm</p>`,
			),
		);
		expect(body).toMatch(
			new RegExp(
				`<div data-wc-item="${entry}" data-wc-field="intro" data-wc-type="richText" data-wc-label="Intro" data-wc-id${id}><p>Baked at <strong>seven</strong>.</p></div>`,
			),
		);
		expect(body).toMatch(
			new RegExp(
				`<p data-wc-item="${entry}" data-wc-field="address.city" data-wc-type="text" data-wc-label="Address › City" data-wc-id${id}>Cork</p>`,
			),
		);
		// A number, a value through a formatter and a value beside other text can't be typed over in place.
		expect(body).toContain("<p>4</p>");
		expect(body).toContain("<p>Fresher…</p>");
		expect(body).toContain("<p>By Still warm</p>");
		expect(body).toContain("<footer><p>Call 021 455 0199</p></footer>");
	});

	test("loads WebCraft's editing bar first, as files from the Site's own domain, and is never indexed", async () => {
		const head = headOf(await (await editing.page("/blog/fresh-bread")).text());

		expect(head).toMatch(
			new RegExp(
				[
					'<meta charset="utf-8">',
					'<meta name="viewport" content="width=device-width, initial-scale=1">',
					'<meta name="robots" content="noindex, nofollow">',
					'<meta name="webcraft-edit-token" content="[A-Za-z0-9_-]{43}">',
					'<script src="/_webcraft/edit/assets/bar-[0-9a-f]{16}\\.js"></script>',
					'<link rel="stylesheet" href="/_webcraft/edit/assets/page-[0-9a-f]{16}\\.css">',
					"<title>Fresher bread · Acme Bakery</title>",
				].join("\n"),
			),
		);
	});

	test("the editing bar's files answer at their hashed names, for a year, and nothing else does", async () => {
		const head = headOf(await (await editing.page("/blog/fresh-bread")).text());
		const script = /<script src="([^"]+)">/.exec(head)?.[1] ?? "";
		const stylesheet = /<link rel="stylesheet" href="([^"]+)">/.exec(head)?.[1] ?? "";

		for (const [path, type] of [
			[script, "text/javascript; charset=utf-8"],
			[stylesheet, "text/css; charset=utf-8"],
		] as const) {
			const response = await install.request(`${site.origin}${path}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(type);
			expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect((await response.text()).length).toBeGreaterThan(0);
		}
		const made = await install.request(`${site.origin}/_webcraft/edit/assets/bar-0000000000000000.js`);
		expect(made.status).toBe(404);
	});

	test("is never kept by the page cache, browsers or proxies, and has a strict policy for scripts", async () => {
		const response = await editing.page("/blog/fresh-bread");

		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("etag")).toBeNull();
		expect(response.headers.get("x-cache")).toBeNull();
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
		const policy = response.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("script-src 'self'");
		expect(policy).toContain("style-src 'self'");
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).not.toContain("unsafe-inline");
	});

	test("carries no script but WebCraft's own, and nothing inline", async () => {
		const html = await (await editing.page("/blog/fresh-bread")).text();

		expect(html.match(/<script\b[^>]*>/g)).toEqual([
			expect.stringMatching(/^<script src="\/_webcraft\/edit\/assets\//),
		]);
		expect(html).not.toMatch(/<script>|<style|\sstyle=|\son[a-z]+=/i);
	});

	test("leaves what visitors get alone: the published page, without tags or the editing bar", async () => {
		await editing.page("/blog/fresh-bread");

		const response = await install.request(`${site.origin}/blog/fresh-bread`);
		const html = await response.text();

		expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(bodyOf(html)).toContain("<h1>Fresh bread</h1>");
		expect(bodyOf(html)).toContain("<p>Out of the oven</p>");
		expect(bodyOf(html)).toContain("<header><p>Baked daily</p></header>");
		expect(html).not.toContain("data-wc-");
		expect(html).not.toContain("webcraft-edit");
		expect(html).not.toContain("<script");

		// And a visitor's page kept in the page cache never reaches Edit mode.
		expect((await install.request(`${site.origin}/blog/fresh-bread`)).headers.get("x-cache")).toBe("HIT");
		expect(bodyOf(await (await editing.page("/blog/fresh-bread")).text())).toContain(">Fresher bread</h1>");
	});

	test("a path with no page shows the 404 page in Edit mode, the Globals still editable", async () => {
		const response = await editing.page("/no-such-page");

		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const html = await response.text();
		expect(headOf(html)).toContain('<meta name="robots" content="noindex, nofollow">');
		expect(bodyOf(html)).toMatch(/<p data-wc-item="globals" data-wc-field="tagline"[^>]*>Baked twice daily<\/p>/);
	});
});
