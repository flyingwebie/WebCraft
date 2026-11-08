// Globals: one set of Fields per Site (phone, address, footer text) that every Template reads as
// `site.x`. Staff define the Fields; Members edit the values in a Draft and publish them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, text, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let siteId: string;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});

afterAll(async () => {
	await install.close();
});

const GLOBAL_FIELDS: Parameters<TestBrowser["api"]["globals"]["setFields"]>[0]["fields"] = [
	{ key: "phone", label: "Phone", type: "text", required: true, pattern: "[0-9 +]+" },
	{
		key: "address",
		label: "Address",
		type: "group",
		fields: [
			{ key: "street", label: "Street", type: "text" },
			{ key: "city", label: "City", type: "text" },
		],
	},
	{
		key: "hours",
		label: "Opening hours",
		type: "repeater",
		fields: [
			{ key: "day", label: "Day", type: "text" },
			{ key: "opens", label: "Opens", type: "date", mode: "time" },
		],
	},
	{ key: "footer", label: "Footer text", type: "richText" },
];

describe("defining the Globals", () => {
	test("a Site has none until Staff define them", async () => {
		const { globals } = await editor.api.globals.get({ siteId });

		expect(globals).toEqual({
			siteId,
			fields: [],
			status: "draft",
			language: "en",
			draft: {},
			published: null,
			problems: [],
			updatedAt: null,
			publishedAt: null,
			lastPublishedAt: null,
		});
	});

	test("Staff set their Fields; Members can't", async () => {
		const { globals } = await staff.api.globals.setFields({ siteId, fields: [...GLOBAL_FIELDS] });

		expect(globals.fields.map((field) => [field.key, field.type])).toEqual([
			["phone", "text"],
			["address", "group"],
			["hours", "repeater"],
			["footer", "richText"],
		]);
		expect(globals).toMatchObject({
			status: "draft",
			draft: { phone: null, address: { street: null, city: null }, hours: [], footer: null },
			problems: [{ at: "fields.phone", rule: "required" }],
			updatedAt: install.clock.now(),
		});
		await expect(owner.api.globals.setFields({ siteId, fields: [] })).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { permission: "structure.edit" },
		});
		const [audit] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(audit).toMatchObject({
			action: "globals.update",
			siteId,
			details: { keys: ["phone", "address", "hours", "footer"] },
		});
	});

	test("refuses Relationships, names kept for the Site, and Fields that change type", async () => {
		await staff.api.postTypes.create({ siteId, name: "Posts", key: "posts", urlPattern: "/posts/{slug}" });
		const cases: { fields: unknown[]; at: string }[] = [
			{
				fields: [{ key: "featured", label: "Featured", type: "relationship", postTypes: ["posts"] }],
				at: "fields[0].type",
			},
			{ fields: [{ key: "name", label: "Name", type: "text" }], at: "fields[0].key" },
			{ fields: [{ key: "phone", label: "Phone", type: "number" }], at: "fields[0].type" },
		];
		for (const { fields, at } of cases) {
			await expect(
				// @ts-expect-error: Fields as a client could send them
				staff.api.globals.setFields({ siteId, fields }),
				at,
			).rejects.toMatchObject({ code: "GLOBALS_INVALID", data: { problems: [{ at }] } });
		}
	});
});

