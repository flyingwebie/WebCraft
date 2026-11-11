import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

for (const mode of ["markup", "tree", "settings", "shared"] as const) {
	test(`source-side Group and Repeater renames project nested Placements through ${mode} saves`, async () => {
		const admin = await install.superadmin();
		const workspaceId = (await install.createWorkspace()).id;
		const siteId = (await install.createSite(workspaceId)).id;
		const { component: inner } = await admin.api.components.create({ siteId, name: "Inner" });
		await admin.api.components.saveMarkup({
			siteId,
			componentId: inner.id,
			markup:
				'{{@props}}\ncard: group fields=[{"key":"city","label":"City","type":"text"}]\nrows: repeater fields=[{"key":"city","label":"City","type":"text"}]\n{{/props}}\n<h2>{{ props.card.city }}</h2>{{@loop props.rows as row}}<p>{{ row.city }}</p>{{/loop}}',
		});
		await admin.api.components.publish({ siteId, componentId: inner.id });
		const { component: outer } = await admin.api.components.create({ siteId, name: "Outer" });
		const target = { siteId, componentId: outer.id };
		const first = await admin.api.components.saveMarkup({
			...target,
			markup:
				'{{@props}}\naddress: group fields=[{"key":"city","label":"City","type":"text"}]\nrows: repeater fields=[{"key":"city","label":"City","type":"text"}]\ndistricts: repeater fields=[{"key":"address","label":"Address","type":"group","fields":[{"key":"city","label":"City","type":"text"}]}]\n{{/props}}\n<Inner card="{{ props.address }}" rows="{{ props.rows }}" />{{@loop props.districts as district}}<Inner card="{{ district.address }}" />{{/loop}}',
		});
		await admin.api.components.publish(target);
		const { postType } = await admin.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
		const { template } = await admin.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup:
				'<Outer address=\'{"city":"Dublin"}\' rows=\'[{"city":"Cork"},{"city":"Galway"}]\' districts=\'[{"address":{"city":"Loop city"}}]\' />',
		});
		await admin.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Example" });
		await admin.api.entries.publish({ siteId, entryId: entry.id });
		const origin = await goLive(install, siteId);
		const visible = () => install.request(`${origin}/stories/example`).then(expectSafePage);
		const props = JSON.parse(
			JSON.stringify(first.component.draft.props).replaceAll('"key":"city"', '"key":"town"'),
		) as typeof first.component.draft.props;
		if (mode === "markup")
			await admin.api.components.saveMarkup({
				...target,
				markup: first.markup.replaceAll('"key":"city"', '"key":"town"'),
			});
		else if (mode === "shared") {
			let lostAck = false;
			const live = await openDraft(
				install,
				admin,
				siteId,
				{ kind: "component", id: outer.id },
				{
					through: async (request) => {
						const answer = await install.upgrade(request);
						if (answer instanceof Response) return answer;
						return {
							...answer,
							open: (peer) =>
								answer.open({
									...peer,
									send(data) {
										if (!lostAck && typeof data === "string" && JSON.parse(data).type === "saved") {
											lostAck = true;
											return;
										}
										peer.send(data);
									},
								}),
						};
					},
				},
			);
			const peer = await openDraft(install, admin, siteId, { kind: "component", id: outer.id });
			try {
				live.change((doc) => ({ ...(doc as object), props }) as DocumentJson);
				await live.until(() => lostAck, "the accepted update with its acknowledgement lost on the wire");
				live.disconnect(); // Lose the acknowledgement; reconnect replays the pending update.
				await peer.untilDraft(
					(doc) => JSON.stringify(doc).includes('"binding"'),
					"the accepted projection at the other editor",
				);
				const accepted = await admin.api.components.getMarkup(target);
				await live.reconnect();
				await live.saved();
				await live.untilDraft(
					(doc) => JSON.stringify(doc).includes('"binding"'),
					"the server-derived binding metadata in the shared document",
				);
				expect((await admin.api.components.getMarkup(target)).version).toBe(accepted.version);
				peer.change(
					(doc) =>
						({
							...(doc as object),
							tree: {
								...accepted.component.draft.tree,
								nodes: [...accepted.component.draft.tree.nodes, { type: "comment", text: "Peer note" }],
							},
						}) as DocumentJson,
				);
				await peer.saved();
				await live.untilDraft((doc) => JSON.stringify(doc).includes("Peer note"), "the intervening peer edit");
				// The shared client's next unrelated edit must retain the server's derived mapping.
				live.change((doc) => {
					const current = doc as { tree: { version: number; nodes: DocumentJson[] } };
					return {
						...current,
						tree: { ...current.tree, nodes: [...current.tree.nodes, { type: "comment", text: "Unrelated" }] },
					} as DocumentJson;
				});
				await live.saved();
				const kept = await admin.api.components.getMarkup(target);
				expect(kept.markup.draft).toContain("Peer note");
				const invalid = structuredClone(props);
				const address = invalid[0];
				if (address && "fields" in address && address.fields[0])
					address.fields.push({ ...address.fields[0], key: "badTown" });
				live.change((doc) => ({ ...(doc as object), props: invalid }) as DocumentJson);
				await live.until(() => live.refusals.length === 1, "the duplicate identity refusal");
				await live.untilDraft((doc) => !JSON.stringify(doc).includes("badTown"), "the refused editor reset");
				expect(JSON.stringify(peer.draft())).not.toContain("badTown");
				expect((await admin.api.components.getMarkup(target)).version).toBe(kept.version);
			} finally {
				await live.close();
				await peer.close();
			}
		} else
			await admin.api.components.saveDraft({
				...target,
				props,
				...(mode === "tree" ? { tree: first.component.draft.tree } : {}),
			});
		const changed = await admin.api.components.getMarkup(target);
		expect(changed.propImpact.placements).toBe(0);
		expect(changed.markup.draft).toContain("data-wc-bindings=");
		const placed = changed.component.draft.tree.nodes[0];
		expect(placed?.type === "component" && placed.props.map((p) => p.binding)).toEqual([
			{ root: "props.address", paths: { city: "town" } },
			{ root: "props.rows", paths: { city: "town" } },
		]);
		for (const city of ["Dublin", "Cork", "Galway"]) expect(await visible()).toContain(city);
		await admin.api.components.publish(target);
		const html = await visible();
		expect(html).toContain("Loop city");
		for (const city of ["Dublin", "Cork", "Galway"]) expect(html).toContain(city);
		expect(html).not.toContain("data-wc-bindings");
		if (mode === "settings") {
			const current = await admin.api.components.getMarkup(target);
			await admin.api.components.saveDraft({
				...target,
				props: current.component.draft.props.map((prop) =>
					prop.key === "address" ? { ...prop, key: "location" } : prop,
				),
			});
			const moved = (await admin.api.components.getMarkup(target)).component.draft.tree.nodes[0];
			expect(moved?.type === "component" && moved.props[0]?.binding?.root).toBe("props.location");
			await admin.api.components.publish(target);
			expect(await visible()).toContain("Dublin");
		}
		if (mode === "markup") {
			const current = await admin.api.components.getMarkup({ siteId, componentId: inner.id });
			await admin.api.components.saveMarkup({
				siteId,
				componentId: inner.id,
				markup: current.markup.draft.replaceAll('"key":"city"', '"key":"place"').replaceAll(".city", ".place"),
			});
			await admin.api.components.publish({ siteId, componentId: inner.id });
			for (const city of ["Dublin", "Cork", "Galway"]) expect(await visible()).toContain(city);
		}
		// Successive and reversed renames compose relative to this Component, never to the Entry.
		for (const [from, to] of [
			["town", "borough"],
			["borough", "city"],
		]) {
			const current = await admin.api.components.getMarkup(target);
			await admin.api.components.saveMarkup({
				...target,
				markup: current.markup.draft.replaceAll(`"key":"${from}"`, `"key":"${to}"`),
			});
			await admin.api.components.publish(target);
			for (const city of ["Dublin", "Cork", "Galway"]) expect(await visible()).toContain(city);
		}
		if (mode === "markup") {
			const current = await admin.api.components.getMarkup({ siteId, componentId: inner.id });
			await admin.api.components.saveMarkup({
				siteId,
				componentId: inner.id,
				markup: current.markup.draft.replaceAll('"key":"place"', '"key":"city"').replaceAll(".place", ".city"),
			});
			await admin.api.components.publish({ siteId, componentId: inner.id });
			for (const city of ["Dublin", "Cork", "Galway"]) expect(await visible()).toContain(city);
		}
		expect((await admin.api.components.getMarkup(target)).markup.draft).not.toContain("data-wc-bindings=");
	});
}

