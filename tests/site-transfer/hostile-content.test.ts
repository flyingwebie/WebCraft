// A Site export is input, not a copy of a database (audit A3-3). Its checksums are in its own manifest,
// so anyone can write an archive that reads as sound and holds what no save would store: rich text
// with script, a Template tree with a `<script>` element or an `onclick` attribute, a Body Block whose
// settings break out of its markup. Staff import archives they were given (a client's old Site, a
// starter Site), so what an import stores must pass what a save checks: rich text is cleaned as a
// save cleans it, and a tree or a Body no save would keep refuses the archive.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";
import { openStaging } from "../harness/staging.ts";

let install: TestInstall;
let admin: TestBrowser;
let workspaceId: string;
let archive: Uint8Array;
let copies = 0;

const HOSTILE = '<p>Proof</p><img src="x" onerror="window.pwned = 1"><script>window.pwned = 2</script>';

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "notes", label: "Notes", type: "repeater", fields: [{ key: "note", label: "Note", type: "richText" }] },
			{ key: "body", label: "Body", type: "body" },
		],
	});
	await admin.api.globals.setFields({ siteId, fields: [{ key: "notice", label: "Notice", type: "richText" }] });
	await admin.api.globals.saveDraft({ siteId, fields: { notice: "<p>RICH-MARKER</p>" } });
	await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: {
			intro: "<p>RICH-MARKER</p>",
			notes: [{ note: "<p>RICH-MARKER</p>" }],
			body: [
				{ type: "heading", level: 2, text: "Method" },
				{ type: "callout", tone: "info", text: "Preheat the oven" },
			],
		},
	});
	await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<article><h1 title="Recipe">{{ title }}</h1>{{ intro }}{{ body }}</article>',
	});
	// A script that needs consent, so pages show the banner, and a banner with a privacy policy link.
	await admin.api.outsideScripts.add({
		siteId,
		name: "Visitor counter",
		placement: "head",
		consentCategory: "analytics",
		source: { kind: "url", url: "https://tags.example.com/count.js" },
	});
	await admin.api.consentBanner.setSettings({ siteId, mode: "optIn", layout: "bar" });
	await admin.api.consentBanner.saveDraft({
		siteId,
		fields: { privacyPolicy: { url: "/privacy-policy", text: "Privacy" } },
	});
	await admin.api.designSystem.saveDraft({ siteId, customCss: ".marker { color: red; }" });
	archive = await exportedArchive(install, admin, siteId);
});

afterAll(async () => {
	await install?.close();
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A copy of a row with every value `change` answers something for replaced, wherever it is. */
function changed(value: Json, change: (value: Json) => Json | undefined): Json {
	const replaced = change(value);
	if (replaced !== undefined) return replaced;
	if (Array.isArray(value)) return value.map((item) => changed(item, change));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, changed(item, change)]));
	}
	return value;
}

/** The archive with the rows of some tables changed, as someone writing their own archive can. */
function withRows(tables: readonly string[], change: (value: Json) => Json | undefined): Uint8Array {
	let touched = 0;
	const bytes = rewritten(archive, {
		rows: (table, rows) =>
			tables.includes(table)
				? rows.map((row) => {
						const next = changed(row as Json, change) as Record<string, unknown>;
						if (JSON.stringify(next) !== JSON.stringify(row)) touched++;
						return next;
					})
				: rows,
	});
	if (touched === 0) throw new Error("The archive holds nothing to change there.");
	return bytes;
}

async function importIt(bytes: Uint8Array) {
	const n = ++copies;
	return importArchive(install, admin, workspaceId, bytes, { name: `Copy ${n}`, slug: `copy-${n}` });
}

async function refused(bytes: Uint8Array): Promise<void> {
	const before = (await admin.api.sites.list({ workspaceId })).sites.length;
	const imported = await importIt(bytes);
	expect(imported).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
	expect((await admin.api.sites.list({ workspaceId })).sites).toHaveLength(before);
}

const isElement = (value: Json, tag: string): value is { [key: string]: Json } =>
	value !== null && typeof value === "object" && !Array.isArray(value) && value.type === "element" && value.tag === tag;

const isBlock = (value: Json, type: string): value is { [key: string]: Json } =>
	value !== null && typeof value === "object" && !Array.isArray(value) && value.type === type && "text" in value;

