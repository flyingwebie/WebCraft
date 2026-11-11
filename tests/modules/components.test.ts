// Components a Module declares (ADR 0024): declarative, their Props declared with the Field types
// and their output in Template markup. They are Components like any other, placed with their
// PascalCase tag and their Props checked the same way, but only on Sites where the Module runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { component, type ModuleDefinition } from "@webcraft/module-sdk";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { sampleBoard } from "./sample/board.ts";
import { sample } from "./sample/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample, sampleBoard] });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let kinds = 0;

/** A Post Type whose Entry template is `markup`, published, with one published Entry; answers its path. */
async function publishedEntry(
	site: string,
	markup: string,
): Promise<{ path: string; templateId: string; postTypeId: string }> {
	const key = `kind-${++kinds}`;
	const { postType } = await staff.api.postTypes.create({ siteId: site, name: key, key, urlPattern: `/${key}/{slug}` });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId: site, postTypeId: postType.id, markup });
	await staff.api.templates.publish({ siteId: site, templateId: saved.template.id });
	const { entry } = await editor.api.entries.create({ siteId: site, postTypeId: postType.id, title: "Rye & spelt" });
	await editor.api.entries.publish({ siteId: site, entryId: entry.id });
	return { path: `/${key}/rye-spelt`, templateId: saved.template.id, postTypeId: postType.id };
}

async function mainOf(host: string, path: string): Promise<string> {
	const response = await install.request(`https://${host}.live.test${path}`);
	expect(response.status).toBe(200);
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await response.text())?.[1] ?? "";
}

describe("a Module's Component", () => {
	test("is listed on Sites where the Module runs, already published", async () => {
		const { components } = await staff.api.components.list({ siteId });

		const noteCard = components.find((listed) => listed.name === "NoteCard");
		expect(noteCard).toMatchObject({
			id: "sample:NoteCard",
			module: { id: "sample" },
			status: "published",
			draft: {
				props: [
					{ key: "body", label: "Text", type: "text", required: true },
					{ key: "tone", label: "Tone", type: "select", default: "calm" },
				],
			},
		});
		expect(noteCard?.published).toEqual(noteCard?.draft ?? null);
		const { markup } = await staff.api.components.getMarkup({ siteId, componentId: "sample:NoteCard" });
		expect(markup.draft).toStartWith("{{@props}}\n  body: text required");
		expect(markup.draft).toContain('\n  tone: select default="calm"');
		expect(markup.published).toBe(markup.draft);
		expect(markup.draft).toMatch(
			/\{\{\/props\}\}\n<aside data-tone="\{\{ props\.tone\.value \}\}" data-wc-id="\w+"><p data-wc-id="\w+">\{\{ props\.body \}\}<\/p><\/aside>$/,
		);
	});

	test("is placed with its tag, its Props checked as any Component's are", async () => {
		const { path, templateId } = await publishedEntry(siteId, '<NoteCard body="{{ title }}" tone="loud" />');

		expect(await mainOf("bakery", path)).toBe('<aside data-tone="loud"><p>Rye &amp; spelt</p></aside>');
		const { template } = await staff.api.templates.getEntryTemplate({
			siteId,
			postTypeId: (await staff.api.postTypes.list({ siteId })).postTypes.find((kind) => kind.key === `kind-${kinds}`)
				?.id as string,
		});
		expect(template?.id).toBe(templateId);
		expect(template?.published?.nodes[0]).toMatchObject({ type: "component", component: "sample:NoteCard" });
		expect((await staff.api.components.get({ siteId, componentId: "sample:NoteCard" })).usage.pages).toBe(1);

		const { postType } = await staff.api.postTypes.create({ siteId, name: "Refused", urlPattern: "/refused/{slug}" });
		await expect(
			staff.api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: postType.id,
				markup: '<NoteCard tone="calm" />\n<NoteCard body="Hi" tone="shouty" />',
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{ line: 1, message: "NoteCard needs body: the Prop is required." },
					{ line: 2, message: "tone: shouty isn't one of the Field's choices." },
				],
			},
		});
		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: postType.id,
				tree: {
					version: 1,
					nodes: [
						{
							type: "component",
							id: "missing-body",
							component: "sample:NoteCard",
							props: [{ name: "tone", value: [{ type: "text", text: "calm" }] }],
						},
					],
				},
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
	});

	test("can be placed only on Sites where the Module runs, and shows nothing where it was switched off", async () => {
		const other = await install.createSite(workspaceId, { slug: "market" });
		await goLive(install, other.id);
		const { path, postTypeId } = await publishedEntry(other.id, '<p>Hello</p><NoteCard body="Placed" />');
		expect(await mainOf("market", path)).toBe('<p>Hello</p><aside data-tone="calm"><p>Placed</p></aside>');

		await staff.api.modules.setOnSite({ siteId: other.id, moduleId: "sample", on: false });

		// Switching it off clears the Site's page cache: its pages no longer show the Component.
		expect(await mainOf("market", path)).toBe("<p>Hello</p>");
		// The Template still places it, and its markup still names it.
		const { markup } = await staff.api.templates.getEntryTemplateMarkup({ siteId: other.id, postTypeId });
		expect(markup?.published).toMatch(/^<p data-wc-id="\w+">Hello<\/p><NoteCard body="Placed" data-wc-id="\w+" \/>$/);
		const { postType } = await staff.api.postTypes.create({ siteId: other.id, name: "Off", urlPattern: "/off/{slug}" });
		await expect(
			staff.api.templates.saveEntryTemplateMarkup({
				siteId: other.id,
				postTypeId: postType.id,
				markup: '<NoteCard body="x" />',
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ message: "NoteCard comes from the Module sample, which isn't on for this Site." }] },
		});
		expect((await staff.api.components.list({ siteId: other.id })).components).toEqual([]);
		await expect(staff.api.components.get({ siteId: other.id, componentId: "sample:NoteCard" })).rejects.toMatchObject({
			code: "COMPONENT_NOT_FOUND",
		});

		await staff.api.modules.setOnSite({ siteId: other.id, moduleId: "sample", on: true });
		expect(await mainOf("market", path)).toBe('<p>Hello</p><aside data-tone="calm"><p>Placed</p></aside>');
	});

	test("changes with its Module, never on a Site", async () => {
		const componentId = "sample:NoteCard";

		await expect(staff.api.components.saveMarkup({ siteId, componentId, markup: "<p>Mine</p>" })).rejects.toMatchObject(
			{
				code: "COMPONENT_FROM_MODULE",
			},
		);
		await expect(staff.api.components.publish({ siteId, componentId })).rejects.toMatchObject({
			code: "COMPONENT_FROM_MODULE",
		});
		await expect(staff.api.components.rename({ siteId, componentId, name: "Mine" })).rejects.toMatchObject({
			code: "COMPONENT_FROM_MODULE",
		});
		await expect(staff.api.components.delete({ siteId, componentId })).rejects.toMatchObject({
			code: "COMPONENT_FROM_MODULE",
		});
	});

	test("keeps its name: a Site's own Component can't take it", async () => {
		await expect(staff.api.components.create({ siteId, name: "NoteCard" })).rejects.toMatchObject({
			code: "COMPONENT_NAME_TAKEN",
			data: { name: "NoteCard", by: { kind: "module", moduleId: "sample" } },
		});
	});
});

