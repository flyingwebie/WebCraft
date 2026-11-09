// Components: reusable pieces of Structure with Props (GLOSSARY.md). Staff build them as element
// trees with a Draft and a published version; Props are declared with the Field types.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("creating a Component", () => {
	test("Staff declare its Props with the Field types; it starts as an empty Draft", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "PostCard",
			props: [
				{ key: "heading", label: "Heading", type: "text", required: true, maxLength: 80 },
				{ key: "featured", label: "Featured", type: "boolean" },
				{
					key: "tone",
					label: "Tone",
					type: "select",
					options: [
						{ value: "calm", label: "Calm" },
						{ value: "loud", label: "Loud" },
					],
					default: "calm",
				},
			],
		});

		expect(component).toMatchObject({
			siteId,
			name: "PostCard",
			module: null,
			status: "draft",
			published: null,
			publishedAt: null,
			draft: {
				props: [
					{ key: "heading", label: "Heading", type: "text", required: true, maxLength: 80, default: null },
					{ key: "featured", type: "boolean", required: false },
					{ key: "tone", type: "select", default: "calm", multiple: false },
				],
				tree: { version: 1, nodes: [] },
			},
		});
		const { component: read, usage } = await staff.api.components.get({ siteId, componentId: component.id });
		expect(read).toEqual(component);
		expect(usage).toEqual({ pages: 0, usedIn: [] });
		const { components } = await staff.api.components.list({ siteId });
		expect(components.map((listed) => [listed.name, listed.status, listed.usage.pages])).toContainEqual([
			"PostCard",
			"draft",
			0,
		]);
	});

	test("Props are checked as Fields are, each problem where it is", async () => {
		await expect(
			staff.api.components.create({
				siteId,
				name: "Broken",
				props: [
					{ key: "heading", label: "Heading", type: "text" },
					{ key: "size", label: "Size", type: "select", options: [] },
					{ key: "heading", label: "Again", type: "text" },
					{ key: "and", label: "And", type: "text" },
				],
			}),
		).rejects.toMatchObject({
			code: "COMPONENT_INVALID",
			data: {
				problems: [
					{ at: "props[1].options" },
					{ at: "props[2].key", message: expect.stringContaining("Two Props") },
					{ at: "props[3].key" },
				],
			},
		});
	});

	test("its name is a PascalCase tag name, unique on the Site", async () => {
		for (const name of ["postCard", "POSTCARD", "Post-Card", "Post Card", "", "P".repeat(65)]) {
			await expect(staff.api.components.create({ siteId, name })).rejects.toMatchObject({
				code: "COMPONENT_INVALID",
				data: { problems: [{ at: "name" }] },
			});
		}
		await staff.api.components.create({ siteId, name: "Banner" });
		await expect(staff.api.components.create({ siteId, name: "Banner" })).rejects.toMatchObject({
			code: "COMPONENT_NAME_TAKEN",
		});
	});

	test("is Structure: Members can't create or see Components", async () => {
		await expect(owner.api.components.create({ siteId, name: "Sneaky" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.api.components.list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("a Component's Draft", () => {
	test("is Template markup that reads its Props as props.x and the Globals as site.x", async () => {
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		const { component } = await staff.api.components.create({
			siteId,
			name: "Notice",
			props: [
				{ key: "heading", label: "Heading", type: "text" },
				{ key: "link", label: "Link", type: "link" },
			],
		});

		const saved = await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup:
				'<aside><h2>{{ props.heading }}</h2><a href="{{ props.link.url }}">{{ props.link.text }}</a> Call {{ site.phone }}</aside>',
		});

		const ids = [...saved.markup.matchAll(/data-wc-id="([A-Za-z0-9]{12})"/g)].map((match) => match[1]);
		expect(saved.markup).toBe(
			`<aside data-wc-id="${ids[0]}"><h2 data-wc-id="${ids[1]}">{{ props.heading }}</h2>` +
				`<a href="{{ props.link.url }}" data-wc-id="${ids[2]}">{{ props.link.text }}</a> Call {{ site.phone }}</aside>`,
		);
		expect(saved.notices).toEqual([]);
		expect(saved.component).toMatchObject({ status: "draft", published: null });
		expect(saved.component.draft.props.map((prop) => prop.key)).toEqual(["heading", "link"]);
		const read = await staff.api.components.getMarkup({ siteId, componentId: component.id });
		expect(read.markup).toEqual({ draft: saved.markup, published: null });
		expect(read.usage).toEqual({ pages: 0, usedIn: [] });
		expect(read.component).toEqual(saved.component);
	});

	test("reads nothing else: other names are refused with their line", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Strict",
			props: [{ key: "link", label: "Link", type: "link" }],
		});

		await expect(
			staff.api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: "<p>{{ props.nope }}</p>\n<p>{{ title }} {{ props.link.colour }}</p>",
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{ line: 1, column: 7, message: "There is no Prop named nope on this Component." },
					{ line: 2, column: 7, message: expect.stringContaining("reads only its Props (props.x) and the Globals") },
					{ line: 2, column: 19, message: "props.link.colour: the Prop link has no part named colour." },
				],
			},
		});
	});

	test("holds neither <main> nor {{@outlet}}: it goes inside pages", async () => {
		const { component } = await staff.api.components.create({ siteId, name: "Frame" });

		await expect(
			staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<main>{{@outlet}}</main>" }),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{ line: 1, column: 1 },
					{ line: 1, column: 7 },
				],
			},
		});
	});

	test("saved with new Props, its markup is checked against them; a Prop keeps its type", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Teaser",
			props: [{ key: "heading", label: "Heading", type: "text" }],
		});

		const saved = await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			props: [
				{ key: "heading", label: "Heading", type: "text" },
				{ key: "count", label: "Count", type: "number", default: 3 },
			],
			markup: "<p>{{ props.heading }} ({{ props.count }})</p>",
		});
		expect(saved.component.draft.props.map((prop) => [prop.key, prop.type])).toEqual([
			["heading", "text"],
			["count", "number"],
		]);

		await expect(
			staff.api.components.saveDraft({
				siteId,
				componentId: component.id,
				props: [{ key: "heading", label: "Heading", type: "number" }],
			}),
		).rejects.toMatchObject({
			code: "COMPONENT_INVALID",
			data: { problems: [{ at: "props[0].type", message: "heading is a text Prop; a Prop keeps its type." }] },
		});
		await expect(
			staff.api.components.saveDraft({
				siteId,
				componentId: component.id,
				props: [{ key: "heading", label: "Heading", type: "text" }],
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ message: "There is no Prop named count on this Component." }] },
		});
	});

	test("can be saved as an element tree", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Quote",
			props: [{ key: "words", label: "Words", type: "text" }],
		});

		const { component: saved } = await staff.api.components.saveDraft({
			siteId,
			componentId: component.id,
			tree: tree(element("blockquote", [value("props.words")])),
		});

		expect(saved.draft.tree.nodes[0]).toMatchObject({
			type: "element",
			tag: "blockquote",
			id: expect.stringMatching(/^[A-Za-z0-9]{12}$/),
			children: [{ type: "value", path: "props.words" }],
		});
	});
});