describe("rich text an archive carries", () => {
	test("is stored cleaned, as a save cleans it: in an Entry's Fields, a Repeater's rows and the Globals", async () => {
		const imported = await importIt(
			withRows(["public.entries", "public.globals"], (value) => (value === "<p>RICH-MARKER</p>" ? HOSTILE : undefined)),
		);
		expect(imported.status).toBe("done");
		const siteId = imported.site?.id ?? "";
		const recipes = (await admin.api.postTypes.list({ siteId })).postTypes.find((type) => type.key === "recipes");
		const [entry] = (await admin.api.entries.list({ siteId, postTypeId: recipes?.id ?? "" })).entries;
		expect(entry?.draft.fields.intro).toBe("<p>Proof</p>");
		expect(entry?.draft.fields.notes).toEqual([{ id: expect.any(String), note: "<p>Proof</p>" }]);
		expect((await admin.api.globals.get({ siteId })).globals.draft.notice).toBe("<p>Proof</p>");
		// The copies kept in its history hold nothing else either.
		const history = await admin.api.history.list({ siteId, item: { kind: "entry", id: entry?.id ?? "" } });
		for (const copy of history.copies) {
			const kept = await admin.api.history.get({
				siteId,
				item: { kind: "entry", id: entry?.id ?? "" },
				copy: { type: copy.type, id: copy.id },
			});
			expect(JSON.stringify(kept.content)).not.toContain("onerror");
		}
	});
});

describe("a Template tree an archive carries", () => {
	test("with an element no Template may hold refuses the archive", async () => {
		await refused(
			withRows(["public.templates"], (value) =>
				isElement(value, "h1")
					? { ...value, tag: "script", attributes: [], children: [{ type: "text", text: "window.pwned = 1" }] }
					: undefined,
			),
		);
	});

	test("with an event handler attribute refuses the archive", async () => {
		await refused(
			withRows(["public.templates"], (value) =>
				isElement(value, "h1")
					? { ...value, attributes: [{ name: "onclick", value: [{ type: "text", text: "window.pwned = 1" }] }] }
					: undefined,
			),
		);
	});

	test("with an attribute name that isn't one refuses the archive", async () => {
		await refused(
			withRows(["public.templates"], (value) =>
				isElement(value, "h1")
					? { ...value, attributes: [{ name: 'x="" onclick', value: [{ type: "text", text: "window.pwned = 1" }] }] }
					: undefined,
			),
		);
	});
});

describe("a Body an archive carries", () => {
	test("with a heading level that is markup refuses the archive", async () => {
		await refused(
			withRows(["public.entries"], (value) =>
				isBlock(value, "heading") ? { ...value, level: '2 onmouseover="window.pwned = 1"' } : undefined,
			),
		);
	});

	test("with a callout tone that is markup refuses the archive", async () => {
		await refused(
			withRows(["public.entries"], (value) =>
				isBlock(value, "callout") ? { ...value, tone: 'info" onmouseover="window.pwned = 1' } : undefined,
			),
		);
	});
});

describe("a link an archive carries in the Consent banner's words", () => {
	test("is written on the page only as an address a page may hold", async () => {
		const imported = await importIt(
			withRows(["public.consent_banners"], (value) =>
				value === "/privacy-policy" ? "javascript:alert(1)" : undefined,
			),
		);
		expect(imported.status).toBe("done");
		const staging = await openStaging(install, admin, imported.site?.id ?? "");
		const html = await expectSafePage(await staging.page("/recipes/fresh-bread"));
		expect(html).toContain('<p class="wc-consent-policy"><a href="#">Privacy</a></p>');
		expect(html).not.toContain("javascript:");
	});
});

describe("CSS an archive carries in the Design system", () => {
	test("never reaches the Site's stylesheet when no save would keep it", async () => {
		const css =
			"@import url(https://elsewhere.example/x.css); .marker { background: url(https://elsewhere.example/x.png); }";
		const imported = await importIt(
			withRows(["public.design_systems"], (value) => (value === ".marker { color: red; }" ? css : undefined)),
		);
		expect(imported.status).toBe("done");
		const staging = await openStaging(install, admin, imported.site?.id ?? "");
		const html = await expectSafePage(await staging.page("/recipes/fresh-bread"));
		const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1] ?? "");
		expect(sheets.length).toBeGreaterThan(0);
		for (const sheet of sheets) {
			const text = await (await staging.page(sheet)).text();
			expect(text).not.toContain("elsewhere.example");
			expect(text).not.toContain("@import");
		}
	});
});

describe("an archive as WebCraft writes it", () => {
	test("still imports, and its page renders as before", async () => {
		const imported = await importIt(archive);
		expect(imported.status).toBe("done");
		const siteId = imported.site?.id ?? "";
		const recipes = (await admin.api.postTypes.list({ siteId })).postTypes.find((type) => type.key === "recipes");
		const [entry] = (await admin.api.entries.list({ siteId, postTypeId: recipes?.id ?? "" })).entries;
		expect(entry?.draft.fields.intro).toBe("<p>RICH-MARKER</p>");
		const staging = await openStaging(install, admin, siteId);
		const html = await expectSafePage(await staging.page("/recipes/fresh-bread"));
		expect(html).toContain('<h1 title="Recipe">Fresh bread</h1>');
		expect(html).toContain("<h2");
	});
});
