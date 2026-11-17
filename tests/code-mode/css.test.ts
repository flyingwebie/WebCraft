// The CSS the building area's CSS pane and Styles place work on (ADR 0037; Code mode's CSS panel
// before it, ADR 0016): a Class (its styles for every width, each breakpoint's, and its own CSS) or
// the Site CSS, read and saved through the Design system's Draft and its CSS checks (`builder.css`,
// `builder.saveCss`), with the design-token variables to suggest. The frame previews unsaved CSS
// (`code/preview`); saving names the version it was opened at, as the HTML pane's saves do. An unknown
// Class name in the HTML pane can be made a Class of the Draft from there (`code/createClass`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { answer, openCodeMode } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let otherStaff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	otherStaff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

type CodeClass = {
	id: string;
	name: string;
	generated: boolean;
	styles: string;
	breakpoints: Record<string, string>;
	css: string;
	version: string;
	usage: { elements: number; pages: number };
};
type Css = {
	classes: CodeClass[];
	breakpoints: { id: string; name: string; width: number }[];
	siteCss: { css: string; version: string };
	tokens: { property: string; value: string; kind: string }[];
};
type Refusal = {
	code: string;
	data?: { problems?: { at: string; line?: number; column?: number }[]; version?: string };
};

let sites = 0;

/** A Site whose Blog post's title has a Class with styles, a breakpoint's styles and its own CSS, and a token utility. */
async function bakery() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { designSystem } = await staff.api.designSystem.get({ siteId });
	const tablet = designSystem.draft.tokens.breakpoints[0];
	if (!tablet) throw new Error("The default Design system has no breakpoint.");
	const made = await staff.api.designSystem.createClass({
		siteId,
		name: "title",
		styles: "font-size: var(--text-xl);",
		breakpoints: { [tablet.id]: "font-size: var(--text-2xl);" },
		css: "&:hover {\n  color: red;\n}",
	});
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<article data-wc-id="article"><h1 class="title p-m" data-wc-id="title">{{ title }}</h1></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	await staff.api.designSystem.publish({ siteId });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, slug, postTypeId: postType.id, classId: made.class.id, tablet };
}

async function refusal(response: Response, status: number): Promise<Refusal> {
	expect(response.status).toBe(status);
	return (await response.json()) as Refusal;
}

/** The CSS of the Classes `classes` (by id) and the Site CSS, as the CSS pane and the Styles place read it. */
function readCss(siteId: string, classes: string[] = [], as: TestBrowser = staff): Promise<Css> {
	return as.api.builder.css({ siteId, classes }) as Promise<Css>;
}

type CssTarget =
	| { kind: "site" }
	| { kind: "class"; classId: string; part: "styles" | "css" }
	| { kind: "class"; classId: string; part: "breakpoint"; breakpointId: string };

/** Saves a piece of CSS as the CSS pane does; a refusal answers its code, status and data. */
async function saveCss(
	siteId: string,
	target: CssTarget,
	text: string,
	version: string | null | undefined,
): Promise<{ text: string; version: string } | { refused: Refusal & { status: number } }> {
	try {
		return await staff.api.builder.saveCss({ siteId, target, text, version: version ?? null });
	} catch (error) {
		const { code, status, data } = error as { code: string; status: number; data?: Refusal["data"] };
		return { refused: { code, status, data } };
	}
}

function saved(answer: Awaited<ReturnType<typeof saveCss>>): { text: string; version: string } {
	if ("refused" in answer) throw new Error(`Refused: ${JSON.stringify(answer.refused)}`);
	return answer;
}

function refused(answer: Awaited<ReturnType<typeof saveCss>>): Refusal & { status: number } {
	if (!("refused" in answer)) throw new Error("Saved, though a refusal was expected.");
	return answer.refused;
}

