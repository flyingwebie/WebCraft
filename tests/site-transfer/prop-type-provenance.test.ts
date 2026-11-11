import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";
import { openStaging } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
for (const nextType of ["text", "relationship"] as const) {
	test(`fresh ${nextType} Placement uses the new declared type through Site transfer`, async () => {
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
		await admin.api.entries.publish({ siteId, entryId: entry.id });
		const { component } = await admin.api.components.create({ siteId, name: "Card" });
		const target = { siteId, componentId: component.id };
		const beforeType = nextType === "text" ? 'relationship postTypes=["stories"]' : "text";
		const original = await admin.api.components.saveMarkup({
			...target,
			markup: `{{@props}}
value: ${beforeType}
{{/props}}
<p>Card</p>`,
		});
		await admin.api.components.publish(target);
		const declaration = nextType === "text" ? "text" : 'relationship postTypes=["stories"]';
		const expression = nextType === "text" ? "props.value" : "props.value.title";
		await admin.api.components.saveMarkup({
			...target,
			markup: `{{@props}}
value: ${declaration} id="${original.component.draft.props[0]?.id}"
{{/props}}
<p>{{ ${expression} }}</p>`,
		});
		const expected = nextType === "text" ? entry.id : "Example";
		await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: `<Card value="${entry.id}" />` });
		const source = await openStaging(install, admin, siteId);
		expect(await source.page("/stories/example").then(expectSafePage)).toContain(`${expected}</p>`);
		const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
			name: "Transition copy",
			slug: `transition-${nextType}`,
		});
		expect(copied.status).toBe("done");
		const destination = copied.site?.id ?? "";
		const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
			(p) => p.key === "stories",
		);
		const copiedEntries = await admin.api.entries.list({ siteId: destination, postTypeId: copiedType?.id ?? "" });
		const copiedEntry = copiedEntries.entries[0];
		const placed = await admin.api.templates.getEntryTemplateMarkup({
			siteId: destination,
			postTypeId: copiedType?.id ?? "",
		});
		expect(placed.markup?.draft).toContain(`value="${nextType === "text" ? entry.id : copiedEntry?.id}"`);
		const imported = await openStaging(install, admin, destination);
		expect(await imported.page("/stories/example").then(expectSafePage)).toContain(`${expected}</p>`);
	});
}

