// Classes (ADR 0009, spec stories 66 and 67): named sets of styles that elements refer to by id.
// Template markup names them; renaming one changes every use; deleting one in use is refused with
// where it is used; `wc-` names are WebCraft's. Token utilities are named like Classes, and only the
// Classes and utilities published elements use reach the stylesheet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { layerOf, pageWithStyles } from "../harness/site-styles.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A new Site with a Post Type, an Entry template written as `markup` (published) and a published post. */
async function siteWith(markup: string) {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const url = `https://${slug}.sites.test/blog/fresh-bread`;
	const main = async () =>
		/<main id="wc-main" tabindex="-1">([\s\S]*)<\/main>/.exec((await pageWithStyles(install, url)).html)?.[1];
	return { siteId, postTypeId: postType.id, templateId: saved.template.id, url, main };
}

/** A new Site whose Design system has a Class `card`, used by its published Entry template. */
async function siteWithCard() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { class: card } = await staff.api.designSystem.createClass({
		siteId,
		name: "card",
		styles: "padding: var(--space-m); border-radius: var(--radius-m);",
	});
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<article class="card"><h1>{{ title }}</h1></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return {
		siteId,
		postTypeId: postType.id,
		templateId: saved.template.id,
		card,
		url: `https://${slug}.sites.test/blog/fresh-bread`,
	};
}

/** The error a call was refused with. */
async function refusal(call: Promise<unknown>): Promise<{ code: string; data: unknown }> {
	return call.then(
		() => {
			throw new Error("The call was not refused.");
		},
		(error: { code: string; data: unknown }) => error,
	);
}

describe("Classes in Template markup and on pages", () => {
	test("Template markup names a Class; pages show it, with its styles, once the Design system is published", async () => {
		const { siteId, url } = await siteWithCard();

		// The Template is published, the Class isn't yet: a restyle goes live in one go.
		expect((await pageWithStyles(install, url)).html).toContain("<article><h1>Fresh bread</h1></article>");

		await staff.api.designSystem.publish({ siteId });

		const { html, css } = await pageWithStyles(install, url);
		expect(html).toContain('<article class="card"><h1>Fresh bread</h1></article>');
		expect(layerOf(css, "classes")).toBe(".card{padding:var(--space-m);border-radius:var(--radius-m)}");
	});

	test("a Class's breakpoint styles apply from that width up, and its own CSS nests under it", async () => {
		const { siteId, card, url } = await siteWithCard();
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		const md = designSystem.draft.tokens.breakpoints.find((breakpoint) => breakpoint.name === "md");

		await staff.api.designSystem.updateClass({
			siteId,
			classId: card.id,
			breakpoints: { [md?.id ?? ""]: "display: grid; gap: var(--space-s);" },
			css: "&:hover { box-shadow: var(--shadow-m); }\n& h1 { margin: 0; }",
		});
		await staff.api.designSystem.publish({ siteId });

		const { css } = await pageWithStyles(install, url);
		expect(layerOf(css, "classes")).toBe(
			[
				".card{padding:var(--space-m);border-radius:var(--radius-m)}",
				"@media (min-width:768px){.card{display:grid;gap:var(--space-s)}}",
			].join("\n"),
		);
		expect(layerOf(css, "custom")).toBe(".card{&:hover{box-shadow:var(--shadow-m)}& h1{margin:0}}");
	});

	test("only the Classes published elements use reach the stylesheet", async () => {
		const { siteId, url } = await siteWithCard();
		await staff.api.designSystem.createClass({ siteId, name: "unused", styles: "color: red;" });
		await staff.api.designSystem.publish({ siteId });

		const { css } = await pageWithStyles(install, url);
		expect(layerOf(css, "classes")).toContain(".card{");
		expect(css).not.toContain("unused");
	});
});

describe("renaming", () => {
	test("renaming a Class changes every use: the markup, CSS naming it, and pages once published", async () => {
		const { siteId, postTypeId, card, url } = await siteWithCard();
		await staff.api.designSystem.saveDraft({ siteId, customCss: ".card h1 { font-size: var(--text-xl); }" });
		await staff.api.designSystem.publish({ siteId });

		const renamed = await staff.api.designSystem.updateClass({ siteId, classId: card.id, name: "tile" });

		expect(renamed.class).toMatchObject({ id: card.id, name: "tile" });
		expect(renamed.designSystem.draft.customCss).toBe(".tile h1 { font-size: var(--text-xl); }");
		const { markup } = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
		expect(markup?.draft).toStartWith('<article class="tile" data-wc-id=');
		expect(markup?.published).toStartWith('<article class="tile" data-wc-id=');
		// Visitors keep the old name until the Design system is published.
		expect((await pageWithStyles(install, url)).html).toContain('<article class="card">');

		await staff.api.designSystem.publish({ siteId });

		const { html, css } = await pageWithStyles(install, url);
		expect(html).toContain('<article class="tile"><h1>Fresh bread</h1></article>');
		expect(layerOf(css, "classes")).toStartWith(".tile{");
		expect(layerOf(css, "custom")).toBe(".tile h1{font-size:var(--text-xl)}");
		expect(css).not.toContain("card");
	});

	test("CSS sent back as it was read keeps its references, even when a name changed in the same save", async () => {
		const { siteId, card } = await siteWithCard();
		await staff.api.designSystem.saveDraft({ siteId, customCss: ".card { outline: 1px solid; }" });
		const { designSystem } = await staff.api.designSystem.get({ siteId });

		const saved = await staff.api.designSystem.saveDraft({
			siteId,
			classes: designSystem.draft.classes.map((each) => (each.id === card.id ? { ...each, name: "panel" } : each)),
			customCss: designSystem.draft.customCss,
		});

		expect(saved.designSystem.draft.customCss).toBe(".panel { outline: 1px solid; }");
	});

	test("renaming a token renames its utilities and every CSS use of it", async () => {
		const { siteId, postTypeId, card } = await siteWithCard();
		await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: '<article class="card bg-primary-10"><h1>{{ title }}</h1></article>',
		});
		await staff.api.designSystem.updateClass({ siteId, classId: card.id, styles: "color: var(--primary-80);" });
		const { designSystem } = await staff.api.designSystem.get({ siteId });

		const saved = await staff.api.designSystem.saveDraft({
			siteId,
			tokens: {
				...designSystem.draft.tokens,
				colours: designSystem.draft.tokens.colours.map((colour) =>
					colour.name === "primary" ? { ...colour, name: "brand" } : colour,
				),
			},
		});

		expect(saved.designSystem.draft.classes.find((each) => each.id === card.id)?.styles).toBe(
			"color: var(--brand-80);",
		);
		const { markup } = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
		expect(markup?.draft).toStartWith('<article class="card bg-brand-10" data-wc-id=');
	});
});

