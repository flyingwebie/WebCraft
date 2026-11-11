import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
test("publishing a type change drops retained old values and preserves a freshly authored value", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
	});
	const holder = { siteId, postTypeId: postType.id };
	const { entry } = await admin.api.entries.create({ ...holder, title: "Example" });
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}
value: relationship postTypes=["stories"]
{{/props}}
<p>Card</p>`,
	});
	await admin.api.components.publish(target);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: `<Card value="${entry.id}" />` });
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}
value: text id="${original.component.draft.props[0]?.id}"
{{/props}}
<p>{{ props.value }}</p>`,
	});
	const existing = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `${existing.markup?.draft}\n<Card value="Fresh text" />`,
	});
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(1);
	await admin.api.components.publish(target);
	const after = await admin.api.templates.getEntryTemplateMarkup(holder);
	const nodes = after.template?.draft.nodes;
	expect(nodes?.[0]).toMatchObject({ type: "component", props: [] });
	expect(after.markup?.draft).toContain('value="Fresh text"');
});

test("editing an existing Placement keeps separately authored types through successive restoration", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
	});
	const holder = { siteId, postTypeId: postType.id };
	const { entry } = await admin.api.entries.create({ ...holder, title: "Example" });
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup: '{{@props}}\nvalue: relationship postTypes=["stories"]\n{{/props}}\n<p>Card</p>',
	});
	await admin.api.components.publish(target);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: `<Card value="${entry.id}" />` });
	const id = original.component.draft.props[0]?.id;
	const text = `{{@props}}\nvalue: text id="${id}"\n{{/props}}\n<p>{{ props.value }}</p>`;
	await admin.api.components.saveMarkup({ ...target, markup: text });
	const retained = await admin.api.templates.getEntryTemplateMarkup(holder);
	// The same literal bytes now mean text; the ordinary attribute is explicitly authored anew.
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: (retained.markup?.draft ?? "").replace("<Card ", `<Card value="${entry.id}" `),
	});
	const value = async () => {
		const node = (await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft.nodes[0];
		return node?.type === "component" ? node.props.filter((p) => !p.retained) : [];
	};
	await admin.api.components.saveMarkup({ ...target, markup: original.markup });
	expect(await value()).toEqual([{ name: "value", value: [{ type: "text", text: entry.id }] }]);
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\nvalue: number id="${id}"\n{{/props}}\n<p>{{ props.value }}</p>`,
	});
	const numbered = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: (numbered.markup?.draft ?? "").replace("<Card ", '<Card value="42" '),
	});
	await admin.api.components.saveMarkup({ ...target, markup: text });
	expect(await value()).toEqual([{ name: "value", value: [{ type: "text", text: entry.id }] }]);
	const canonical = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: canonical.markup?.draft ?? "" });
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\nvalue: number id="${id}"\n{{/props}}\n<p>{{ props.value }}</p>`,
	});
	expect(await value()).toEqual([{ name: "value", value: [{ type: "text", text: "42" }] }]);
	await admin.api.components.publish(target);
	expect(await value()).toEqual([{ name: "value", value: [{ type: "text", text: "42" }] }]);
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
});

test("whole-Group bindings retain successive nested type contracts until their own declaration returns", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [
			{ key: "words", label: "Words", type: "group", fields: [{ key: "value", label: "Value", type: "text" }] },
			{ key: "numbers", label: "Numbers", type: "group", fields: [{ key: "value", label: "Value", type: "number" }] },
		],
	});
	const holder = { siteId, postTypeId: postType.id };
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const text = await admin.api.components.saveMarkup({
		...target,
		markup: '{{@props}}\ncard: group fields=[{"key":"value","label":"Value","type":"text"}]\n{{/props}}\n<p>Card</p>',
	});
	await admin.api.components.publish(target);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: '<Card card="{{ words }}" />' });
	const number = text.markup.replace('"type":"text"', '"type":"number"');
	await admin.api.components.saveMarkup({ ...target, markup: number });
	const first = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: (first.markup?.draft ?? "").replace("<Card ", '<Card card="{{ numbers }}" '),
	});
	await admin.api.components.saveMarkup({
		...target,
		markup: text.markup.replace('"type":"text"', '"type":"boolean"'),
	});
	const multiple = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: multiple.markup?.draft ?? "" });
	await admin.api.components.saveMarkup({ ...target, markup: text.markup });
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft).toContain('card="{{ words }}"');
	await admin.api.components.saveMarkup({ ...target, markup: number });
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft).toContain('card="{{ numbers }}"');
	await admin.api.components.publish(target);
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft).toContain('card="{{ numbers }}"');
});

