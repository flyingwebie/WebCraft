// Links in Edit mode (BA-15): an `<a>` whose address and words are one link Field's
// (`<a href="{{ cta.url }}">{{ cta.text }}</a>`, an Entry's or the Globals') is tagged as a link
// region, which the building area's link popover changes in place. `save` takes the link's new value
// (its address, its words, whether it opens in a new tab, or null to remove it), checked by the link
// Field's own rules: an address a link may not go to is refused. The change goes to the Draft with its
// Undo receipt like typed text; once published, visitors get the link, in a new tab when it says so.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

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

type Bakery = { siteId: string; origin: string; entryId: string; menuId: string };

/**
 * A Site whose Recipes show a link Field as a button (`order`), the same link written as one binding
 * (`{{ more }}`), a link whose words go through a formatter, a Relationship's address, and the
 * Globals' contact link in the Site template; a published Recipe at /recipes/sourdough and a Page at
 * /menu.
 */
async function bakery(): Promise<Bakery> {
	const slug = `links-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.globals.setFields({ siteId, fields: [{ key: "contact", label: "Contact", type: "link" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { contact: { url: "mailto:hello@acme.test", text: "Write" } } });
	await editor.api.globals.publish({ siteId });
	const siteTemplate = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<main>{{@outlet}}</main><footer><a href="{{ site.contact.url }}">{{ site.contact.text }}</a></footer>',
	});
	await staff.api.templates.publish({ siteId, templateId: siteTemplate.template.id });
	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id;
	const { entry: menu } = await editor.api.entries.create({
		siteId,
		postTypeId: pagesId ?? "",
		title: "Menu",
		slug: "menu",
	});
	await editor.api.entries.publish({ siteId, entryId: menu.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "order", label: "Order button", type: "link" },
			{ key: "more", label: "More", type: "link" },
			{ key: "shout", label: "Shout", type: "link" },
			{ key: "related", label: "Related", type: "relationship", postTypes: ["page"] },
			{ key: "note", label: "Note", type: "text" },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article><h1>{{ title }}</h1>",
			'<a title="Order now" href="{{ order.url }}">{{ order.text }}</a>',
			'<a href="{{ more.url }}">{{ more }}</a>',
			'<a href="{{ shout.url }}">{{ shout.text | truncate: 3 }}</a>',
			'<a href="{{ related.url }}">{{ related.title }}</a>',
			'<a href="{{ more.url }}" target="_self">{{ more.text }} again</a>',
			"</article>",
		].join(""),
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Sourdough",
		fields: {
			order: { url: "/order", text: "Order a loaf" },
			more: { url: "https://example.test/more", text: "" },
			shout: { url: "/shout", text: "Hello" },
			related: menu.id,
		},
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, origin: `https://${slug}.live.test`, entryId: entry.id, menuId: menu.id };
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

/** The opening tags of the `<a>` elements of a page. */
function anchors(html: string): string[] {
	return [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
}

/** The opening tags of the elements a page tags as regions of `field`. */
function tagged(html: string, field: string): string[] {
	return [...html.matchAll(/<[a-z]+\b[^>]*>/g)]
		.map((match) => match[0])
		.filter((tag) => tag.includes(`data-wc-field="${field}"`));
}

describe("links on a page in Edit mode", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("an <a> showing a whole link Field is a link region, named by its label", async () => {
		const html = await (await editing.page("/recipes/sourdough")).text();

		const [order] = tagged(html, "order");
		expect(order).toStartWith("<a ");
		expect(order).toContain('href="/order"');
		expect(order).toContain(`data-wc-item="entry:${site.entryId}"`);
		expect(order).toContain('data-wc-type="link"');
		expect(order).toContain('data-wc-label="Order button"');
		expect(order).toMatch(/ data-wc-id="[^"]+"/);
		// The Template's own attributes stay.
		expect(order).toContain('title="Order now"');
		expect(html).toContain(">Order a loaf</a>");
		// The link written as one binding (its words, else its address) is one too.
		expect(tagged(html, "more")).toEqual([expect.stringContaining('data-wc-type="link"') as unknown as string]);
	});

	test("the Globals' link is a link region of the Globals", async () => {
		const html = await (await editing.page("/recipes/sourdough")).text();

		const [contact] = tagged(html, "contact");
		expect(contact).toContain('data-wc-item="globals"');
		expect(contact).toContain('data-wc-type="link"');
		expect(contact).toContain('href="mailto:hello@acme.test"');
	});

	test("words through a formatter, other words, a Relationship's address and plain text are no link region", async () => {
		const html = await (await editing.page("/recipes/sourdough")).text();

		expect(tagged(html, "shout")).toEqual([]);
		expect(tagged(html, "related")).toEqual([]);
		// The second `<a>` of `more` has words of its own besides the link's.
		expect(tagged(html, "more")).toHaveLength(1);
	});

	test("visitors' pages carry no tags", async () => {
		const html = await (await install.request(`${site.origin}/recipes/sourdough`)).text();

		expect(html).not.toContain("data-wc-");
		expect(anchors(html)).toContain('<a title="Order now" href="/order">');
	});
});

describe("saving a link", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("a link to a Page goes to the Draft with its Undo receipt; the page in Edit mode shows it", async () => {
		const response = await editing.edit("save", {
			item: `entry:${site.entryId}`,
			field: "order",
			value: { url: "/menu", text: "  See the menu  " },
		});

		expect(response.status).toBe(200);
		const saved = await json(response);
		expect(saved).toMatchObject({ status: "changed", value: { url: "/menu", text: "See the menu" }, problems: [] });
		expect(saved.history).toMatchObject({
			resource: `draft:${site.siteId}:entry:${site.entryId}`,
			before: { values: { order: expect.anything() } },
			after: { values: { order: expect.anything() } },
		});
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.order).toEqual({ url: "/menu", text: "See the menu" });
		expect(entry.published?.fields.order).toEqual({ url: "/order", text: "Order a loaf" });
		const html = await (await editing.page("/recipes/sourdough")).text();
		expect(tagged(html, "order")[0]).toContain('href="/menu"');
		expect(html).toContain(">See the menu</a>");
		// Visitors still see the published link.
		expect(await (await install.request(`${site.origin}/recipes/sourdough`)).text()).toContain('href="/order"');
	});

	test("an email that opens in a new tab renders, once published, with its target", async () => {
		const response = await editing.edit("save", {
			item: `entry:${site.entryId}`,
			field: "more",
			value: { url: "mailto:orders@acme.test", text: "Email us", newTab: true },
		});

		expect(await json(response)).toMatchObject({
			value: { url: "mailto:orders@acme.test", text: "Email us", newTab: true },
			problems: [],
		});
		const edited = await (await editing.page("/recipes/sourdough")).text();
		expect(tagged(edited, "more")[0]).toContain('href="mailto:orders@acme.test"');
		expect(tagged(edited, "more")[0]).toContain('target="_blank" rel="noopener"');
		await editor.api.entries.publish({ siteId: site.siteId, entryId: site.entryId });
		const visitors = await (await install.request(`${site.origin}/recipes/sourdough`)).text();
		expect(anchors(visitors)).toContain('<a href="mailto:orders@acme.test" target="_blank" rel="noopener">');
		expect(visitors).toContain(">Email us</a>");
		// A Template's own target wins over the link's.
		expect(anchors(visitors)).toContain('<a href="mailto:orders@acme.test" target="_self">');
	});

	test("the new tab goes when it is switched off: nothing is kept for it", async () => {
		await editing.edit("save", {
			item: `entry:${site.entryId}`,
			field: "more",
			value: { url: "mailto:orders@acme.test", text: "Email us", newTab: false },
		});

		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.more).toEqual({ url: "mailto:orders@acme.test", text: "Email us" });
		expect(tagged(await (await editing.page("/recipes/sourdough")).text(), "more")[0]).not.toContain("target=");
	});

	test("an address a link may not go to is refused, and the Draft keeps the link it had", async () => {
		const { entry: before } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		for (const url of ["javascript:alert(1)", "data:text/html,hi", "vbscript:x", " JavaScript:alert(1)"]) {
			const response = await editing.edit("save", {
				item: `entry:${site.entryId}`,
				field: "order",
				value: { url, text: "Click" },
			});
			expect({ url, status: response.status }).toEqual({ url, status: 400 });
		}
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.order).toEqual(before.draft.fields.order);
	});

	test("a link without an address is kept with its problem; null removes the link", async () => {
		const empty = await editing.edit("save", {
			item: `entry:${site.entryId}`,
			field: "order",
			value: { url: "", text: "Soon" },
		});
		expect(await json(empty)).toMatchObject({
			value: { url: "", text: "Soon" },
			problems: [expect.objectContaining({ rule: "url" })],
		});

		const removed = await editing.edit("save", { item: `entry:${site.entryId}`, field: "order", value: null });
		expect(await json(removed)).toMatchObject({ value: null, problems: [] });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.order ?? null).toBeNull();
		// The region is still on the page, empty, to add a link in.
		expect(tagged(await (await editing.page("/recipes/sourdough")).text(), "order")[0]).toContain(
			'data-wc-type="link"',
		);
	});

	test("the Globals' link saves the same way", async () => {
		const response = await editing.edit("save", {
			item: "globals",
			field: "contact",
			value: { url: "tel:+353215550100", text: "Call us" },
		});

		expect(await json(response)).toMatchObject({ value: { url: "tel:+353215550100", text: "Call us" } });
		const { globals } = await editor.api.globals.get({ siteId: site.siteId });
		expect(globals.draft.contact).toEqual({ url: "tel:+353215550100", text: "Call us" });
		expect(globals.published?.contact).toEqual({ url: "mailto:hello@acme.test", text: "Write" });
	});

	test("a link only goes to a link Field, and a link Field takes only a link", async () => {
		const item = `entry:${site.entryId}`;
		const refused = [
			{ field: "note", value: { url: "/menu", text: "Menu" } },
			{ field: "order", value: "/menu" },
			{ field: "order", value: [] },
			{ field: "title", value: { url: "/menu", text: "Menu" } },
			{ field: "related", value: { url: "/menu", text: "Menu" } },
			{ field: "order", value: { url: "/menu", text: "Menu", target: "_top" } },
		];
		for (const change of refused) {
			const response = await editing.edit("save", { item, ...change });
			expect({ change, status: response.status }).toEqual({ change, status: 400 });
		}
		const loop = await editing.edit("save", {
			item: `loop:${crypto.randomUUID()}:${crypto.randomUUID()}`,
			field: "order",
			value: { url: "/menu", text: "Menu" },
		});
		expect(loop.status).toBe(400);
	});
});
