import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("binding metadata refuses malformed, duplicate, oversized and unsupported uses atomically with source lines", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup:
			'{{@props}}\ncard: group fields=[{"key":"city","label":"City","type":"text"}]\ncount: number\n{{/props}}\n<p>{{ props.card.city }}</p>',
	});
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
		],
	});
	const holder = { siteId, postTypeId: postType.id };
	const kept = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: '<Card card="{{ address }}" />',
	});
	const meta = (root: string, paths: unknown) => JSON.stringify({ card: { root, paths } });
	for (const invalid of [
		"[]",
		"{",
		'{"card":{"root":"address","paths":{"city":"city","city":"town"}}}',
		'{"card":{"root":"address","root":"address","paths":{"city":"city"}}}',
		meta("freshAddress", { city: "city" }),
		meta("address", { city: "../city" }),
		meta("address", { city: `${"a.".repeat(8)}city` }),
		meta("address", { city: "a".repeat(257) }),
		meta("address", {}),
		meta("address", { missing: "city" }),
		meta("address", Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, "city"]))),
		JSON.stringify({ missing: { root: "address", paths: { city: "city" } } }),
	]) {
		await expect(
			admin.api.templates.saveEntryTemplateMarkup({
				...holder,
				markup: `<Card card="{{ address }}"\n data-wc-bindings='${invalid}' />`,
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [expect.objectContaining({ line: 2, message: expect.stringContaining("data-wc-bindings") })] },
		});
		expect((await admin.api.templates.getEntryTemplateMarkup(holder)).version).toBe(kept.version);
	}
	for (const markup of [
		`<Card card='{"city":"Words"}' data-wc-bindings='${meta("address", { city: "city" })}' />`,
		`<Card count="{{ address }}" data-wc-bindings='${JSON.stringify({ count: { root: "address", paths: { city: "city" } } })}' />`,
		`<div data-wc-bindings='${meta("address", { city: "city" })}'></div>`,
		`<Card card="{{ address }}" data-wc-bindings='{}' data-wc-bindings='{}' />`,
	])
		await expect(admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup })).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
		});
	const node = kept.template.draft.nodes[0];
	if (node?.type !== "component") throw new Error("Missing Placement");
	await expect(
		admin.api.templates.saveEntryTemplate({
			...holder,
			tree: {
				...kept.template.draft,
				nodes: [
					{ ...node, props: node.props.map((p) => ({ ...p, binding: { root: "changed", paths: { city: "city" } } })) },
				],
			},
		}),
	).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
});