for (const nextType of ["text", "relationship"] as const) {
	test(`translated nested ${nextType} values keep current and retained contracts on edited and fresh rows`, async () => {
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
		const beforeType = nextType === "text" ? "relationship" : "text";
		const original = await admin.api.components.saveMarkup({
			...target,
			markup: `{{@props}}\nrows: repeater fields=${JSON.stringify([{ key: "card", label: "Card", type: "group", fields: [{ key: "value", label: "Value", type: beforeType, ...(beforeType === "relationship" ? { postTypes: ["stories"] } : {}) }] }])}\n{{/props}}\n<p>Card</p>`,
		});
		await admin.api.components.publish(target);
		const json = JSON.stringify([{ card: { value: entry.id } }]);
		await admin.api.templates.saveEntryTemplateMarkup({
			...holder,
			markup: `<Card rows='{{ ${JSON.stringify(json)} it: ${JSON.stringify(json)} }}' />`,
		});
		const props = structuredClone(original.component.draft.props);
		const rows = props[0];
		if (!rows || !("fields" in rows)) throw new Error("Missing rows");
		const card = rows.fields[0];
		if (!card || !("fields" in card) || !card.fields[0]) throw new Error("Missing card");
		card.fields = [
			{
				key: "value",
				label: "Value",
				id: card.fields[0].id,
				type: nextType,
				...(nextType === "relationship" ? { postTypes: ["stories"] } : {}),
			} as (typeof card.fields)[number],
		];
		await admin.api.components.saveDraft({ ...target, props });
		const current = await admin.api.templates.getEntryTemplateMarkup(holder);
		const tree = structuredClone(current.template?.draft);
		const node = tree?.nodes[0];
		const part = node?.type === "component" ? node.props[0]?.value[0] : undefined;
		if (!tree || part?.type !== "text" || !part.translations) throw new Error("Missing translated Placement");
		const author = (text: string) => {
			const data = JSON.parse(text);
			data[0].card.value = entry.id;
			data.unshift({ card: { value: entry.id } });
			return JSON.stringify(data);
		};
		part.text = author(part.text);
		part.translations.it = author(part.translations.it ?? "");
		await admin.api.templates.saveEntryTemplate({ ...holder, tree });
		const archive = await exportedArchive(install, admin, siteId);
		if (nextType === "text") {
			const malformed = rewritten(archive, {
				rows: (table, rows) =>
					table === "public.templates"
						? rows.map((row) =>
								JSON.parse(
									JSON.stringify(row, (key, value) =>
										key === "text" && typeof value === "string"
											? value.replaceAll('"contract":{', '"contract":{"extra":true,')
											: value,
									),
								),
							)
						: rows,
			});
			expect(
				await importArchive(install, admin, workspaceId, malformed, {
					name: "Invalid nested contract",
					slug: "invalid-nested-contract",
				}),
			).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
		}

		const imported = await importArchive(install, admin, workspaceId, archive, {
			name: "Nested copy",
			slug: `nested-${nextType}`,
		});
		expect(imported.status).toBe("done");
		const destination = imported.site?.id ?? "";
		const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
			(p) => p.key === "stories",
		);
		const copiedEntry = (await admin.api.entries.list({ siteId: destination, postTypeId: copiedType?.id ?? "" }))
			.entries[0];
		const copy = (await admin.api.components.list({ siteId: destination })).components[0];
		const copiedHolder = { siteId: destination, postTypeId: copiedType?.id ?? "" };
		const copiedTarget = { siteId: destination, componentId: copy?.id ?? "" };
		const read = async () => {
			const node = (await admin.api.templates.getEntryTemplateMarkup(copiedHolder)).template?.draft.nodes[0];
			const part = node?.type === "component" ? node.props[0]?.value[0] : undefined;
			if (part?.type !== "text") throw new Error("Missing nested value");
			return [JSON.parse(part.text), JSON.parse(part.translations?.it ?? "")];
		};
		for (const rows of await read()) {
			expect(rows[0].card.value).toBe(nextType === "text" ? entry.id : copiedEntry?.id);
			expect(rows[1].card.value).toBe(nextType === "text" ? entry.id : copiedEntry?.id);
			expect(rows[1].card["$wc-retained"][0].value).toBe(nextType === "text" ? copiedEntry?.id : entry.id);
		}
		await admin.api.components.saveMarkup({ ...copiedTarget, markup: original.markup });
		for (const rows of await read()) expect(rows[1].card.value).toBe(nextType === "text" ? copiedEntry?.id : entry.id);
		await admin.api.components.saveDraft({ ...copiedTarget, props });
		await admin.api.components.publish(copiedTarget);
		for (const rows of await read())
			expect(rows).toEqual([
				{ card: { value: nextType === "text" ? entry.id : copiedEntry?.id } },
				{ card: { value: nextType === "text" ? entry.id : copiedEntry?.id } },
			]);
	});
}