test("required Props can retain their old type during an unrelated canonical save", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\nvalue: text required\ncard: group fields=[{"key":"value","label":"Value","type":"text","required":true}]\n{{/props}}\n<p>Card</p>',
	});
	await admin.api.components.publish(target);
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `<Card value="Words" card='{"value":"Nested"}' />`,
	});
	await admin.api.components.saveMarkup({
		...target,
		markup: first.markup.replace("value: text", "value: number").replace('"type":"text"', '"type":"number"'),
	});
	const pending = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `${pending.markup?.draft}\n<!--Peer edit-->`,
	});
	await admin.api.components.saveMarkup({ ...target, markup: first.markup });
	const restored = await admin.api.templates.getEntryTemplateMarkup(holder);
	expect(restored.markup?.draft).toContain('value="Words"');
	expect(restored.markup?.draft).toContain("Nested");
	expect(restored.markup?.draft).toContain("Peer edit");
});

test("retained type contracts reject unsupported metadata atomically", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nvalue: text\n{{/props}}\n<p>Card</p>",
	});
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: '<Card value="Words" />' });
	await admin.api.components.saveMarkup({ ...target, markup: first.markup.replace("value: text", "value: number") });
	const before = await admin.api.templates.getEntryTemplateMarkup(holder);
	const tree = structuredClone(before.template?.draft);
	const node = tree?.nodes[0];
	const held = node?.type === "component" ? node.props[0] : undefined;
	if (!tree || !held?.contract) throw new Error("Missing retained contract");
	held.contract.extra = "unsupported";
	await expect(admin.api.templates.saveEntryTemplate({ ...holder, tree })).rejects.toMatchObject({
		code: "TEMPLATE_INVALID",
	});
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft).toEqual(before.template?.draft);
});