describe("reading a Class's CSS", () => {
	let site: Awaited<ReturnType<typeof bakery>>;

	beforeAll(async () => {
		site = await bakery();
	});

	test("answers each Class with each piece of its CSS, the breakpoints and the Site CSS", async () => {
		const css = await readCss(site.siteId, [site.classId]);

		expect(css.classes).toEqual([
			{
				id: site.classId,
				name: "title",
				generated: false,
				styles: "font-size: var(--text-xl);",
				breakpoints: { [site.tablet.id]: "font-size: var(--text-2xl);" },
				css: "&:hover {\n  color: red;\n}",
				version: expect.stringMatching(/^[0-9a-f]{16}$/),
				usage: { elements: 1, pages: 1 },
			},
		]);
		expect(css.breakpoints[0]).toEqual({ id: site.tablet.id, name: site.tablet.name, width: site.tablet.width });
		expect(css.siteCss).toEqual({ css: "", version: expect.stringMatching(/^[0-9a-f]{16}$/) });
	});

	test("suggests the design tokens' custom properties with their values", async () => {
		const css = await readCss(site.siteId, [site.classId]);

		expect(css.tokens).toContainEqual({ property: "--space-m", value: expect.any(String), kind: "space" });
		expect(css.tokens).toContainEqual({ property: "--text-xl", value: expect.any(String), kind: "text" });
		expect(css.tokens.some((token) => token.kind === "colour" && token.property.endsWith("-60"))).toBe(true);
	});

	test("answers the Classes asked for by id in their order, with how many elements and pages use each", async () => {
		const unused = await staff.api.designSystem.createClass({ siteId: site.siteId, name: "unused" });
		const opened = await staff.api.builder.open({
			siteId: site.siteId,
			target: { kind: "entryTemplate", postTypeId: site.postTypeId },
		});
		// The heading's token utility (`p-m`), by the id its tree gives it.
		const utility = JSON.stringify(opened.tree).match(/"(u:[^"]+)"/)?.[1];
		expect(utility).toBeDefined();

		const css = await readCss(site.siteId, [unused.class.id, utility ?? "", "missing", site.classId]);

		expect(css.classes.map((each) => [each.name, each.usage])).toEqual([
			["unused", { elements: 0, pages: 0 }],
			["title", { elements: 1, pages: 1 }],
		]);
	});

	test("a Class used only inside a Component counts the pages that Component shows on", async () => {
		const site = await bakery();
		const badge = await staff.api.designSystem.createClass({ siteId: site.siteId, name: "badge" });
		const { component } = await staff.api.components.create({ siteId: site.siteId, name: "Badge" });
		await staff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: component.id,
			markup: '<span class="badge">New</span><span class="badge">Fresh</span>',
		});
		await staff.api.components.publish({ siteId: site.siteId, componentId: component.id });
		const layout = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><Badge /></header><main>{{@outlet}}</main>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: layout.template.id });
		const shown = await staff.api.components.get({ siteId: site.siteId, componentId: component.id });
		expect(shown.usage.pages).toBeGreaterThan(0);

		const css = await readCss(site.siteId, [badge.class.id]);

		expect(css.classes[0]?.usage).toEqual({ elements: 2, pages: shown.usage.pages });
	});

	test("no Class asked for: the Site CSS only", async () => {
		const none = await readCss(site.siteId, []);
		expect(none.classes).toEqual([]);
		expect(none.siteCss.css).toBe("");
	});
});

