// The CSS panel on the Builder canvas (ADR 0035: one editor, two canvases): the same per-Class CSS
// as Code mode's, read by the Classes the element has now (in its order, token utilities left out)
// with how widely each is used, and saved piece by piece to the Design system's Draft based on the
// version it was read at.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let otherStaff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

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

let sites = 0;

/** A Site whose Card Component has an element with two Classes and a token utility. */
async function bakery() {
	const siteId = (await install.createSite(workspaceId, { slug: `bakery-${++sites}` })).id;
	const card = await staff.api.designSystem.createClass({ siteId, name: "card", styles: "padding: var(--space-m);" });
	const lead = await staff.api.designSystem.createClass({ siteId, name: "lead", css: "&:hover {\n  color: red;\n}" });
	const { component } = await staff.api.components.create({ siteId, name: "Card" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<div class="lead p-m card">Hi</div>',
	});
	const opened = await staff.api.builder.open({ siteId, target: { kind: "component", componentId: component.id } });
	const classes = (opened.tree.nodes[0] as { classes: string[] }).classes;
	return { siteId, classes, cardId: card.class.id, leadId: lead.class.id };
}

describe("reading", () => {
	test("answers the Classes by id in the element's order, with their uses, the breakpoints, the Site CSS and the tokens", async () => {
		const site = await bakery();

		const css = await staff.api.builder.css({ siteId: site.siteId, classes: site.classes });

		expect(css.classes.map((each) => [each.id, each.name, each.css, each.usage])).toEqual([
			[site.leadId, "lead", "&:hover {\n  color: red;\n}", { elements: 1, pages: 0 }],
			[site.cardId, "card", "", { elements: 1, pages: 0 }],
		]);
		expect(css.breakpoints.length).toBeGreaterThan(0);
		expect(css.siteCss).toEqual({ css: "", version: expect.stringMatching(/^[0-9a-f]{16}$/) });
		expect(css.tokens).toContainEqual({ property: "--space-m", value: expect.any(String), kind: "space" });
	});
});

describe("saving", () => {
	test("saves one piece of a Class based on its version, and refuses a stale one with the newer version", async () => {
		const site = await bakery();
		const before = await staff.api.builder.css({ siteId: site.siteId, classes: [site.cardId] });
		const version = before.classes[0]?.version ?? null;

		const saved = await staff.api.builder.saveCss({
			siteId: site.siteId,
			target: { kind: "class", classId: site.cardId, part: "styles" },
			text: "padding: var(--space-l);",
			version,
		});
		expect(saved.text).toBe("padding: var(--space-l);");

		const stale = staff.api.builder.saveCss({
			siteId: site.siteId,
			target: { kind: "site" },
			text: "p { margin: 0; }",
			version: "0000000000000000",
		});
		await expect(stale).rejects.toMatchObject({ code: "CHANGED_MEANWHILE" });
		const { designSystem } = await otherStaff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.find((each) => each.id === site.cardId)?.styles).toBe("padding: var(--space-l);");
		expect(designSystem.draft.customCss).toBe("");
	});

	test("refuses CSS the Design system's checks refuse, such as a cascade layer", async () => {
		const site = await bakery();
		const { siteCss } = await staff.api.builder.css({ siteId: site.siteId, classes: [] });

		const refused = staff.api.builder.saveCss({
			siteId: site.siteId,
			target: { kind: "site" },
			text: "@layer custom {\n  p { margin: 0; }\n}",
			version: siteCss.version,
		});

		await expect(refused).rejects.toMatchObject({ code: "DESIGN_SYSTEM_INVALID" });
	});
});

test("Members can't read or save the CSS", async () => {
	const site = await bakery();
	await expect(editor.api.builder.css({ siteId: site.siteId, classes: site.classes })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(
		editor.api.builder.saveCss({ siteId: site.siteId, target: { kind: "site" }, text: "", version: null }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
