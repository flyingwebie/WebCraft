import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { coEditingSite } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("two tabs undo their own text while keeping the other tab's text", async () => {
	const site = await coEditingSite(install);
	const saved = await site.staff.api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		markup: '<p data-wc-id="lead">Fresh bread</p>',
	});
	const item = { kind: "template", id: saved.template.id } as const;
	const first = await openDraft(install, site.staff, site.siteId, item);
	const second = await openDraft(install, site.staff, site.siteId, item);
	try {
		const before = first.draft();
		const after = JSON.parse(JSON.stringify(before).replace("Fresh bread", "Fresh warm bread")) as DocumentJson;
		first.change(after);
		await first.saved();
		await second.untilDraft((d) => JSON.stringify(d).includes("warm"), "first tab typing");
		const peerBefore = second.draft();
		const peerAfter = JSON.parse(JSON.stringify(peerBefore).replace("warm bread", "warm bread today")) as DocumentJson;
		second.change(peerAfter);
		await second.saved();
		await first.untilDraft((d) => JSON.stringify(d).includes("today"), "second tab typing");
		expect((await first.reverse(after, before)).ok).toBe(true);
		await second.untilDraft((d) => JSON.stringify(d).includes("Fresh bread today"), "own Undo keeps peer text");
		expect((await second.reverse(peerAfter, peerBefore)).ok).toBe(true);
		const read = await site.staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(read.markup?.draft).toContain("Fresh bread");
		expect(read.markup?.draft).not.toContain("warm");
		expect(read.markup?.draft).not.toContain("today");
	} finally {
		first.close();
		second.close();
	}
});

test("a newer edit to the same value makes a step obsolete, and refused inverses do not report success", async () => {
	const site = await coEditingSite(install);
	const saved = await site.staff.api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		markup: '<p data-wc-id="lead">Original</p>',
	});
	const first = await openDraft(install, site.staff, site.siteId, { kind: "template", id: saved.template.id });
	const peer = await openDraft(install, site.staff, site.siteId, { kind: "template", id: saved.template.id });
	try {
		const before = first.draft();
		const after = JSON.parse(JSON.stringify(before).replace("Original", "Mine")) as DocumentJson;
		first.change(after);
		await first.saved();
		await peer.untilDraft((d) => JSON.stringify(d).includes("Mine"), "own edit");
		peer.change(JSON.parse(JSON.stringify(peer.draft()).replace("Mine", "Peer")) as DocumentJson);
		await peer.saved();
		await first.untilDraft((d) => JSON.stringify(d).includes("Peer"), "peer edit");
		expect(await first.reverse(after, before)).toMatchObject({ ok: false, code: "HISTORY_OBSOLETE" });
		const current = first.draft();
		const unsafe = JSON.parse(JSON.stringify(current).replace('"tag":"p"', '"tag":"script"')) as DocumentJson;
		expect(await first.reverse(current, unsafe)).toMatchObject({ ok: false, code: "TEMPLATE_INVALID" });
		const read = await site.staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(read.markup?.draft).toContain("Peer");
		expect(read.markup?.draft).not.toContain("<script");
	} finally {
		first.close();
		peer.close();
	}
});

test("history navigation transfers are person-bound, single-use and expire", async () => {
	const site = await coEditingSite(install);
	const other = await install.createStaff({ workspaces: [site.workspaceId] });
	const { token } = await site.staff.api.builder.transferHistory({
		siteId: site.siteId,
		payload: '{"past":[],"future":[]}',
	});
	expect(await other.browser.api.builder.claimHistory({ siteId: site.siteId, token })).toEqual({ payload: null });
	expect(await site.staff.api.builder.claimHistory({ siteId: site.siteId, token })).toEqual({
		payload: '{"past":[],"future":[]}',
	});
	expect(await site.staff.api.builder.claimHistory({ siteId: site.siteId, token })).toEqual({ payload: null });
	const expired = await site.staff.api.builder.transferHistory({ siteId: site.siteId, payload: "expired" });
	await install.clock.advance(61_000);
	expect(await site.staff.api.builder.claimHistory({ siteId: site.siteId, token: expired.token })).toEqual({
		payload: null,
	});
});