describe("saving CSS", () => {
	test("saves one piece of a Class to the Design system's Draft: Staff's frame shows it, visitors don't yet", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const before = await readCss(site.siteId, [site.classId]);

		const first = saved(
			await saveCss(
				site.siteId,
				{ kind: "class", classId: site.classId, part: "styles" },
				"font-size: var(--text-xl);\ncolor: darkgreen;",
				before.classes[0]?.version,
			),
		);
		expect(first.text).toBe("font-size: var(--text-xl);\ncolor: darkgreen;");

		saved(
			await saveCss(
				site.siteId,
				{ kind: "class", classId: site.classId, part: "breakpoint", breakpointId: site.tablet.id },
				"font-size: var(--text-3xl);",
				first.version,
			),
		);

		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		const title = designSystem.draft.classes.find((each) => each.id === site.classId);
		expect(title?.styles).toBe("font-size: var(--text-xl);\ncolor: darkgreen;");
		expect(title?.breakpoints).toEqual({ [site.tablet.id]: "font-size: var(--text-3xl);" });
		expect(title?.css).toBe("&:hover {\n  color: red;\n}");
		const page = await (await coding.page(path)).text();
		const href = /<link rel="stylesheet" href="(\/_webcraft\/edit\/css\/[^"]+)">/.exec(page)?.[1];
		expect(await (await coding.browser.request(`https://${site.slug}.sites.test${href}`)).text()).toContain(
			"darkgreen",
		);
		const visitor = await (await install.request(`https://${site.slug}.sites.test${path}`)).text();
		const published = /<link rel="stylesheet" href="([^"]+)">/.exec(visitor)?.[1];
		expect(await (await install.request(`https://${site.slug}.sites.test${published}`)).text()).not.toContain(
			"darkgreen",
		);
	});

	test("saves the Site CSS", async () => {
		const site = await bakery();
		const before = await readCss(site.siteId);

		saved(await saveCss(site.siteId, { kind: "site" }, "body {\n  margin: 0;\n}", before.siteCss.version));

		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.customCss).toBe("body {\n  margin: 0;\n}");
	});

	test("refuses CSS the Design system's checks refuse, with where, saving nothing", async () => {
		const site = await bakery();
		const before = await readCss(site.siteId, [site.classId]);

		const answer = refused(
			await saveCss(
				site.siteId,
				{ kind: "class", classId: site.classId, part: "styles" },
				"color: red;\nbackground: url(https://elsewhere.example/a.png);",
				before.classes[0]?.version,
			),
		);

		expect(answer.status).toBe(400);
		expect(answer.code).toBe("DESIGN_SYSTEM_INVALID");
		expect(answer.data?.problems?.[0]).toMatchObject({ line: 2 });
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.find((each) => each.id === site.classId)?.styles).toBe(
			"font-size: var(--text-xl);",
		);
	});

	test("a save over a Class or the Site CSS someone changed meanwhile is refused with the newer version", async () => {
		const site = await bakery();
		const before = await readCss(site.siteId, [site.classId]);
		await otherStaff.api.designSystem.updateClass({
			siteId: site.siteId,
			classId: site.classId,
			styles: "color: navy;",
		});
		await otherStaff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "p { margin: 0; }" });

		const classSave = refused(
			await saveCss(
				site.siteId,
				{ kind: "class", classId: site.classId, part: "styles" },
				"color: teal;",
				before.classes[0]?.version,
			),
		);
		expect(classSave.status).toBe(409);
		expect(classSave.code).toBe("CHANGED_MEANWHILE");
		const now = await readCss(site.siteId, [site.classId]);
		expect(classSave.data?.version).toBe(now.classes[0]?.version);

		const siteSave = refused(await saveCss(site.siteId, { kind: "site" }, "p { padding: 0; }", before.siteCss.version));
		expect(siteSave.code).toBe("CHANGED_MEANWHILE");

		// Overwriting saves over the newer version.
		saved(
			await saveCss(
				site.siteId,
				{ kind: "class", classId: site.classId, part: "styles" },
				"color: teal;",
				classSave.data?.version,
			),
		);
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.find((each) => each.id === site.classId)?.styles).toBe("color: teal;");
	});
});