describe("editing and publishing the Globals", () => {
	test("Members edit the Draft; values of the wrong kind are refused at their path", async () => {
		const { globals } = await author.api.globals.saveDraft({
			siteId,
			fields: {
				phone: "+353 1 234 5678",
				address: { city: "Dublin" },
				hours: [{ day: "Monday", opens: "07:00" }],
				footer: "<p>Fresh <em>every</em> day<script>x()</script></p>",
			},
		});

		expect(globals).toMatchObject({
			status: "draft",
			draft: {
				phone: "+353 1 234 5678",
				address: { street: null, city: "Dublin" },
				hours: [{ id: expect.any(String), day: "Monday", opens: "07:00" }],
				footer: "<p>Fresh <em>every</em> day</p>",
			},
			published: null,
			problems: [],
		});
		await expect(
			author.api.globals.saveDraft({ siteId, fields: { hours: [{ day: "Tuesday", opens: "7am" }] } }),
		).rejects.toMatchObject({ code: "GLOBALS_INVALID", data: { problems: [{ at: "fields.hours[0].opens" }] } });
		await expect(author.api.globals.saveDraft({ siteId, fields: { fax: "1" } })).rejects.toMatchObject({
			code: "GLOBALS_INVALID",
			data: { problems: [{ at: "fields.fax" }] },
		});
	});

	test("Editors publish them; Authors can't; broken rules and empty required values block publishing", async () => {
		await expect(author.api.globals.publish({ siteId })).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { permission: "entry.publish" },
		});

		await author.api.globals.saveDraft({ siteId, fields: { phone: "call us" } });
		await expect(editor.api.globals.publish({ siteId })).rejects.toMatchObject({
			code: "GLOBALS_INVALID",
			data: { problems: [{ at: "fields.phone", rule: "pattern" }] },
		});
		await author.api.globals.saveDraft({ siteId, fields: { phone: null } });
		await expect(editor.api.globals.publish({ siteId })).rejects.toMatchObject({
			code: "GLOBALS_INCOMPLETE",
			data: { missing: ["phone"] },
		});

		await author.api.globals.saveDraft({ siteId, fields: { phone: "01 234 5678" } });
		const { globals } = await editor.api.globals.publish({ siteId });
		expect(globals).toMatchObject({
			status: "published",
			published: { phone: "01 234 5678", address: { city: "Dublin" } },
			publishedAt: install.clock.now(),
			lastPublishedAt: install.clock.now(),
		});
		const [audit] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(audit).toMatchObject({ action: "globals.publish", siteId });

		const changed = await author.api.globals.saveDraft({ siteId, fields: { address: { street: "1 Quay" } } });
		expect(changed.globals.status).toBe("changed");
	});

	test("a Field added with a default starts the Draft with it", async () => {
		const { globals } = await staff.api.globals.setFields({
			siteId,
			fields: [...GLOBAL_FIELDS, { key: "delivery", label: "We deliver", type: "boolean", default: true }],
		});

		expect(globals.draft).toMatchObject({ phone: "01 234 5678", delivery: true });
	});
});

describe("site.x in Templates", () => {
	test("Entry templates show the published Globals; a publish changes every page at once", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Pages",
			key: "pages",
			urlPattern: "/{slug}",
		});
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(
				element("h1", [value("title")]),
				element("footer", [
					element("a", [value("site.phone")], { href: [{ type: "text", text: "tel:" }, value("site.phone")] }),
					element("p", [value("site.address.street"), text(", "), value("site.address.city")]),
					element("p", [value("site.hours.day")]),
					element("div", [value("site.footer")]),
				]),
			),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "About",
			slug: "about",
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const page = async () => (await install.request("https://bakery.sites.test/about")).text();

		expect(await page()).toContain(
			'<footer><a href="tel:01 234 5678">01 234 5678</a><p>, Dublin</p><p>Monday</p><div><p>Fresh <em>every</em> day</p></div></footer>',
		);

		await author.api.globals.saveDraft({ siteId, fields: { phone: "01 999 0000" } });
		expect(await page()).toContain(">01 234 5678</a>");
		await editor.api.globals.publish({ siteId });
		expect(await page()).toContain('<a href="tel:01 999 0000">01 999 0000</a><p>1 Quay, Dublin</p>');
	});

	test("a Template can only read Globals that exist", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Notes",
			key: "notes",
			urlPattern: "/notes/{slug}",
		});

		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: postType.id,
				tree: tree(element("p", [value("site.fax")])),
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_INVALID", data: { problems: [{ at: "nodes[0].children[0].path" }] } });
	});
});
