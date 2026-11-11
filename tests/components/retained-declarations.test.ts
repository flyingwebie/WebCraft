import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("accepted declaration identities round-trip through retained values and binding metadata", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const fields = [
		{ key: "a", label: "A", type: "text", id: "n".repeat(100) },
		{ key: "b", label: "B", type: "text", id: "nested:survivor" },
	];
	const original = await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\na: text id="legacy:removed"\nb: text id="survivor"\ncard: group fields=${JSON.stringify(fields)}\n{{/props}}\n<p>{{ props.a }}</p>`,
	});
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: '<Card a="Removed" b="Kept" card=\'{"a":"Nested removed","b":"Nested kept"}\' />',
	});
	const { component: wrapper } = await admin.api.components.create({ siteId, name: "Wrapper" });
	const wrapperTarget = { siteId, componentId: wrapper.id };
	await admin.api.components.saveMarkup({
		...wrapperTarget,
		markup: `{{@props}}\ncard: group fields=${JSON.stringify(fields)}\n{{/props}}\n<Card a="Bound removed" b="Bound kept" card="{{ props.card }}" />`,
	});
	const props = structuredClone(original.component.draft.props);
	const survivor = props[1];
	const card = props[2];
	if (!survivor || !card || !("fields" in card) || !card.fields[1]) throw new Error("Missing declarations");
	card.fields = [{ ...card.fields[1], key: "a" }];
	await admin.api.components.saveDraft({ ...target, props: [{ ...survivor, key: "a" }, card] });
	const pending = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: pending.markup?.draft ?? "" });
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft).toEqual(pending.template?.draft);
	const bound = await admin.api.components.getMarkup(wrapperTarget);
	await admin.api.components.saveMarkup({ ...wrapperTarget, markup: bound.markup.draft });
	expect((await admin.api.components.getMarkup(wrapperTarget)).component.draft.tree).toEqual(
		bound.component.draft.tree,
	);
	await admin.api.components.saveMarkup({ ...target, markup: original.markup });
	const restored = await admin.api.templates.getEntryTemplateMarkup(holder);
	expect(restored.markup?.draft).toContain('a="Removed" b="Kept"');
	expect(restored.markup?.draft).toContain("Nested removed");
	expect(restored.markup?.draft).toContain("Nested kept");
});

test("reusing a deleted Prop name preserves both identities across holder saves, reversal and publish", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\na: text\nb: text\n{{/props}}\n<p>{{ props.a }} {{ props.b }}</p>",
	});
	await admin.api.components.publish(target);
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: '<Card a="Removed" b="Retained" /><Card a="Other removed" b="Other retained" />',
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({ ...holder, title: "Example" });
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	const origin = await goLive(install, siteId);
	const visible = () => install.request(`${origin}/stories/example`).then(expectSafePage);
	const changed = await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\na: text id="${original.component.draft.props[1]?.id}"\n{{/props}}\n<p>{{ props.a }}</p>`,
	});
	expect(changed.propImpact.placements).toBe(2);
	const pending = await admin.api.templates.getEntryTemplateMarkup(holder);
	expect(pending.markup?.draft).toContain('a="Retained"');
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: pending.markup?.draft ?? "" });
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft).toBe(pending.markup?.draft);
	expect((await admin.api.templates.getEntryTemplateMarkup(holder)).template?.draft).toEqual(pending.template?.draft);
	expect(await visible()).toContain("Removed Retained");
	const { component: freshHolder } = await admin.api.components.create({ siteId, name: "Fresh" });
	const freshTarget = { siteId, componentId: freshHolder.id };
	await admin.api.components.saveMarkup({ ...freshTarget, markup: '<Card a="Fresh survivor" />' });
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(2);
	// Rename the survivor once more while the other identity is retained, then reverse both edits.
	await admin.api.components.saveMarkup({
		...target,
		markup: changed.markup.replace("a:", "c:").replace("props.a", "props.c"),
	});
	await admin.api.components.saveMarkup({ ...target, markup: original.markup });
	const restored = await admin.api.templates.getEntryTemplateMarkup(holder);
	expect(restored.markup?.draft).toContain('a="Removed" b="Retained"');
	expect(restored.markup?.draft).toContain('a="Other removed" b="Other retained"');
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
	await admin.api.components.saveMarkup({ ...target, markup: changed.markup });
	await admin.api.components.publish(target);
	const current = await admin.api.templates.getEntryTemplateMarkup(holder);
	for (const markup of [current.markup?.draft, current.markup?.published]) {
		expect(markup).toContain('a="Retained"');
		expect(markup).toContain('a="Other retained"');
		expect(markup).not.toContain("Removed");
	}
	expect(await visible()).toContain("Retained</p>");
	expect(await visible()).not.toContain("Removed");
	expect((await admin.api.components.getMarkup(freshTarget)).markup.draft).toContain('a="Fresh survivor"');
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
});

