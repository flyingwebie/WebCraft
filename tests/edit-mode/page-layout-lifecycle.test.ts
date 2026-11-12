import { afterAll, beforeAll, expect, test } from "bun:test";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
async function fixture(slug: string) {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	const { postTypes } = await admin.api.postTypes.list({ siteId });
	const postTypeId = postTypes[0]!.id;
	const { entry } = await admin.api.entries.create({ siteId, postTypeId, title: "Example" });
	return { admin, workspaceId, siteId, postTypeId, postTypeKey: postTypes[0]!.key, entryId: entry.id };
}
test("Page Prop contracts follow published declaration identities, never renamed keys or reused types", async () => {
	const { admin, siteId, entryId } = await fixture("layout-contracts");
	await admin.api.languages.add({ siteId, code: "it" });
	const { component } = await admin.api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", translatable: true }],
	});
	const target = { siteId, componentId: component.id };
	await admin.api.components.saveMarkup({ ...target, markup: "<h1>{{ props.heading }}</h1>" });
	await admin.api.components.publish(target);
	let state = await admin.api.pageLayouts.get({ siteId, entryId });
	state = await admin.api.pageLayouts.save({
		siteId,
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "hero",
					component: component.id,
					props: component.draft.props,
					values: { heading: { en: "Hello", it: "Ciao" } },
				},
			],
		},
	});
	await admin.api.entries.publish({ siteId, entryId });
	const item = { kind: "entry" as const, id: entryId };
	const first = (await admin.api.history.list({ siteId, item })).copies.find((c) => c.type === "revision")!;
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\ntitle: text id="${component.draft.props[0]!.id}" translatable=true\n{{/props}}\n<h1>{{ props.title }}</h1>`,
	});
	expect((await admin.api.pageLayouts.get({ siteId, entryId })).placements[0]?.props[0]?.key).toBe("heading");
	await admin.api.components.publish(target);
	state = await admin.api.pageLayouts.get({ siteId, entryId, language: "it" });
	expect(state.placements[0]?.values.title).toBe("Ciao");
	expect(state.placements[0]?.props[0]?.id).toBe(component.draft.props[0]!.id);
	await admin.api.history.restore({ siteId, item, copy: { type: "revision", id: first.id } });
	expect((await admin.api.pageLayouts.get({ siteId, entryId, language: "it" })).placements[0]?.values.title).toBe(
		"Ciao",
	);
	await expect(admin.api.components.delete(target)).rejects.toMatchObject({ code: "COMPONENT_IN_USE" });
});
test("Author layout changes enter the existing Review and revisions without publishing early", async () => {
	const { admin, workspaceId, siteId, entryId } = await fixture("layout-review");
	await goLive(install, siteId);
	const { component } = await admin.api.components.create({
		siteId,
		name: "Card",
		props: [{ key: "text", label: "Text", type: "text" }],
	});
	await admin.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<h1>{{ props.text }}</h1>" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	await admin.api.entries.publish({ siteId, entryId });
	await admin.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const author = (await install.createMember({ workspaceId, role: "author" })).browser;
	const editing = await openEditMode(install, author, siteId, "/example");
	const state = await author.api.pageLayouts.get({ siteId, entryId });
	const saved = await editing.edit("layout/save", {
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "card",
					component: component.id,
					props: component.draft.props,
					values: { text: { en: "Awaiting review" } },
				},
			],
		},
	});
	expectSiteHeaders(saved);
	expect(saved.status).toBe(200);
	const pageState = await editing.edit("state", { path: "/example" });
	expectSiteHeaders(pageState);
	const data = await pageState.json();
	expect(data.changes).toContainEqual(expect.objectContaining({ key: "layout", label: null, type: "pageLayout" }));
	expect(await expectSafePage(await install.request("https://layout-review.live.test/example"))).not.toContain(
		"Awaiting review",
	);
	await expect(author.api.entries.publish({ siteId, entryId })).rejects.toMatchObject({ status: 403 });
	const submitted = await editing.edit("review/submit", { path: "/example" });
	expectSiteHeaders(submitted);
	expect(submitted.status).toBe(200);
	expect((await admin.api.reviews.list({ siteId })).reviews).toHaveLength(1);
	await admin.api.entries.publish({ siteId, entryId });
	expect(await expectSafePage(await install.request("https://layout-review.live.test/example"))).toContain(
		"Awaiting review",
	);
	const history = await author.api.history.list({ siteId, item: { kind: "entry", id: entryId } });
	expect(history.copies.some((c) => c.type === "revision")).toBe(true);
});
test("Site transfer remaps Page Props by their declared types, including nested translations and history", async () => {
	const { admin, workspaceId, siteId, postTypeId, postTypeKey, entryId } = await fixture("layout-transfer");
	await admin.api.languages.add({ siteId, code: "it" });
	const { entry: linked } = await admin.api.entries.create({ siteId, postTypeId, title: "Linked" });
	await admin.api.entries.publish({ siteId, entryId: linked.id });
	const { component } = await admin.api.components.create({
		siteId,
		name: "Card",
		props: [
			{ key: "literal", label: "Literal", type: "text", translatable: true },
			{ key: "target", label: "Target", type: "relationship", postTypes: [postTypeKey] },
			{
				key: "group",
				label: "Group",
				type: "group",
				fields: [{ key: "words", label: "Words", type: "text", translatable: true }],
			},
		],
	});
	await admin.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<h1>{{ props.literal }}</h1>" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	const state = await admin.api.pageLayouts.get({ siteId, entryId });
	await admin.api.pageLayouts.save({
		siteId,
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "card",
					component: component.id,
					props: component.draft.props,
					values: {
						literal: { en: linked.id, it: linked.id },
						target: { en: linked.id },
						group: { values: { words: { en: "Hello", it: "Ciao" } } },
					},
				},
			],
		},
	});
	await admin.api.entries.publish({ siteId, entryId });
	await admin.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Layout copy",
		slug: "layout-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site!.id;
	const types = (await admin.api.postTypes.list({ siteId: destination })).postTypes;
	const copies = (await admin.api.entries.list({ siteId: destination, postTypeId: types[0]!.id })).entries;
	const page = copies.find((e) => e.draft.title === "Example")!;
	const other = copies.find((e) => e.draft.title === "Linked")!;
	const result = await admin.api.pageLayouts.get({ siteId: destination, entryId: page.id, language: "it" });
	expect(result.placements[0]?.values).toEqual({ literal: linked.id, target: other.id, group: { words: "Ciao" } });
	expect(result.layout.placements[0]?.component).not.toBe(component.id);
	expect(result.settings.allowedComponents).toEqual([result.layout.placements[0]!.component]);
	const revision = (
		await admin.api.history.list({ siteId: destination, item: { kind: "entry", id: page.id } })
	).copies.find((c) => c.type === "revision")!;
	await admin.api.history.restore({
		siteId: destination,
		item: { kind: "entry", id: page.id },
		copy: { type: "revision", id: revision.id },
	});
	expect(
		(await admin.api.pageLayouts.get({ siteId: destination, entryId: page.id })).placements[0]?.values.target,
	).toBe(other.id);
});

test("unpublished Components and invalid typed Props cannot be published, while language changes preserve shared Props", async () => {
	const { admin, siteId, entryId } = await fixture("layout-validation");
	await admin.api.languages.add({ siteId, code: "it" });
	const { component } = await admin.api.components.create({
		siteId,
		name: "Notice",
		props: [
			{ key: "title", label: "Title", type: "text", required: true, translatable: true },
			{ key: "count", label: "Count", type: "number" },
		],
	});
	let state = await admin.api.pageLayouts.get({ siteId, entryId });
	state = await admin.api.pageLayouts.save({
		siteId,
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "notice",
					component: component.id,
					props: component.draft.props,
					values: { title: { en: "Hello", it: "Ciao" }, count: { en: 3 } },
				},
			],
		},
	});
	await expect(admin.api.entries.publish({ siteId, entryId })).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await admin.api.components.publish({ siteId, componentId: component.id });
	state = await admin.api.pageLayouts.get({ siteId, entryId });
	for (const values of [{ title: "not a language map" }, { count: { it: 4 } }, { count: { en: "not a number" } }])
		await expect(
			admin.api.pageLayouts.save({
				siteId,
				entryId,
				basedOn: state.version,
				layout: { placements: [{ ...state.layout.placements[0]!, values }] },
			}),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await admin.api.entries.publish({ siteId, entryId });
	const request = await admin.api.languages.setDefault({ siteId, code: "it" });
	if (request.changed) throw new Error("Expected a preview");
	await admin.api.languages.setDefault({ siteId, code: "it", confirmation: request.confirmation.id });
	const after = await admin.api.pageLayouts.get({ siteId, entryId });
	expect(after.placements[0]?.values).toEqual({ title: "Ciao", count: 3 });
	const copy = (await admin.api.history.list({ siteId, item: { kind: "entry", id: entryId } })).copies.find(
		(c) => c.type === "revision",
	)!;
	await admin.api.pageLayouts.save({ siteId, entryId, basedOn: after.version, layout: { placements: [] } });
	const compared = await admin.api.history.compare({
		siteId,
		item: { kind: "entry", id: entryId },
		copy: { type: "revision", id: copy.id },
	});
	expect(compared.parts.find((p) => p.key === "layout")?.changed).toBe(true);
});

test("Repeater Props render typed rows with per-leaf language fallback", async () => {
	const { admin, siteId, entryId } = await fixture("layout-rows");
	await goLive(install, siteId);
	await admin.api.languages.add({ siteId, code: "it" });
	const { component } = await admin.api.components.create({
		siteId,
		name: "List",
		props: [
			{
				key: "rows",
				label: "Rows",
				type: "repeater",
				fields: [{ key: "text", label: "Text", type: "text", translatable: true }],
			},
		],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<h1>List</h1>{{@loop props.rows as row}}<p>{{ row.text }}</p>{{/loop}}",
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const state = await admin.api.pageLayouts.get({ siteId, entryId });
	await admin.api.pageLayouts.save({
		siteId,
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "list",
					component: component.id,
					props: component.draft.props,
					values: {
						rows: {
							rows: [
								{ id: "row-a", values: { text: { en: "Apple", it: "Mela" } } },
								{ id: "row-b", values: { text: { en: "Pear" } } },
							],
						},
					},
				},
			],
		},
	});
	await admin.api.entries.publish({ siteId, entryId });
	const html = await expectSafePage(await install.request("https://layout-rows.live.test/it/example"));
	expect(html).toContain("Mela");
	expect(html).toContain("Pear");
});

test("Hidden Page Placements keep each root editable and retain the Component runtime markers", async () => {
	const { admin, siteId, entryId } = await fixture("layout-hidden");
	await goLive(install, siteId);
	const { component } = await admin.api.components.create({
		siteId,
		name: "Notice",
		props: [{ key: "title", label: "Title", type: "text", exposed: true }],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<h1>{{ props.title }}</h1><p>Second root</p>",
	});
	await admin.api.components.saveScriptDraft({
		siteId,
		componentId: component.id,
		code: "export default root => { root.dataset.ready = 'yes'; };",
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const state = await admin.api.pageLayouts.get({ siteId, entryId });
	await admin.api.pageLayouts.save({
		siteId,
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "notice",
					component: component.id,
					props: component.draft.props,
					hidden: true,
					values: { title: { en: "Hidden title" } },
				},
			],
		},
	});
	await admin.api.entries.publish({ siteId, entryId });
	expect(await expectSafePage(await install.request("https://layout-hidden.live.test/example"))).not.toContain(
		"Hidden title",
	);
	const editing = await openEditMode(install, admin, siteId, "/example");
	const response = await editing.page("/example");
	expectSiteHeaders(response);
	const html = await response.text();
	expect(html.match(/data-wc-page-placement="notice"/g)).toHaveLength(2);
	expect(html).toContain('data-wc-hidden="true"');
	expect(html).toContain(`data-wc-component="${component.id}"`);
	expect(html).toContain('data-title="Hidden title"');
});

test("restored dormant Page Prop contracts remap Relationships without guessing literal ids", async () => {
	const { admin, workspaceId, siteId, postTypeId, postTypeKey, entryId } = await fixture("layout-retained");
	const { entry: linked } = await admin.api.entries.create({ siteId, postTypeId, title: "Target" });
	await admin.api.entries.publish({ siteId, entryId: linked.id });
	const { component } = await admin.api.components.create({
		siteId,
		name: "RetainedCard",
		props: [
			{ key: "literal", label: "Literal", type: "text" },
			{ key: "value", label: "Value", type: "relationship", postTypes: [postTypeKey] },
		],
	});
	const target = { siteId, componentId: component.id };
	await admin.api.components.publish(target);
	let state = await admin.api.pageLayouts.get({ siteId, entryId });
	await admin.api.pageLayouts.save({
		siteId,
		entryId,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "retained",
					component: component.id,
					props: component.draft.props,
					values: { literal: { en: linked.id }, value: { en: linked.id } },
				},
			],
		},
	});
	await admin.api.entries.publish({ siteId, entryId });
	const item = { kind: "entry" as const, id: entryId };
	const revision = (await admin.api.history.list({ siteId, item })).copies.find((copy) => copy.type === "revision");
	if (!revision) throw new Error("Missing Page revision");
	await admin.api.components.saveMarkup({
		...target,
		props: component.draft.props.map((field) =>
			field.key === "value" ? { id: field.id, key: "value", label: "Value", type: "text" } : field,
		),
		markup: "<p>{{ props.literal }}</p>",
	});
	await admin.api.components.publish(target);
	await admin.api.history.restore({ siteId, item, copy: { type: "revision", id: revision.id } });
	state = await admin.api.pageLayouts.get({ siteId, entryId });
	expect(state.placements[0]?.values.value).toBeNull();
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Retained copy",
		slug: "layout-retained-copy",
	});
	const destination = copied.site?.id;
	if (!destination) throw new Error("Missing copied Site");
	const pageType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
		(type) => type.builtIn === "page",
	);
	if (!pageType) throw new Error("Missing copied Page Post Type");
	const pages = (await admin.api.entries.list({ siteId: destination, postTypeId: pageType.id })).entries;
	const page = pages.find((page) => page.draft.title === "Example");
	const other = pages.find((page) => page.draft.title === "Target");
	if (!page || !other) throw new Error("Missing copied Pages");
	const result = await admin.api.pageLayouts.get({ siteId: destination, entryId: page.id });
	const placement = result.layout.placements[0];
	if (!placement) throw new Error("Missing copied Placement");
	await admin.api.components.saveMarkup({
		siteId: destination,
		componentId: placement.component,
		props: placement.props.map((field) =>
			field.key === "value"
				? { id: field.id, key: "value", label: "Value", type: "relationship", postTypes: [pageType.key] }
				: field,
		),
		markup: "<p>{{ props.literal }}</p>",
	});
	await admin.api.components.publish({ siteId: destination, componentId: placement.component });
	expect((await admin.api.pageLayouts.get({ siteId: destination, entryId: page.id })).placements[0]?.values).toEqual({
		literal: linked.id,
		value: other.id,
	});
});