describe("where a Component is used", () => {
	/** A Site of its own, so other tests' Templates and Entries don't count. */
	let site: string;
	let footnoteId: string;
	const kinds: Record<string, { postTypeId: string; templateId: string }> = {};

	/** A Post Type whose Entry template is `markup` (published unless asked not to), with Entries. */
	async function kindWith(key: string, markup: string, options: { publish?: boolean; entries?: number } = {}) {
		const { postType } = await staff.api.postTypes.create({
			siteId: site,
			name: key,
			key,
			urlPattern: `/${key}/{slug}`,
		});
		const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId: site, postTypeId: postType.id, markup });
		if (options.publish !== false) await staff.api.templates.publish({ siteId: site, templateId: saved.template.id });
		for (let index = 0; index < (options.entries ?? 0); index++) {
			const { entry } = await staff.api.entries.create({
				siteId: site,
				postTypeId: postType.id,
				title: `${key} ${index}`,
			});
			await staff.api.entries.publish({ siteId: site, entryId: entry.id });
		}
		kinds[key] = { postTypeId: postType.id, templateId: saved.template.id };
	}

	beforeAll(async () => {
		site = (await install.createSite(workspaceId, { slug: "usage" })).id;
		await goLive(install, site);
		const { component } = await staff.api.components.create({ siteId: site, name: "Footnote" });
		footnoteId = component.id;
		await staff.api.components.saveMarkup({ siteId: site, componentId: footnoteId, markup: "<small>Note</small>" });
		await staff.api.components.publish({ siteId: site, componentId: footnoteId });
	});

	test("Template markup shows how many published pages show it", async () => {
		// Two published Entries through a published Entry template, and one Draft Entry, which has no page.
		await kindWith("recipes", "<div><Footnote /></div>", { entries: 2 });
		await staff.api.entries.create({ siteId: site, postTypeId: kinds.recipes?.postTypeId ?? "", title: "Draft" });
		// An Entry template that isn't published shows nothing yet.
		await kindWith("drafts", "<Footnote />", { publish: false, entries: 3 });
		// Through another Component: one more published Entry.
		const { component: wrapper } = await staff.api.components.create({ siteId: site, name: "Wrapper" });
		await staff.api.components.saveMarkup({
			siteId: site,
			componentId: wrapper.id,
			markup: "<aside><Footnote /></aside>",
		});
		await staff.api.components.publish({ siteId: site, componentId: wrapper.id });
		await kindWith("stories", "<Wrapper />", { entries: 1 });

		const { usage } = await staff.api.components.getMarkup({ siteId: site, componentId: footnoteId });

		expect(usage.pages).toBe(3);
		expect(usage.usedIn).toEqual(
			expect.arrayContaining([
				{
					kind: "template",
					id: kinds.recipes?.templateId,
					templateKind: "entry",
					postTypeId: kinds.recipes?.postTypeId,
					versions: ["draft", "published"],
				},
				{
					kind: "template",
					id: kinds.drafts?.templateId,
					templateKind: "entry",
					postTypeId: kinds.drafts?.postTypeId,
					versions: ["draft"],
				},
				{ kind: "component", id: wrapper.id, name: "Wrapper", versions: ["draft", "published"] },
			]),
		);
		expect(usage.usedIn).toHaveLength(3);
		const { components } = await staff.api.components.list({ siteId: site });
		expect(components.map((listed) => [listed.name, listed.usage.pages])).toEqual([
			["Footnote", 3],
			["Wrapper", 1],
		]);
	});

	test("placed in the published Site template, it shows on every published page", async () => {
		const { postTypes } = await staff.api.postTypes.list({ siteId: site });
		const pages = postTypes.find((postType) => postType.builtIn === "page");
		const { entry: about } = await staff.api.entries.create({
			siteId: site,
			postTypeId: pages?.id ?? "",
			title: "About",
		});
		await staff.api.entries.publish({ siteId: site, entryId: about.id });
		const { template } = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site,
			markup: "<main>{{@outlet}}</main><footer><Footnote /></footer>",
		});
		await staff.api.templates.publish({ siteId: site, templateId: template.id });

		// recipes (2), stories (1) and the Page; drafts' Entry template isn't published, so they have no pages.
		expect((await staff.api.components.get({ siteId: site, componentId: footnoteId })).usage.pages).toBe(4);
		const page = await install.request("https://usage.live.test/about");
		expect(await page.text()).toContain("<footer><small>Note</small></footer>");
	});

	test("renaming it changes how every Template and Component writes it", async () => {
		await staff.api.components.rename({ siteId: site, componentId: footnoteId, name: "SideNote" });

		const recipes = await staff.api.templates.getEntryTemplateMarkup({
			siteId: site,
			postTypeId: kinds.recipes?.postTypeId ?? "",
		});
		expect(recipes.markup?.draft).toMatch(/^<div data-wc-id="\w+"><SideNote data-wc-id="\w+" \/><\/div>$/);
		expect(recipes.markup?.published).toBe(recipes.markup?.draft);
		await expect(
			staff.api.components.rename({ siteId: site, componentId: footnoteId, name: "Wrapper" }),
		).rejects.toMatchObject({ code: "COMPONENT_NAME_TAKEN" });
		await expect(
			staff.api.components.rename({ siteId: site, componentId: footnoteId, name: "side-note" }),
		).rejects.toMatchObject({ code: "COMPONENT_INVALID", data: { problems: [{ at: "name" }] } });
	});

	test("deleting it is refused while anything places it, listing where", async () => {
		const refusal = await staff.api.components.delete({ siteId: site, componentId: footnoteId }).then(
			() => undefined,
			(error: { code?: string; data?: { usedIn?: { kind: string; id: string }[] } }) => error,
		);

		expect(refusal?.code).toBe("COMPONENT_IN_USE");
		expect(refusal?.data?.usedIn?.map((use) => use.kind).sort()).toEqual([
			"component",
			"template",
			"template",
			"template",
		]);
	});

	test("deleting one nothing places takes two steps and is logged", async () => {
		const { component } = await staff.api.components.create({ siteId: site, name: "Spare" });

		const asked = await staff.api.components.delete({ siteId: site, componentId: component.id });
		const confirmation = asked.deleted ? "" : asked.confirmation.id;
		expect(asked.deleted).toBe(false);
		expect(confirmation).toMatch(/^[0-9a-f-]{36}$/);
		expect((await staff.api.components.get({ siteId: site, componentId: component.id })).component.name).toBe("Spare");

		const done = await staff.api.components.delete({ siteId: site, componentId: component.id, confirmation });

		expect(done).toEqual({ deleted: true });
		await expect(staff.api.components.get({ siteId: site, componentId: component.id })).rejects.toMatchObject({
			code: "COMPONENT_NOT_FOUND",
		});
		const logged = (await (await install.superadmin()).api.audit.list({ limit: 20 })).entries.map((entry) => [
			entry.action,
			entry.details,
		]);
		expect(logged).toContainEqual(["component.delete", { componentId: component.id, name: "Spare" }]);
		expect(logged).toContainEqual(["component.rename", { componentId: footnoteId, from: "Footnote", to: "SideNote" }]);
	});
});