test("nested collisions stay with translated Group and Repeater rows through edits and reversal", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const original = await admin.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\nrows: repeater fields=[{"key":"card","label":"Card","type":"group","fields":[{"key":"a","label":"A","type":"text"},{"key":"b","label":"B","type":"text"}]}]\n{{/props}}\n{{@loop props.rows as row}}<p>{{ row.card.a }} {{ row.card.b }}</p>{{/loop}}',
	});
	await admin.api.components.publish(target);
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const english = '[{"card":{"a":"Removed one","b":"Kept one"}},{"card":{"a":"Removed two","b":"Kept two"}}]';
	const italian = '[{"card":{"a":"Rimosso uno","b":"Tenuto uno"}},{"card":{"a":"Rimosso due","b":"Tenuto due"}}]';
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: `<Card rows='{{ ${JSON.stringify(english)} it: ${JSON.stringify(italian)} }}' />`,
	});
	const props = structuredClone(original.component.draft.props);
	const rows = props[0];
	if (!rows || !("fields" in rows)) throw new Error("Missing rows");
	const card = rows.fields[0];
	if (!card || !("fields" in card) || !card.fields[1]) throw new Error("Missing card");
	card.fields = [{ ...card.fields[1], key: "a" }];
	await admin.api.components.saveDraft({ ...target, props });
	const pending = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: pending.markup?.draft ?? "" });
	// Editing and moving whole rows must move their retained data too, in every translation.
	const tree = structuredClone(pending.template?.draft);
	const placed = tree?.nodes[0];
	if (!tree || !placed || placed.type !== "component") throw new Error("Missing Placement");
	const part = placed.props[0]?.value[0];
	if (part?.type !== "text" || !part.translations) throw new Error("Missing translations");
	const editRows = (text: string) => {
		const values = JSON.parse(text);
		values[1].card.a += " edited";
		return JSON.stringify(values.reverse());
	};
	part.text = editRows(part.text);
	part.translations.it = editRows(part.translations.it ?? "");
	await admin.api.templates.saveEntryTemplate({ ...holder, tree });
	await admin.api.components.saveMarkup({ ...target, markup: original.markup });
	const restored = await admin.api.templates.getEntryTemplateMarkup(holder);
	const node = restored.template?.draft.nodes[0];
	const value = node?.type === "component" ? node.props[0]?.value[0] : undefined;
	expect(value).toMatchObject({ type: "text" });
	if (value?.type !== "text") throw new Error("Missing restored value");
	expect(JSON.parse(value.text)).toEqual([
		{ card: { a: "Removed two", b: "Kept two edited" } },
		{ card: { a: "Removed one", b: "Kept one" } },
	]);
	expect(JSON.parse(value.translations?.it ?? "")).toEqual([
		{ card: { a: "Rimosso due", b: "Tenuto due edited" } },
		{ card: { a: "Rimosso uno", b: "Tenuto uno" } },
	]);
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
	await admin.api.components.saveDraft({ ...target, props });
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(1);
	await admin.api.components.publish(target);
	const final = await admin.api.templates.getEntryTemplateMarkup(holder);
	expect(final.markup?.draft).not.toContain("Removed");
	expect(final.markup?.draft).not.toContain("Rimosso");
	expect(final.markup?.draft).toContain("Kept two edited");
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: final.markup?.draft ?? "" });
});