describe("deleting", () => {
	test("a Class nothing uses can be deleted", async () => {
		const { siteId } = await siteWithCard();
		const { class: spare } = await staff.api.designSystem.createClass({ siteId, name: "spare" });

		const { designSystem } = await staff.api.designSystem.deleteClass({ siteId, classId: spare.id });

		expect(designSystem.draft.classes.map((each) => each.name)).toEqual(["card"]);
	});

	test("deleting a Class in use is refused, saying where it is used", async () => {
		const { siteId, card, templateId, postTypeId } = await siteWithCard();
		const { class: other } = await staff.api.designSystem.createClass({
			siteId,
			name: "other",
			css: "& .card { margin: 0; }",
		});
		await staff.api.designSystem.saveDraft({ siteId, customCss: ".card { outline: none; }" });

		const refused = await refusal(staff.api.designSystem.deleteClass({ siteId, classId: card.id }));

		expect(refused.code).toBe("CLASS_IN_USE");
		const { usedBy } = refused.data as { usedBy: unknown[] };
		expect(usedBy).toEqual([
			{
				kind: "template",
				templateId,
				templateKind: "entry",
				postTypeId,
				version: "draft",
				elements: [expect.any(String)],
			},
			{
				kind: "template",
				templateId,
				templateKind: "entry",
				postTypeId,
				version: "published",
				elements: [expect.any(String)],
			},
			{ kind: "class", classId: other.id, name: "other" },
			{ kind: "customCss" },
		]);
		expect((await staff.api.designSystem.get({ siteId })).designSystem.draft.classes).toHaveLength(2);
	});

	test("removing a token in use is refused, saying where it is used", async () => {
		const { siteId, card } = await siteWithCard();
		await staff.api.designSystem.updateClass({ siteId, classId: card.id, styles: "color: var(--accent-70);" });
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		const accent = designSystem.draft.tokens.colours.find((colour) => colour.name === "accent");

		const refused = await refusal(
			staff.api.designSystem.saveDraft({
				siteId,
				tokens: {
					...designSystem.draft.tokens,
					colours: designSystem.draft.tokens.colours.filter((colour) => colour.id !== accent?.id),
				},
			}),
		);

		// The default base style of <mark> uses the accent colour too.
		expect(refused).toMatchObject({
			code: "TOKEN_IN_USE",
			data: {
				tokenId: accent?.id,
				usedBy: [
					{ kind: "class", classId: card.id, name: "card" },
					{ kind: "baseStyle", target: "mark" },
				],
			},
		});
	});
});

describe("names", () => {
	/** Saving a Class named `name` is refused with one problem about its name. */
	async function refusesName(name: string, says: string) {
		const { siteId } = await siteWithCard();
		const refused = await refusal(staff.api.designSystem.createClass({ siteId, name }));
		expect(refused.code).toBe("DESIGN_SYSTEM_INVALID");
		expect(refused.data).toEqual({ problems: [{ at: "classes[1].name", message: expect.stringContaining(says) }] });
	}

	test("names starting with wc- are WebCraft's", async () => {
		await refusesName("wc-card", "WebCraft's");
		await refusesName("WC-Card", "WebCraft's");
	});

	test("each Class has a name of its own, which no token utility has", async () => {
		await refusesName("card", "Another Class is named card");
		await refusesName("p-m", "token utility");
		await refusesName("2-up", "A Class name is a letter");
	});

	test("markup can't name a WebCraft class", async () => {
		const { siteId, postTypeId } = await siteWithCard();
		const refused = await refusal(
			staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: '<p class="wc-skip-link">x</p>' }),
		);
		expect(refused).toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ line: 1, column: 11, message: "There is no Class named wc-skip-link on this Site." }] },
		});
	});
});

describe("token utilities", () => {
	test("are named like Classes, show at once (the tokens are published), and only those used are sent", async () => {
		const { main, url } = await siteWith('<p class="p-m bg-primary-10 text-xl">{{ title }}</p>');

		expect(await main()).toBe('<p class="p-m bg-primary-10 text-xl">Fresh bread</p>');
		const { css } = await pageWithStyles(install, url);
		expect(layerOf(css, "utilities")).toBe(
			[
				".bg-primary-10{background-color:var(--primary-10)}",
				".p-m{padding:var(--space-m)}",
				".text-xl{font-size:var(--text-xl)}",
			].join("\n"),
		);
		expect(layerOf(css, "classes")).toBe("");
	});
});