describe("a Module whose Components break a rule", () => {
	const withComponents = (components: ModuleDefinition["components"]): ModuleDefinition => ({
		...sample,
		components,
	});
	const broken: [string, ModuleDefinition | ModuleDefinition[], string][] = [
		[
			"a name that isn't a PascalCase tag",
			withComponents([component({ name: "noteCard", label: { en: "Card", it: "Scheda" }, markup: "<p>x</p>" })]),
			"noteCard isn't a Component's name",
		],
		[
			"markup that can't be read",
			withComponents([component({ name: "Bad", label: { en: "Bad", it: "Male" }, markup: "<p>{{ props.nope }}</p>" })]),
			"The Component Bad's markup can't be read: line 1, column 7: There is no Prop named nope on this Component.",
		],
		[
			"markup reading the Globals, which differ on every Site",
			withComponents([
				component({ name: "Phone", label: { en: "Phone", it: "Telefono" }, markup: "<p>{{ site.phone }}</p>" }),
			]),
			"A Module's Component reads only its Props",
		],
		[
			"a Relationship Prop",
			withComponents([
				component({
					name: "Linked",
					label: { en: "Linked", it: "Collegato" },
					props: [{ key: "post", label: { en: "Post", it: "Articolo" }, type: "relationship" as never }],
					markup: "<p>x</p>",
				}),
			]),
			"can't have Relationship Props",
		],
		[
			"a Prop label missing in a language it declares",
			withComponents([
				component({
					name: "Half",
					label: { en: "Half", it: "Metà" },
					props: [{ key: "words", label: { en: "Words" }, type: "text" }],
					markup: "<p>{{ props.words }}</p>",
				}),
			]),
			"Words are missing in it",
		],
		[
			"a Workspace-level Module",
			{
				...sampleBoard,
				components: [component({ name: "Pin", label: { en: "Pin", it: "Puntina" }, markup: "<p>Pin</p>" })],
			},
			"Only Site-level Modules add Components",
		],
		[
			"a name another Module's Component has",
			[
				sample,
				{
					manifest: { ...sample.manifest, id: "sample-copy", routePrefix: undefined },
					components: [component({ name: "NoteCard", label: { en: "Copy", it: "Copia" }, markup: "<p>x</p>" })],
				},
			],
			"The Module sample already adds a Component named NoteCard.",
		],
	];

	for (const [what, definitions, reason] of broken) {
		test(`lists ${what} as unable to run, with the reason`, async () => {
			const modules = Array.isArray(definitions) ? definitions : [definitions];
			const refused = await createTestInstall({ modules });
			try {
				const listed = (await (await refused.superadmin()).api.modules.list()).modules.at(-1);
				expect(listed?.status).toBe("cannot-run");
				expect(listed?.problem).toContain(reason);
			} finally {
				await refused.close();
			}
		});
	}
});