test("shared Component name reuse reaches an open holder and survives legacy saves and reconnect", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\na: text\nb: text\n{{/props}}\n<p>Card</p>",
	});
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: '<Card a="Removed" b="Kept" />',
	});
	const live = await openDraft(install, admin, siteId, { kind: "component", id: component.id });
	const placed = await openDraft(install, admin, siteId, { kind: "template", id: template.id });
	try {
		const b = first.component.draft.props[1];
		if (!b) throw new Error("Missing Prop");
		live.change((doc) => ({ ...(doc as object), props: [{ ...b, key: "a" }] }) as DocumentJson);
		await live.saved();
		await placed.untilDraft((doc) => JSON.stringify(doc).includes('"retained"'), "retained values at the other editor");
		placed.change((doc) => {
			const tree = doc as { nodes: DocumentJson[] };
			return { ...tree, nodes: [...tree.nodes, { type: "comment", text: "Peer change" }] } as DocumentJson;
		});
		await placed.saved();
		placed.disconnect();
		await placed.reconnect();
		await placed.saved();
		const current = await admin.api.templates.getEntryTemplateMarkup(holder);
		const legacy = structuredClone(current.template?.draft);
		const node = legacy?.nodes[0];
		if (!legacy || node?.type !== "component") throw new Error("Missing Placement");
		node.props = node.props.filter((p) => !p.retained);
		placed.change(legacy as DocumentJson);
		await placed.saved();
		await placed.untilDraft(
			(doc) => JSON.stringify(doc).includes('"retained"'),
			"the canonical retained values returned to the originating Template editor",
		);
		expect(JSON.stringify(placed.draft())).toContain("Removed");
		await admin.api.templates.saveEntryTemplate({ ...holder, tree: legacy });
		await admin.api.components.saveMarkup({ ...target, markup: first.markup });
		const restored = await admin.api.templates.getEntryTemplateMarkup(holder);
		expect(restored.markup?.draft).toContain('a="Removed" b="Kept"');
		expect(restored.markup?.draft).toContain("Peer change");
		expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
	} finally {
		live.close();
		placed.close();
	}
});

for (const side of ["source", "target"] as const)
	for (const type of ["group", "repeater"] as const)
		for (const saves of ["together", "separate"] as const)
			test(`${side} whole-${type} bindings reverse name reuse by identity after ${saves} saves`, async () => {
				const admin = await install.superadmin();
				const workspaceId = (await install.createWorkspace()).id;
				const siteId = (await install.createSite(workspaceId)).id;
				const { component: inner } = await admin.api.components.create({ siteId, name: "Inner" });
				const { component: outer } = await admin.api.components.create({ siteId, name: "Outer" });
				const fields =
					'[{"key":"a","label":"A","type":"text","id":"constructor"},{"key":"b","label":"B","type":"text","id":"survivor"}]';
				const body =
					type === "group"
						? "<p>{{ props.card.a }} {{ props.card.b }}</p>"
						: "{{@loop props.card as row}}<p>{{ row.a }} {{ row.b }}</p>{{/loop}}";
				const initialInner = await admin.api.components.saveMarkup({
					siteId,
					componentId: inner.id,
					markup: `{{@props}}\ncard: ${type} fields=${fields}\n{{/props}}\n${body}`,
				});
				await admin.api.components.publish({ siteId, componentId: inner.id });
				const initialOuter = await admin.api.components.saveMarkup({
					siteId,
					componentId: outer.id,
					markup: `{{@props}}\ncard: ${type} fields=${fields}\n{{/props}}\n<Inner card="{{ props.card }}"${type === "repeater" ? ` data-wc-bindings='{"card":{"root":"props.card","paths":{"b":"b"}}}'` : ""} />`,
				});
				await admin.api.components.publish({ siteId, componentId: outer.id });
				const { postType } = await admin.api.postTypes.create({
					siteId,
					name: "Stories",
					urlPattern: "/stories/{slug}",
				});
				const { template } = await admin.api.templates.saveEntryTemplateMarkup({
					siteId,
					postTypeId: postType.id,
					markup: `<Outer card='${type === "group" ? '{"a":"Removed","b":"Kept"}' : '[{"a":"Removed","b":"Kept"},{"a":"Removed two","b":"Kept two"}]'}' />`,
				});
				await admin.api.templates.publish({ siteId, templateId: template.id });
				const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Example" });
				await admin.api.entries.publish({ siteId, entryId: entry.id });
				const origin = await goLive(install, siteId);
				const selected = side === "source" ? initialOuter : initialInner;
				const target = { siteId, componentId: selected.component.id };
				const props = structuredClone(selected.component.draft.props);
				const card = props[0];
				if (!card || !("fields" in card) || !card.fields[1]) throw new Error("Missing fields");
				const survivor = card.fields[1];
				if (saves === "separate") {
					card.fields = [survivor];
					await admin.api.components.saveDraft({
						...target,
						props,
						...(side === "target" ? { tree: { version: 1, nodes: [] } } : {}),
					});
					// An unrelated canonical save between deletion and name reuse keeps the original source.
					const pending = await admin.api.components.getMarkup({ siteId, componentId: outer.id });
					await admin.api.components.saveMarkup({ siteId, componentId: outer.id, markup: pending.markup.draft });
				}
				card.fields = [{ ...survivor, key: "a" }];
				await admin.api.components.saveDraft({
					...target,
					props,
					...(side === "target" ? { tree: { version: 1, nodes: [] } } : {}),
				});
				const holder = { siteId, componentId: outer.id };
				const saved = await admin.api.components.getMarkup(holder);
				await admin.api.components.saveMarkup({ ...holder, markup: saved.markup.draft });
				// Restore before any publish, including when deletion and name reuse were separate edits.
				await admin.api.components.saveMarkup({ ...target, markup: selected.markup });
				await admin.api.components.publish(target);
				if (side === "target") await admin.api.components.publish(holder);
				const restored = await install.request(`${origin}/stories/example`).then(expectSafePage);
				expect(restored).toContain("Removed Kept</p>");
				if (type === "repeater") expect(restored).toContain("Removed two Kept two</p>");
				expect(restored).not.toContain("data-wc-bindings");
				await admin.api.components.saveDraft({
					...target,
					props,
					...(side === "target" ? { tree: { version: 1, nodes: [] } } : {}),
				});
				if (side === "source") {
					const revived = structuredClone(selected.component.draft.props);
					const group = revived[0];
					if (!group || !("fields" in group) || !group.fields[0] || !group.fields[1])
						throw new Error("Missing declarations");
					group.fields = [
						{ ...group.fields[0], key: "recovered" },
						{ ...group.fields[1], key: "a" },
					];
					await admin.api.components.saveDraft({ ...target, props: revived });
					await admin.api.components.publish(target);
					expect(await install.request(`${origin}/stories/example`).then(expectSafePage)).toContain("Removed Kept</p>");
				}

				await admin.api.components.saveMarkup({ ...target, markup: selected.markup });
				await admin.api.components.publish(target);
				if (side === "target") await admin.api.components.publish(holder);
				expect(await install.request(`${origin}/stories/example`).then(expectSafePage)).toContain("Removed Kept</p>");
				await admin.api.components.saveDraft({
					...target,
					props,
					...(side === "target" ? { tree: { version: 1, nodes: [] } } : {}),
				});
				if (side === "target")
					await admin.api.components.saveMarkup({
						...target,
						markup:
							type === "group" ? "<p>{{ props.card.a }}</p>" : "{{@loop props.card as row}}<p>{{ row.a }}</p>{{/loop}}",
					});
				await admin.api.components.publish(target);
				const after = await install.request(`${origin}/stories/example`).then(expectSafePage);
				expect(after).toContain(side === "source" ? " Kept</p>" : "Kept</p>");
				expect(after).not.toContain("Removed");
				expect(after).not.toContain("Kept Kept");
			});

