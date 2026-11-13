// Publishing one item: its Draft becomes what visitors see. Editors, Owners and Staff publish
// Entries; Authors save Drafts only. Templates are Structure: only Staff publish them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let roles: Record<"owner" | "editor" | "author", { browser: TestBrowser; personId: string }>;
let siteId: string;
let workspaceId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	roles = {
		owner: await install.createMember({ workspaceId, role: "owner" }),
		editor: await install.createMember({ workspaceId, role: "editor" }),
		author: await install.createMember({ workspaceId, role: "author" }),
	};
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Products",
		key: "products",
		urlPattern: "/products/{slug}",
		fields: [
			{ key: "price", label: "Price", type: "text", required: true },
			{ key: "notes", label: "Notes", type: "text" },
		],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplate({
		siteId,
		postTypeId,
		tree: tree(element("article", [element("h1", [value("title")]), element("p", [value("price")])])),
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

const page = (slug: string) => install.request(`https://bakery.live.test/products/${slug}`);

describe("who publishes an Entry", () => {
	test("Editors and Owners publish; the page is live at once", async () => {
		for (const role of ["editor", "owner"] as const) {
			const { api } = roles[role].browser;
			const { entry } = await api.entries.create({
				siteId,
				postTypeId,
				title: `Loaf by ${role}`,
				fields: { price: "4" },
			});

			await api.entries.publish({ siteId, entryId: entry.id });

			const response = await page(`loaf-by-${role}`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(`<h1>Loaf by ${role}</h1>`);
		}
	});

	test("Authors write Drafts but can't publish: the page doesn't exist for visitors", async () => {
		const { api } = roles.author.browser;
		const { entry } = await api.entries.create({ siteId, postTypeId, title: "Secret recipe", fields: { price: "9" } });

		await expect(api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { permission: "entry.publish" },
		});
		expect((await page("secret-recipe")).status).toBe(404);

		await roles.editor.browser.api.entries.publish({ siteId, entryId: entry.id });
		expect((await page("secret-recipe")).status).toBe(200);
	});

	test("Staff and the Superadmin publish too", async () => {
		const { entry } = await roles.author.browser.api.entries.create({
			siteId,
			postTypeId,
			title: "Seeded rye",
			fields: { price: "5" },
		});

		await staff.api.entries.publish({ siteId, entryId: entry.id });
		await admin.api.entries.publish({ siteId, entryId: entry.id });

		expect((await page("seeded-rye")).status).toBe(200);
	});
});

describe("what can be published", () => {
	test("an Entry whose required Fields are empty can't be published", async () => {
		const { api } = roles.editor.browser;
		const { entry } = await api.entries.create({ siteId, postTypeId, title: "Pretzel" });

		await expect(api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
			data: { missing: ["price"] },
		});
		await api.entries.saveDraft({ siteId, entryId: entry.id, slug: "", fields: { price: "2" } });
		await expect(api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
			data: { missing: ["slug"] },
		});
		await api.entries.saveDraft({ siteId, entryId: entry.id, slug: "pretzel" });
		await api.entries.publish({ siteId, entryId: entry.id });
		expect((await page("pretzel")).status).toBe(200);
	});

	test("a published Entry is found by its published slug, and a new slug moves it when published", async () => {
		const { api } = roles.editor.browser;
		const { entry } = await api.entries.create({ siteId, postTypeId, title: "Bagel", fields: { price: "1" } });
		await api.entries.publish({ siteId, entryId: entry.id });

		await api.entries.saveDraft({ siteId, entryId: entry.id, slug: "new-york-bagel" });
		expect((await page("bagel")).status).toBe(200);
		expect((await page("new-york-bagel")).status).toBe(404);

		await api.entries.publish({ siteId, entryId: entry.id });
		expect((await page("bagel")).status).toBe(404);
		expect((await page("new-york-bagel")).status).toBe(200);
	});

	test("a published slug stays taken: another Entry can't take it in its Draft", async () => {
		const { api } = roles.editor.browser;
		const { entry } = await api.entries.create({ siteId, postTypeId, title: "Bagel two", fields: { price: "1" } });

		await expect(api.entries.saveDraft({ siteId, entryId: entry.id, slug: "new-york-bagel" })).rejects.toMatchObject({
			code: "ENTRY_SLUG_TAKEN",
		});
	});

	test("a published Entry has no page until its Entry template is published", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Events", urlPattern: "/events/{slug}" });
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Open day" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("h1", [value("title")])),
		});

		expect((await install.request("https://bakery.live.test/events/open-day")).status).toBe(404);

		await staff.api.templates.publish({ siteId, templateId: template.id });
		expect((await install.request("https://bakery.live.test/events/open-day")).status).toBe(200);
	});

	test("a Template that reads a Field its Post Type no longer has can't be published", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Courses",
			urlPattern: "/courses/{slug}",
			fields: [{ key: "level", label: "Level", type: "text" }],
		});
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("p", [value("level")])),
		});
		await staff.api.postTypes.update({ siteId, postTypeId: postType.id, fields: [] });

		await expect(staff.api.templates.publish({ siteId, templateId: template.id })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ at: "nodes[0].children[0].path" }] },
		});
	});
});

describe("the Audit log", () => {
	test("records each publish: who, how, which Site and which item", async () => {
		const { api } = roles.editor.browser;
		const { entry } = await api.entries.create({ siteId, postTypeId, title: "Cinnamon roll", fields: { price: "3" } });

		await api.entries.publish({ siteId, entryId: entry.id });

		const [latest] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(latest).toEqual({
			id: expect.any(String),
			at: install.clock.now(),
			action: "entry.publish",
			personId: roles.editor.personId,
			via: { kind: "admin" },
			workspaceId,
			siteId,
			details: {
				entryId: entry.id,
				postTypeId,
				title: "Cinnamon roll",
				slug: "cinnamon-roll",
				path: "/products/cinnamon-roll",
				pathChanges: [],
			},
		});
	});

	test("records Template publishes too", async () => {
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId,
			tree: tree(element("article", [element("h1", [value("title")])])),
		});

		await staff.api.templates.publish({ siteId, templateId: template.id });

		const [latest] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(latest).toMatchObject({
			action: "template.publish",
			siteId,
			details: { templateId: template.id, kind: "entry", postTypeId },
		});
	});

	test("a refused publish records nothing", async () => {
		const before = (await admin.api.audit.list({ limit: 1 })).entries[0]?.id;
		const { entry } = await roles.author.browser.api.entries.create({ siteId, postTypeId, title: "Nope" });

		await roles.author.browser.api.entries.publish({ siteId, entryId: entry.id }).catch(() => undefined);
		await roles.editor.browser.api.entries.publish({ siteId, entryId: entry.id }).catch(() => undefined);

		expect((await admin.api.audit.list({ limit: 1 })).entries[0]?.id).toBe(before);
	});
});
