// The Undo history in Edit mode (ADR 0036), as the server sees it: a save of a typed value answers the
// exact change it made, own steps are taken back through the person's own Draft socket (so the
// ordinary write rules decide), and the history's page-to-page handoff belongs to the Edit mode
// session's person and Site. Nothing here gives a Member more than their Edit session already may do.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";

import { openDraftInEditMode } from "../harness/co-editing.ts";
import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = { siteId: string; entryId: string; pageId: string; componentId: string };
type Receipt = { resource: string; before: DocumentJson; after: DocumentJson };

/**
 * A Site with a Tagline in its Globals, a published Blog post at /blog/fresh-bread and a home Page
 * whose Page layout Members may arrange: two Hero Placements, "North" and "South".
 */
async function bakery(): Promise<Bakery> {
	const slug = `undo-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await editor.api.globals.publish({ siteId });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			"<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div><p>{{ address.city }}</p><p>{{ site.tagline }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven", intro: "<p>Baked at seven.</p>", address: { city: "Cork" } },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pageType = postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Missing Page Post Type");
	const { entry: page } = await staff.api.entries.create({ siteId, postTypeId: pageType.id, title: "Home" });
	await staff.api.pages.setHomePage({ siteId, pageId: page.id });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", translatable: true }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h2>{{ props.heading }}</h2></section>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const state = await staff.api.pageLayouts.get({ siteId, entryId: page.id });
	await staff.api.pageLayouts.save({
		siteId,
		entryId: page.id,
		basedOn: state.version,
		layout: {
			placements: ["North", "South"].map((heading) => ({
				id: heading.toLowerCase(),
				component: component.id,
				props: component.draft.props,
				values: { heading: { en: heading } },
			})),
		},
	});
	await staff.api.entries.publish({ siteId, entryId: page.id });
	return { siteId, entryId: entry.id, pageId: page.id, componentId: component.id };
}

async function saved(response: Response): Promise<{ value: unknown; history: Receipt }> {
	expect(response.status).toBe(200);
	return (await response.json()) as { value: unknown; history: Receipt };
}

/** A Page layout's change as the Entry's shared document holds it: the Draft's `layout` and nothing else. */
function layoutChange(siteId: string, entryId: string, before: unknown, after: unknown): Receipt {
	return {
		resource: `draft:${siteId}:entry:${entryId}`,
		before: { layout: before } as DocumentJson,
		after: { layout: after } as DocumentJson,
	};
}

test("a typed value's save answers its exact change, which the Member's own Draft takes back beside a peer's edit", async () => {
	const site = await bakery();
	const editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
	const item = `entry:${site.entryId}`;

	const subtitle = await saved(await editing.edit("save", { item, field: "subtitle", value: "  Still warm " }));
	// The receipt is the Draft's own change as it was stored (trimmed), never the text as it was typed.
	expect(subtitle.history).toEqual({
		resource: `draft:${site.siteId}:entry:${site.entryId}`,
		before: { values: { subtitle: { en: "Out of the oven" } } },
		after: { values: { subtitle: { en: "Still warm" } } },
	});
	const city = await saved(await editing.edit("save", { item, field: "address.city", value: "Kinsale" }));
	expect(city.history.before).toEqual({ values: { address: { values: { city: { en: "Cork" } } } } });
	expect(city.history.after).toEqual({ values: { address: { values: { city: { en: "Kinsale" } } } } });
	const title = await saved(await editing.edit("save", { item, field: "title", value: "Fresher bread" }));
	expect(title.history.before).toEqual({ values: { title: { en: "Fresh bread" } } });
	const intro = await saved(
		await editing.edit("save", { item, field: "intro", value: '<p onclick="steal()">Baked at <b>six</b>.</p>' }),
	);
	expect(intro.history.after).toEqual({ values: { intro: { en: intro.value as string } } });
	const tagline = await saved(await editing.edit("save", { item: "globals", field: "tagline", value: "Twice daily" }));
	expect(tagline.history).toEqual({
		resource: `draft:${site.siteId}:globals`,
		before: { values: { tagline: { en: "Baked daily" } } },
		after: { values: { tagline: { en: "Twice daily" } } },
	});

	// Staff change another value of the same Draft afterwards: taking the Member's step back keeps it.
	await staff.api.entries.saveDraft({ siteId: site.siteId, entryId: site.entryId, title: "Staff's title" });
	const draft = await openDraftInEditMode(editing, { kind: "entry", id: site.entryId });
	const globals = await openDraftInEditMode(editing, { kind: "globals" });
	try {
		expect(await draft.reverse(subtitle.history.after, subtitle.history.before)).toMatchObject({ ok: true });
		expect(await draft.reverse(city.history.after, city.history.before)).toMatchObject({ ok: true });
		// Staff wrote the title since: the Member's own title step no longer applies, and nothing is overwritten.
		expect(await draft.reverse(title.history.after, title.history.before)).toEqual({
			ok: false,
			code: "HISTORY_OBSOLETE",
		});
		expect(await globals.reverse(tagline.history.after, tagline.history.before)).toMatchObject({ ok: true });
	} finally {
		draft.close();
		globals.close();
	}
	const { entry } = await staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
	expect(entry.draft.title).toBe("Staff's title");
	expect(entry.draft.fields.subtitle).toBe("Out of the oven");
	expect(entry.draft.fields.address).toEqual({ city: "Cork" });
	expect(entry.draft.fields.intro).toBe(intro.value as string);
	expect((await staff.api.globals.get({ siteId: site.siteId })).globals.draft.tagline).toBe("Baked daily");
});

test("a Member and Staff on one Page layout each take back only their own steps", async () => {
	const site = await bakery();
	const memberEditing = await openEditMode(install, editor, site.siteId, "/");
	const staffEditing = await openEditMode(install, staff, site.siteId, "/");
	const read = async (editing: EditModeBrowser) =>
		(await (await editing.edit("layout/get", { entryId: site.pageId })).json()) as {
			version: string;
			layout: { placements: { id: string; hidden?: boolean; values: Record<string, unknown> }[] };
		};
	const save = async (editing: EditModeBrowser, layout: unknown, basedOn: string) => {
		const response = await editing.edit("layout/save", { entryId: site.pageId, layout, basedOn });
		expect(response.status).toBe(200);
		return (await response.json()) as Awaited<ReturnType<typeof read>>;
	};

	// The Member moves South first; then Staff hide North.
	const start = await read(memberEditing);
	const moved = await save(memberEditing, { placements: [...start.layout.placements].reverse() }, start.version);
	const memberStep = layoutChange(site.siteId, site.pageId, start.layout, moved.layout);
	const hidden = await save(
		staffEditing,
		{ placements: moved.layout.placements.map((p) => (p.id === "north" ? { ...p, hidden: true } : p)) },
		moved.version,
	);
	const staffStep = layoutChange(site.siteId, site.pageId, moved.layout, hidden.layout);

	const member = await openDraftInEditMode(memberEditing, { kind: "entry", id: site.pageId });
	const staffDraft = await openDraftInEditMode(staffEditing, { kind: "entry", id: site.pageId });
	try {
		// The Member's Undo puts the order back and leaves Staff's hidden Placement hidden.
		expect(await member.reverse(memberStep.after, memberStep.before)).toMatchObject({ ok: true });
		let now = await read(staffEditing);
		expect(now.layout.placements.map((p) => [p.id, !!p.hidden])).toEqual([
			["north", true],
			["south", false],
		]);
		// Staff's Undo shows North again and leaves the Member's order as the Member last put it.
		await staffDraft.untilDraft(
			(draft) => (draft as { layout: typeof now.layout }).layout.placements[0]?.id === "north",
			"the Member's Undo",
		);
		expect(await staffDraft.reverse(staffStep.after, staffStep.before)).toMatchObject({ ok: true });
		now = await read(memberEditing);
		expect(now.layout.placements.map((p) => [p.id, !!p.hidden])).toEqual([
			["north", false],
			["south", false],
		]);
	} finally {
		member.close();
		staffDraft.close();
	}
});

test("the server's own rules still refuse a Member's step that Staff have since ruled out", async () => {
	const site = await bakery();
	const editing = await openEditMode(install, editor, site.siteId, "/");
	const start = (await (await editing.edit("layout/get", { entryId: site.pageId })).json()) as {
		version: string;
		layout: { placements: { id: string }[] };
	};
	const removed = await editing.edit("layout/save", {
		entryId: site.pageId,
		layout: { placements: start.layout.placements.filter((p) => p.id !== "south") },
		basedOn: start.version,
	});
	expect(removed.status).toBe(200);
	const after = ((await removed.json()) as typeof start).layout;
	// Staff stop allowing the Component: putting the Placement back is adding one Members may not add.
	await staff.api.pageLayouts.configure({ siteId: site.siteId, allowedComponents: [] });
	const draft = await openDraftInEditMode(editing, { kind: "entry", id: site.pageId });
	try {
		const step = layoutChange(site.siteId, site.pageId, start.layout, after);
		const refusal = await draft.reverse(step.after, step.before);
		expect(refusal.ok).toBe(false);
		expect(refusal).not.toMatchObject({ code: "HISTORY_OBSOLETE" });
	} finally {
		draft.close();
	}
	const now = await staff.api.pageLayouts.get({ siteId: site.siteId, entryId: site.pageId });
	expect(now.layout.placements.map((p) => p.id)).toEqual(["north"]);
});

test("the history handoff belongs to the Edit mode session's person and Site, works once and expires", async () => {
	const site = await bakery();
	const other = await bakery();
	const member = await openEditMode(install, editor, site.siteId, "/");
	const staffEditing = await openEditMode(install, staff, site.siteId, "/");
	const elsewhere = await openEditMode(install, editor, other.siteId, "/");
	const payload = '{"past":[],"future":[]}';
	const transfer = async (editing: EditModeBrowser) => {
		const response = await editing.edit("history/transfer", { payload });
		expect(response.status).toBe(200);
		return ((await response.json()) as { token: string }).token;
	};
	const claim = async (editing: EditModeBrowser, token: string) =>
		(await (await editing.edit("history/claim", { token })).json()) as { payload: string | null };

	const token = await transfer(member);
	expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	// Not another person's, not on another Site, and only once.
	expect(await claim(staffEditing, token)).toEqual({ payload: null });
	expect(await claim(elsewhere, token)).toEqual({ payload: null });
	expect(await claim(member, token)).toEqual({ payload });
	expect(await claim(member, token)).toEqual({ payload: null });
	const late = await transfer(member);
	await install.clock.advance(61_000);
	expect(await claim(member, late)).toEqual({ payload: null });

	// The handoff is every Edit mode person's; what Code mode alone may take back stays Staff's.
	for (const [action, body] of [
		["code/transferHistory", { payload }],
		["code/claimHistory", { token: "x".repeat(43) }],
		["code/reverseHistory", { resource: `css:${site.siteId}:{"kind":"site"}`, from: "a{}", to: "" }],
	] as const) {
		const refused = await member.edit(action, body);
		expect({ action, status: refused.status }).toEqual({ action, status: 403 });
	}
	// A request without the session's header token is refused like every other edit request.
	expect((await member.edit("history/transfer", { payload }, { headerToken: null })).status).toBe(403);
	expect((await member.edit("history/transfer", { payload: 7 })).status).toBe(400);
});

test("losing access ends the handoff and the Draft socket with Edit mode", async () => {
	const site = await bakery();
	const leaving = await install.createMember({ workspaceId, role: "editor", name: "Lee Leaving" });
	const editing = await openEditMode(install, leaving.browser, site.siteId, "/blog/fresh-bread");
	const step = await saved(
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Mine" }),
	);
	const token = ((await (await editing.edit("history/transfer", { payload: "{}" })).json()) as { token: string }).token;
	const draft = await openDraftInEditMode(editing, { kind: "entry", id: site.entryId });
	try {
		await staff.api.members.remove({ workspaceId, personId: leaving.personId });
		expect((await editing.edit("history/claim", { token })).status).toBe(401);
		expect((await editing.edit("history/transfer", { payload: "{}" })).status).toBe(401);
		expect(await draft.reverse(step.history.after, step.history.before)).toMatchObject({ ok: false });
	} finally {
		draft.close();
	}
	const { entry } = await staff.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
	expect(entry.draft.fields.subtitle).toBe("Mine");
});

test("a mode switch shows the same page again with the handoff, only for a browser in Edit mode", async () => {
	const site = await bakery();
	const editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
	const token = ((await (await editing.edit("history/transfer", { payload: "{}" })).json()) as { token: string }).token;
	const again = (to: string, history = token, browser = editing.browser) =>
		browser.request(`${editing.origin}/_webcraft/edit/again?to=${encodeURIComponent(to)}&history=${history}`);

	const answer = await again("/blog/fresh-bread?page=2");
	expect(answer.status).toBe(303);
	expect(answer.headers.get("location")).toBe(`/blog/fresh-bread?page=2#wc-history=${token}`);
	expect(answer.headers.get("cache-control")).toBe("no-store");
	// It only sends the browser back to a page of this Site: no other address, no made-up token.
	for (const to of ["//elsewhere.test/", "https://elsewhere.test/", "/\\elsewhere.test", "/a#b", "/a b", "blog"]) {
		expect({ to, status: (await again(to)).status }).toEqual({ to, status: 404 });
	}
	expect((await again("/blog/fresh-bread", "not-a-token")).status).toBe(404);
	// Without Edit mode there is nothing to hand over to.
	expect((await again("/blog/fresh-bread", token, install.browser({ origin: editing.origin }))).status).toBe(404);
	expect(
		(
			await editing.browser.request(
				new Request(`${editing.origin}/_webcraft/edit/again?to=%2F&history=${token}`, { method: "POST" }),
			)
		).status,
	).toBe(405);
	// It claimed nothing: the page still can.
	expect(await (await editing.edit("history/claim", { token })).json()).toEqual({ payload: "{}" });
});