describe("the preview of unsaved CSS", () => {
	test("answers the stylesheet with the CSS as typed, saving nothing", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);

		const preview = await answer<{ stylesheet: { css: string } }>(
			coding.edit("code/preview", {
				path,
				css: { target: { kind: "class", classId: site.classId, part: "styles" }, text: "color: olive;" },
			}),
		);

		expect(preview.stylesheet.css).toContain("olive");
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.find((each) => each.id === site.classId)?.styles).toBe(
			"font-size: var(--text-xl);",
		);
		const refused = await coding.edit("code/preview", {
			path,
			css: { target: { kind: "site" }, text: "body { color: red !important; }" },
		});
		expect((await refusal(refused, 400)).code).toBe("DESIGN_SYSTEM_INVALID");
	});
});

describe("making a Class from the HTML panel", () => {
	test("adds it to the Design system's Draft, so the markup naming it saves", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const opened = await answer<{ markup: string; version: string }>(
			coding.edit("code/open", { path, ref: "content" }),
		);
		const markup = opened.markup.replace('class="title p-m"', 'class="title promo"');
		const unknown = await coding.edit("code/save", { path, ref: "content", markup, version: opened.version });
		expect((await refusal(unknown, 400)).code).toBe("TEMPLATE_MARKUP_INVALID");

		const made = await answer<{ class: { name: string } }>(coding.edit("code/createClass", { name: "promo" }));
		expect(made.class.name).toBe("promo");

		await answer(coding.edit("code/save", { path, ref: "content", markup, version: opened.version }));
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.map((each) => each.name)).toContain("promo");
		const taken = await coding.edit("code/createClass", { name: "promo" });
		expect((await refusal(taken, 400)).code).toBe("DESIGN_SYSTEM_INVALID");
	});
});

test("Members can't read or change CSS, in Edit mode or through the API", async () => {
	const site = await bakery();
	const editing = await openEditMode(install, editor, site.siteId, path);

	expect((await refusal(await editing.edit("code/createClass", { name: "sneaky" }), 403)).code).toBe("FORBIDDEN");
	expect(await rejection(readCss(site.siteId, [site.classId], editor))).toMatchObject({ code: "FORBIDDEN" });
	expect(
		await rejection(
			editor.api.builder.saveCss({ siteId: site.siteId, target: { kind: "site" }, text: "", version: null }),
		),
	).toMatchObject({ code: "FORBIDDEN" });
});

describe("a Generated Class in the CSS pane", () => {
	/** A Site whose Blog post's title has a one-off style, which made it a Generated Class. */
	async function generated() {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const opened = await answer<{ markup: string; version: string }>(
			coding.edit("code/open", { path, ref: "content" }),
		);
		await answer(
			coding.edit("code/save", {
				path,
				ref: "content",
				markup: opened.markup.replace('class="title p-m"', 'class="title p-m" style="color: olive"'),
				version: opened.version,
			}),
		);
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		const id = designSystem.draft.classes.find((each) => each.generated)?.id;
		const made = (await readCss(site.siteId, id ? [id] : [])).classes.find((each) => each.generated);
		if (!made) throw new Error("The one-off style made no Generated Class.");
		return { ...site, coding, made };
	}

	test("editing it makes it a normal Class that keeps its name", async () => {
		const { siteId, made } = await generated();

		saved(
			await saveCss(
				siteId,
				{ kind: "class", classId: made.id, part: "styles" },
				"color: olive;\nfont-weight: 700;",
				made.version,
			),
		);

		const css = await readCss(siteId, [made.id]);
		expect(css.classes[0]).toMatchObject({ name: made.name, generated: false });
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		expect(designSystem.draft.classes.find((each) => each.id === made.id)?.generated).toBe(false);
	});

	test("can be renamed from the panel, and the element keeps it", async () => {
		const { siteId, coding, made } = await generated();

		await answer(
			coding.edit("code/editorService", { method: "classes.update", input: { classId: made.id, name: "headline" } }),
		);

		const css = await readCss(siteId, [made.id]);
		expect(css.classes.map((each) => [each.name, each.generated])).toContainEqual(["headline", false]);
		const opened = await answer<{ markup: string }>(coding.edit("code/open", { path, ref: "content" }));
		expect(opened.markup).toContain('class="title p-m headline"');
	});
});