test("retention input refuses malformed identities and payloads atomically with markup source lines", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\na: text\nb: text\n{{/props}}\n<p>Card</p>",
	});
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	const holder = { siteId, postTypeId: postType.id };
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: '<Card a="Removed" b="Kept" />' });
	const b = first.component.draft.props[1];
	if (!b) throw new Error("Missing Prop");
	await admin.api.components.saveDraft({ ...target, props: [{ ...b, key: "a" }] });
	const before = await admin.api.templates.getEntryTemplateMarkup(holder);
	const held = { name: "a", retained: first.component.draft.props[0]?.id, value: [{ type: "text", text: "Removed" }] };
	const cases = [
		JSON.stringify([{ ...held, extra: "unsupported" }]),
		JSON.stringify([{ ...held, retained: "unknown" }]),
		JSON.stringify([held, held]),
		JSON.stringify([{ ...held, value: [{ type: "text", text: "Removed", translations: { it: 42 } }] }]),
		'[{"name":"a","name":"b","retained":"unknown","value":[]}]',
	];
	for (const data of cases) {
		await expect(
			admin.api.templates.saveEntryTemplateMarkup({
				...holder,
				markup: `<!--Before-->\n\n<Card a="Kept" data-wc-retained='${data}' />`,
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: expect.arrayContaining([expect.objectContaining({ line: 3 })]) },
		});
		expect((await admin.api.templates.getEntryTemplateMarkup(holder)).markup?.draft).toBe(before.markup?.draft);
	}
});