test("a parent type change retains nested deletion collisions without losing either declaration", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\ncard: group fields=[{"key":"a","label":"A","type":"text"},{"key":"b","label":"B","type":"text"}]\n{{/props}}\n<p>Card</p>',
	});
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `<Card card='{"a":"Removed","b":"Kept"}' />`,
	});
	const prop = first.component.draft.props[0];
	if (!prop || !("fields" in prop) || !prop.fields[1]) throw new Error("Missing Group");
	const collision = { ...prop, fields: [{ ...prop.fields[1], key: "a" }] };
	await admin.api.components.saveDraft({ ...target, props: [collision] });
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\ncard: text id="${prop.id}"\n{{/props}}\n<p>Card</p>`,
	});
	const kept = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: kept.markup?.draft ?? "" });
	await admin.api.components.saveMarkup({ ...target, markup: first.markup });
	const restored = (await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft.nodes[0];
	const part = restored?.type === "component" ? restored.props[0]?.value[0] : undefined;
	expect(part?.type === "text" ? JSON.parse(part.text) : null).toEqual({ a: "Removed", b: "Kept" });
});

test("shared current-type edits receive retained provenance in their canonical delta and keep peer edits", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nvalue: text\n{{/props}}\n<p>Card</p>",
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: '<Card value="Original" />',
	});
	const live = await openDraft(install, admin, siteId, { kind: "component", id: component.id });
	const placed = await openDraft(install, admin, siteId, { kind: "template", id: template.id });
	try {
		live.change(
			(doc) =>
				({
					...(doc as object),
					props: [
						{
							...first.component.draft.props[0],
							type: "number",
							min: null,
							max: null,
							integer: false,
							translatable: false,
						},
					],
				}) as DocumentJson,
		);
		await live.saved();
		await placed.untilDraft((doc) => JSON.stringify(doc).includes('"contract"'), "retained source contract");
		const current = (await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft;
		if (current?.nodes[0]?.type !== "component") throw new Error("Missing shared Placement");
		current.nodes[0].props = [{ name: "value", value: [{ type: "text", text: "42" }] }];
		placed.change(current as DocumentJson);
		await placed.saved();
		await placed.untilDraft(
			(doc) => JSON.stringify(doc).includes('"contract"'),
			"canonical retained source on originating edit",
		);
		await admin.api.templates.saveEntryTemplateMarkup({
			...holder,
			markup: `${(await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft}\n<!--Peer edit-->`,
		});
		await placed.untilDraft((doc) => JSON.stringify(doc).includes("Peer edit"), "peer edit");
		placed.disconnect();
		await placed.reconnect();
		await placed.saved();
		expect(JSON.stringify(placed.draft())).toContain("Original");
		expect(JSON.stringify(placed.draft())).toContain("42");
		await admin.api.components.saveMarkup({ ...target, markup: first.markup });
		expect((await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft).toContain('value="Original"');
		await admin.api.components.saveMarkup({ ...target, markup: first.markup.replace("value: text", "value: number") });
		await admin.api.components.publish(target);
		const final = await admin.api.templates.getEntryTemplateMarkup(holder);
		expect(final.markup?.draft).toContain('value="42"');
		expect(final.markup?.draft).toContain("Peer edit");
		expect(final.markup?.draft).not.toContain("Original");
	} finally {
		live.close();
		placed.close();
	}
});

test("a type change exceeding the retained value limit refuses the whole migration", async () => {
	const admin = await install.superadmin();
	const siteId = (await install.createSite((await install.createWorkspace()).id)).id;
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\n${Array.from({ length: 130 }, (_, i) => `v${i}: text`).join("\n")}\n{{/props}}\n<p>Card</p>`,
	});
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `<Card ${Array.from({ length: 130 }, (_, i) => `v${i}="Words"`).join(" ")} />`,
	});
	await admin.api.components.saveMarkup({ ...target, markup: first.markup.replaceAll(": text", ": number") });
	const tree = structuredClone((await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft);
	const node = tree?.nodes[0];
	if (!tree || node?.type !== "component") throw new Error("Missing Placement");
	node.props.unshift(
		...Array.from({ length: 130 }, (_, i) => ({ name: `v${i}`, value: [{ type: "text" as const, text: "42" }] })),
	);
	await admin.api.templates.saveEntryTemplate({ ...holder, tree });
	const before = await admin.api.templates.getEntryTemplateMarkup(holder);
	const componentBefore = await admin.api.components.getMarkup(target);
	const omitted = structuredClone(tree);
	const placed = omitted.nodes[0];
	if (placed?.type !== "component") throw new Error("Missing Placement");
	placed.props = componentBefore.component.draft.props.map((contract) => ({
		name: contract.key,
		retained: contract.id,
		contract,
		value: [{ type: "text", text: "42" }],
	}));
	await expect(admin.api.templates.saveEntryTemplate({ ...holder, tree: omitted })).rejects.toMatchObject({
		code: "COMPONENT_INVALID",
	});
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft).toEqual(before.template?.draft);

	await expect(
		admin.api.components.saveMarkup({ ...target, markup: first.markup.replaceAll(": text", ": boolean") }),
	).rejects.toMatchObject({ code: "COMPONENT_INVALID" });
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft).toEqual(before.template?.draft);
	expect((await admin.api.components.getMarkup(target)).component.draft).toEqual(componentBefore.component.draft);
});
