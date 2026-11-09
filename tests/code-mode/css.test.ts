// Code mode's CSS panel (ADR 0016): the selected element's Class (its styles for every width, each
// breakpoint's, and its own CSS) or the Site CSS, read and saved through the Design system's Draft
// and its CSS checks, with the design-token variables to suggest. The page previews unsaved CSS;
// saving names the version it was opened at, as the HTML panel's saves do. An unknown Class name in
// the HTML panel can be made a Class of the Draft from there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { answer, openCodeMode } from "../harness/code-mode.ts";
import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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

describe("reading an element's CSS", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	let coding: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		coding = await openCodeMode(install, staff, site.siteId, path);
	});

	test("answers the element's Classes with each piece of their CSS, the breakpoints and the Site CSS", async () => {
		const css = await answer<Css>(coding.edit("code/css", { path, ref: "content#title" }));

		expect(css.classes).toEqual([
			{
				id: site.classId,
				name: "title",
				generated: false,
				styles: "font-size: var(--text-xl);",
				breakpoints: { [site.tablet.id]: "font-size: var(--text-2xl);" },
				css: "&:hover {\n  color: red;\n}",
				version: expect.stringMatching(/^[0-9a-f]{16}$/),
			},
		]);
		expect(css.breakpoints[0]).toEqual({ id: site.tablet.id, name: site.tablet.name, width: site.tablet.width });
		expect(css.siteCss).toEqual({ css: "", version: expect.stringMatching(/^[0-9a-f]{16}$/) });
	});

	test("suggests the design tokens' custom properties with their values", async () => {
		const css = await answer<Css>(coding.edit("code/css", { path, ref: "content#title" }));

		expect(css.tokens).toContainEqual({ property: "--space-m", value: expect.any(String), kind: "space" });
		expect(css.tokens).toContainEqual({ property: "--text-xl", value: expect.any(String), kind: "text" });
		expect(css.tokens.some((token) => token.kind === "colour" && token.property.endsWith("-60"))).toBe(true);
	});

	test("an element without Classes, or none selected, has the Site CSS only", async () => {
		const css = await answer<Css>(coding.edit("code/css", { path, ref: "content#article" }));
		expect(css.classes).toEqual([]);
		const none = await answer<Css>(coding.edit("code/css", { path, ref: null }));
		expect(none.classes).toEqual([]);
		expect(none.siteCss.css).toBe("");
	});
});

describe("saving CSS", () => {
	test("saves one piece of a Class to the Design system's Draft: the page in Code mode shows it, visitors don't yet", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const before = await answer<Css>(coding.edit("code/css", { path, ref: "content#title" }));

		const saved = await answer<{ text: string; version: string }>(
			coding.edit("code/saveCss", {
				target: { kind: "class", classId: site.classId, part: "styles" },
				text: "font-size: var(--text-xl);\ncolor: darkgreen;",
				version: before.classes[0]?.version,
			}),
		);
		expect(saved.text).toBe("font-size: var(--text-xl);\ncolor: darkgreen;");

		await answer(
			coding.edit("code/saveCss", {
				target: { kind: "class", classId: site.classId, part: "breakpoint", breakpointId: site.tablet.id },
				text: "font-size: var(--text-3xl);",
				version: saved.version,
			}),
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
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const before = await answer<Css>(coding.edit("code/css", { path, ref: null }));

		await answer(
			coding.edit("code/saveCss", {
				target: { kind: "site" },
				text: "body {\n  margin: 0;\n}",
				version: before.siteCss.version,
			}),
		);

		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.customCss).toBe("body {\n  margin: 0;\n}");
	});

	test("refuses CSS the Design system's checks refuse, with where, saving nothing", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const before = await answer<Css>(coding.edit("code/css", { path, ref: "content#title" }));

		const refused = await refusal(
			await coding.edit("code/saveCss", {
				target: { kind: "class", classId: site.classId, part: "styles" },
				text: "color: red;\nbackground: url(https://elsewhere.example/a.png);",
				version: before.classes[0]?.version,
			}),
			400,
		);

		expect(refused.code).toBe("DESIGN_SYSTEM_INVALID");
		expect(refused.data?.problems?.[0]).toMatchObject({ line: 2 });
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.find((each) => each.id === site.classId)?.styles).toBe(
			"font-size: var(--text-xl);",
		);
	});

	test("a save over a Class or the Site CSS someone changed meanwhile is refused with the newer version", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const before = await answer<Css>(coding.edit("code/css", { path, ref: "content#title" }));
		await otherStaff.api.designSystem.updateClass({
			siteId: site.siteId,
			classId: site.classId,
			styles: "color: navy;",
		});
		await otherStaff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "p { margin: 0; }" });

		const classSave = await refusal(
			await coding.edit("code/saveCss", {
				target: { kind: "class", classId: site.classId, part: "styles" },
				text: "color: teal;",
				version: before.classes[0]?.version,
			}),
			409,
		);
		expect(classSave.code).toBe("CHANGED_MEANWHILE");
		const now = await answer<Css>(coding.edit("code/css", { path, ref: "content#title" }));
		expect(classSave.data?.version).toBe(now.classes[0]?.version);

		const siteSave = await coding.edit("code/saveCss", {
			target: { kind: "site" },
			text: "p { padding: 0; }",
			version: before.siteCss.version,
		});
		expect((await refusal(siteSave, 409)).code).toBe("CHANGED_MEANWHILE");

		// Overwriting saves over the newer version.
		await answer(
			coding.edit("code/saveCss", {
				target: { kind: "class", classId: site.classId, part: "styles" },
				text: "color: teal;",
				version: classSave.data?.version,
			}),
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

test("Members in Edit mode can't read or change CSS", async () => {
	const site = await bakery();
	const editing = await openEditMode(install, editor, site.siteId, path);

	for (const [action, body] of [
		["code/css", { path, ref: "content#title" }],
		["code/saveCss", { target: { kind: "site" }, text: "", version: null }],
		["code/createClass", { name: "sneaky" }],
	] as const) {
		expect((await refusal(await editing.edit(action, body), 403)).code).toBe("FORBIDDEN");
	}
});