test("saved CSS history recognises canonical declarations and keeps a peer's other Class properties", async () => {
	const site = await coEditingSite(install);
	const api = site.staff.api;
	const made = await api.designSystem.createClass({ siteId: site.siteId, name: "button", styles: "color: red;" });
	const target = { kind: "class", classId: made.class.id, part: "styles" } as const;
	const initial = await api.builder.css({ siteId: site.siteId, classes: [made.class.id] });
	await api.builder.saveCss({
		siteId: site.siteId,
		target,
		text: "color:blue",
		version: initial.classes[0]?.version ?? null,
	});
	await api.designSystem.updateClass({ siteId: site.siteId, classId: made.class.id, name: "peer-button" });
	const result = await api.builder.reverseHistory({
		siteId: site.siteId,
		resource: `css:${site.siteId}:${JSON.stringify(target)}`,
		from: "color:blue",
		to: "color: red;",
	});
	expect(result.ok).toBe(true);
	const fresh = await api.builder.css({ siteId: site.siteId, classes: [made.class.id] });
	expect(fresh.classes[0]?.styles).toBe("color: red;");
	expect(fresh.classes[0]?.name).toBe("peer-button");
});

test("Undo of a move keeps text a peer edited inside the moved element", async () => {
	const site = await coEditingSite(install);
	const saved = await site.staff.api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		markup: '<p data-wc-id="lead">Original</p><section data-wc-id="box"></section>',
	});
	const first = await openDraft(install, site.staff, site.siteId, { kind: "template", id: saved.template.id });
	const peer = await openDraft(install, site.staff, site.siteId, { kind: "template", id: saved.template.id });
	try {
		const before = first.draft();
		const tree = before as { version: number; nodes: { [key: string]: DocumentJson }[] };
		const after = { ...tree, nodes: [{ ...tree.nodes[1], children: [tree.nodes[0]] }] } as DocumentJson;
		first.change(after);
		await first.saved();
		await peer.untilDraft((d) => (d as { nodes: unknown[] }).nodes.length === 1, "the move");
		peer.change(JSON.parse(JSON.stringify(peer.draft()).replace("Original", "Peer words")) as DocumentJson);
		await peer.saved();
		await first.untilDraft((d) => JSON.stringify(d).includes("Peer words"), "peer text");
		expect((await first.reverse(after, before)).ok).toBe(true);
		const read = await site.staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(read.markup?.draft).toBe('<p data-wc-id="lead">Peer words</p><section data-wc-id="box"></section>');
	} finally {
		first.close();
		peer.close();
	}
});

test("Undo and redo Prop deletion retain declaration identities and Placement values after canonical updates", async () => {
	const site = await coEditingSite(install);
	const api = site.staff.api;
	const { component } = await api.components.create({ siteId: site.siteId, name: "HistoryProps" });
	await api.components.saveMarkup({
		siteId: site.siteId,
		componentId: component.id,
		markup: "{{@props}}\ncaption: text\nother: text\n{{/props}}\n<p>Fixed</p>",
	});
	await api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		markup: '<HistoryProps caption="Kept value" other="Peer value" />',
	});
	const owner = await openDraft(install, site.staff, site.siteId, { kind: "component", id: component.id });
	try {
		const before = owner.draft() as { props: { id: string; key: string }[]; tree: DocumentJson };
		const after = { ...before, props: before.props.filter((p) => p.key !== "caption") };
		owner.change(after);
		await owner.saved();
		const result = await owner.reverse(after, before);
		expect(result.ok).toBe(true);
		const restored = await api.components.getMarkup({ siteId: site.siteId, componentId: component.id });
		expect(restored.component.draft.props.find((p) => p.key === "caption")?.id).toBe(
			before.props.find((p) => p.key === "caption")?.id,
		);
		expect(
			(await api.templates.getEntryTemplateMarkup({ siteId: site.siteId, postTypeId: site.postTypeId })).markup?.draft,
		).toContain('caption="Kept value"');
		if (!result.ok) throw new Error(result.code);
		expect((await owner.reverse(result.after, result.before)).ok).toBe(true);
		expect(
			(await api.components.getMarkup({ siteId: site.siteId, componentId: component.id })).component.draft.props.map(
				(p) => p.key,
			),
		).toEqual(["other"]);
	} finally {
		owner.close();
	}
});

test("a newly created Class can be undone and redone through its shared Design system", async () => {
	const site = await coEditingSite(install);
	const editor = await openDraft(install, site.staff, site.siteId, { kind: "designSystem" });
	try {
		const before = editor.draft();
		await site.staff.api.designSystem.createClass({ siteId: site.siteId, name: "history-class" });
		await editor.untilDraft((d) => JSON.stringify(d).includes("history-class"), "Class creation");
		const after = editor.draft();
		const inverse = await editor.reverse(after, before);
		expect(inverse.ok).toBe(true);
		if (!inverse.ok) throw new Error(inverse.code);
		const redo = await editor.reverse(inverse.after, inverse.before);
		expect(redo).toMatchObject({ ok: true });
		expect(
			(await site.staff.api.designSystem.get({ siteId: site.siteId })).designSystem.draft.classes.some(
				(c) => c.name === "history-class",
			),
		).toBe(true);
	} finally {
		editor.close();
	}
});