test("target binding mappings survive public markup, archive and history and reject stale replacement roots", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const { component } = await admin.api.components.create({ siteId, name: "Card" });
	const target = { siteId, componentId: component.id };
	const first = await admin.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\ncard: group fields=[{"key":"city","label":"City","type":"text"}]\n{{/props}}\n<h2>{{ props.card.city }}</h2>',
	});
	await admin.api.components.publish(target);
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
		fields: ["address", "freshAddress"].map((key) => ({
			key,
			label: key,
			type: "group" as const,
			fields: [
				{ key: "city", label: "City", type: "text" as const },
				{ key: "town", label: "Town", type: "text" as const },
			],
		})),
	});
	const holder = { siteId, postTypeId: postType.id };
	const placed = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: '<Card card="{{ address }}" />',
	});
	await admin.api.templates.publish({ siteId, templateId: placed.template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Example",
		fields: {
			address: { city: "Old value", town: "Fresh value" },
			freshAddress: { town: "New root" },
		},
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	const origin = await goLive(install, siteId);
	const visible = () => install.request(`${origin}/stories/example`).then(expectSafePage);
	await admin.api.components.saveMarkup({
		...target,
		markup: first.markup.replace('"key":"city"', '"key":"town"').replace("props.card.city", "props.card.town"),
	});
	const mapped = await admin.api.templates.getEntryTemplateMarkup(holder);
	if (!mapped.template) throw new Error("Expected mapped Template");
	expect(mapped.markup?.draft).toContain("data-wc-bindings=");
	const roundTrip = await admin.api.templates.saveEntryTemplateMarkup({
		...holder,
		markup: mapped.markup?.draft ?? "",
	});
	expect(roundTrip.template.draft).toEqual(mapped.template.draft);
	await admin.api.components.publish(target);
	expect(await visible()).toContain("Old value");
	const contract = await admin.api.components.getMarkup(target);
	const destructive = await admin.api.components.saveMarkup({
		...target,
		markup: contract.markup.draft.replace('"type":"text"', '"type":"number"'),
	});
	expect(destructive.propImpact.placements).toBe(1);
	expect(await visible()).toContain("Old value");
	await admin.api.components.saveMarkup({ ...target, markup: contract.markup.draft });
	expect((await admin.api.components.getMarkup(target)).propImpact.placements).toBe(0);
	await admin.api.history.leave({ siteId, item: { kind: "template", id: placed.template.id } });
	const archive = await exportedArchive(install, admin, siteId);
	const copied = await importArchive(install, admin, workspaceId, archive, {
		name: "Bound copy",
		slug: "bound-copy",
	});
	expect(copied.status).toBe("done");
	const damaged = rewritten(archive, {
		rows: (table, rows) =>
			table === "public.templates"
				? rows.map((row) => JSON.parse(JSON.stringify(row).replaceAll('"root":"address"', '"root":"freshAddress"')))
				: rows,
	});
	const refused = await importArchive(install, admin, workspaceId, damaged, {
		name: "Stale binding",
		slug: "stale-binding",
	});
	expect(refused).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
	const destination = copied.site?.id ?? "";
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find((p) => p.key === "stories");
	const imported = await admin.api.templates.getEntryTemplateMarkup({
		siteId: destination,
		postTypeId: type?.id ?? "",
	});
	expect(imported.template?.draft.nodes[0]).toMatchObject({
		props: [{ binding: { root: "address", paths: { town: "city" } } }],
	});
	const history = await admin.api.history.list({
		siteId: destination,
		item: { kind: "template", id: imported.template?.id ?? "" },
	});
	const checkpoint = history.copies.find((c) => c.type === "checkpoint");
	await admin.api.history.restore({
		siteId: destination,
		item: { kind: "template", id: imported.template?.id ?? "" },
		copy: { type: "checkpoint", id: checkpoint?.id ?? "" },
	});
	expect(
		(await admin.api.templates.getEntryTemplateMarkup({ siteId: destination, postTypeId: type?.id ?? "" })).markup
			?.draft,
	).toContain("data-wc-bindings=");
	await expect(
		admin.api.templates.saveEntryTemplateMarkup({
			...holder,
			markup: mapped.markup?.draft.replace("{{ address }}", "{{ freshAddress }}") ?? "",
		}),
	).rejects.toMatchObject({
		code: "TEMPLATE_MARKUP_INVALID",
		data: {
			problems: [expect.objectContaining({ line: 1, message: expect.stringContaining("Remove it when replacing") })],
		},
	});
	const fresh = (mapped.markup?.draft ?? "")
		.replace("{{ address }}", "{{ freshAddress }}")
		.replace(/ data-wc-bindings="[^"]*"/, "");
	const replaced = await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: fresh });
	expect(replaced.markup).not.toContain("data-wc-bindings");
	await admin.api.templates.publish({ siteId, templateId: placed.template.id });
	expect(await visible()).toContain("New root");
	const freshPlacement = replaced.markup
		.replace("freshAddress", "address")
		.replace(/data-wc-id="[^"]*"/, 'data-wc-id="fresh-placement"');
	await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: freshPlacement });
	await admin.api.templates.publish({ siteId, templateId: placed.template.id });
	expect(await visible()).toContain("Fresh value");
	const literal = replaced.markup.replace("{{ freshAddress }}", "{&quot;town&quot;:&quot;New literal&quot;}");
	expect((await admin.api.templates.saveEntryTemplateMarkup({ ...holder, markup: literal })).markup).not.toContain(
		"data-wc-bindings",
	);
});