test("legacy baseline values are upgraded before newly authored Placements use the current type", async () => {
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
		markup: '{{@props}}\nvalue: relationship postTypes=["stories"]\n{{/props}}\n<p>Card</p>',
	});
	await admin.api.components.publish(target);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: `<Card value="${entry.id}" />` });
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\nvalue: text id="${original.component.draft.props[0]?.id}"\n{{/props}}\n<p>{{ props.value }}</p>`,
	});
	const oldFormat = rewritten(await exportedArchive(install, admin, siteId), {
		rows: (_table, rows) =>
			rows.map((row) =>
				JSON.parse(
					JSON.stringify(row, (key, value) => {
						if (key === "propValueVersion") return undefined;
						if (key === "props" && Array.isArray(value))
							return value.map((prop) => {
								if (!prop.retained || !prop.contract) return prop;
								const { retained: _, contract: __, ...plain } = prop;
								return plain;
							});
						return value;
					}),
				),
			),
	});
	const copied = await importArchive(install, admin, workspaceId, oldFormat, { name: "Legacy", slug: "legacy-types" });
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((p) => p.key === "stories");
	const copiedHolder = { siteId: destination, postTypeId: type?.id ?? "" };
	const copiedEntry = (await admin.api.entries.list(copiedHolder)).entries[0];
	const card = (await admin.api.components.list({ siteId: destination })).components[0];
	const wrapper = (await admin.api.components.create({ siteId: destination, name: "Wrapper" })).component;
	await admin.api.components.saveMarkup({
		siteId: destination,
		componentId: wrapper.id,
		markup: `<Card value="${copiedEntry?.id}" />`,
	});
	const second = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, destination), {
		name: "Legacy again",
		slug: "legacy-types-again",
	});
	expect(second.status).toBe("done");
	const twice = (await admin.api.components.list({ siteId: second.site?.id ?? "" })).components.find(
		(c) => c.name === "Wrapper",
	);
	const markup = await admin.api.components.getMarkup({ siteId: second.site?.id ?? "", componentId: twice?.id ?? "" });
	expect(markup.markup.draft).toContain(`value="${copiedEntry?.id}"`);
	await admin.api.components.saveMarkup({ siteId: destination, componentId: card?.id ?? "", markup: original.markup });
	expect((await admin.api.templates.getEntryTemplateMarkup(copiedHolder)).markup?.draft).toContain(
		`value="${copiedEntry?.id}"`,
	);
});

test("typed retained contracts transfer with Component history and malformed snapshots roll back imports", async () => {
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
		markup: '{{@props}}\nvalue: relationship postTypes=["stories"]\n{{/props}}\n<p>Card</p>',
	});
	await admin.api.components.publish(target);
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: `<Card value="${entry.id}" />` });
	await admin.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\nvalue: text id="${original.component.draft.props[0]?.id}"\n{{/props}}\n<p>{{ props.value }}</p>`,
	});
	const retained = await admin.api.templates.getEntryTemplateMarkup(holder);
	await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: (retained.markup?.draft ?? "").replace("<Card ", `<Card value="${entry.id}" `),
	});
	await admin.api.history.leave({ siteId, item: { kind: "component", id: component.id } });
	const archive = await exportedArchive(install, admin, siteId);
	const invalid = rewritten(archive, {
		rows: (table, rows) =>
			table === "public.templates"
				? rows.map((row) => JSON.parse(JSON.stringify(row).replaceAll('"contract":{', '"contract":{"extra":true,')))
				: rows,
	});
	const refused = await importArchive(install, admin, workspaceId, invalid, {
		name: "Invalid contract",
		slug: "invalid-contract",
	});
	expect(refused).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
	const copied = await importArchive(install, admin, workspaceId, archive, {
		name: "History types",
		slug: "history-types",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const card = (await admin.api.components.list({ siteId: destination })).components[0];
	const copiedTarget = { siteId: destination, componentId: card?.id ?? "" };
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((p) => p.key === "stories");
	const copiedHolder = { siteId: destination, postTypeId: type?.id ?? "" };
	const copiedEntry = (await admin.api.entries.list(copiedHolder)).entries[0];
	const item = { kind: "component" as const, id: card?.id ?? "" };
	const history = await admin.api.history.list({ siteId: destination, item });
	const revision = history.copies.find((c) => c.type === "revision");
	const checkpoint = history.copies.find((c) => c.type === "checkpoint" && c.reason === "left");
	await admin.api.history.restore({ siteId: destination, item, copy: { type: "revision", id: revision?.id ?? "" } });
	expect((await admin.api.templates.getEntryTemplateMarkup(copiedHolder)).markup?.draft).toContain(
		`value="${copiedEntry?.id}"`,
	);
	await admin.api.history.restore({
		siteId: destination,
		item,
		copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
	});
	expect((await admin.api.templates.getEntryTemplateMarkup(copiedHolder)).markup?.draft).toContain(
		`value="${entry.id}"`,
	);
	await admin.api.components.publish(copiedTarget);
	const final = await admin.api.templates.getEntryTemplateMarkup(copiedHolder);
	expect(final.markup?.draft).toContain(`value="${entry.id}"`);
	expect(final.markup?.draft).not.toContain("data-wc-retained");
});
