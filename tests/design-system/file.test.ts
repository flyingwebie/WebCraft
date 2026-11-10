// The Design system file (spec story 63): a whole Design system as one versioned JSON file, exported
// from one Site and imported into another. Importing shows what will change first and replaces the
// Draft (never the published version) only with that preview's confirmation; files it can't read are
// refused with where; both are in the Audit log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { layerOf, pageWithStyles } from "../harness/site-styles.ts";
import { goLive } from "../harness/staging.ts";

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

async function newSite() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	return { siteId, url: `https://${slug}.live.test/` };
}

/** A Site whose Draft has a brand colour, a Class with a breakpoint style, a base style and custom CSS. */
async function styledSite() {
	const site = await newSite();
	const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
	const tokens = designSystem.draft.tokens;
	await staff.api.designSystem.saveDraft({
		siteId: site.siteId,
		darkMode: true,
		tokens: {
			...tokens,
			colours: [...tokens.colours, { name: "brand", light: { base: "#c2410c", steps: {} } }],
		},
		customCss: ".notice { color: var(--brand-70); }",
		baseStyles: { ...designSystem.draft.baseStyles, h1: "color: var(--brand-80);" },
	});
	const lg = tokens.breakpoints.find((each) => each.name === "lg")?.id ?? "";
	await staff.api.designSystem.createClass({
		siteId: site.siteId,
		name: "card",
		styles: "padding: var(--space-m);",
		breakpoints: { [lg]: "padding: var(--space-l);" },
		css: "& h2 { color: var(--brand-70); }",
	});
	return site;
}

describe("exporting", () => {
	test("the file holds Dark mode, the tokens as DTCG, every Class with its CSS by breakpoint name, base styles and custom CSS", async () => {
		const { siteId } = await styledSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId });

		expect(file).toMatchObject({
			format: "webcraft-design-system",
			version: 1,
			darkMode: true,
			customCss: ".notice { color: var(--brand-70); }",
			classes: [
				{
					name: "card",
					styles: "padding: var(--space-m);",
					breakpoints: { lg: "padding: var(--space-l);" },
					css: "& h2 { color: var(--brand-70); }",
				},
			],
		});
		expect(file.baseStyles.h1).toBe("color: var(--brand-80);");
		expect(file.tokens).toMatchObject({ color: { brand: { "60": { $value: { hex: "#c2410c" } } } } });
	});

	test("the published version is the default one until the Design system is published", async () => {
		const { siteId } = await styledSite();
		expect((await staff.api.designSystem.exportFile({ siteId, version: "published" })).file).toMatchObject({
			darkMode: false,
			classes: [],
		});
		await staff.api.designSystem.publish({ siteId });
		expect((await staff.api.designSystem.exportFile({ siteId, version: "published" })).file).toMatchObject({
			darkMode: true,
			classes: [{ name: "card" }],
		});
	});
});

describe("importing", () => {
	test("the first call shows what will change and changes nothing; confirming replaces the Draft, not what visitors see", async () => {
		const from = await styledSite();
		const into = await newSite();
		await staff.api.designSystem.publish({ siteId: into.siteId });
		const before = layerOf((await pageWithStyles(install, into.url)).css, "tokens");
		const { file } = await staff.api.designSystem.exportFile({ siteId: from.siteId });

		const asked = await staff.api.designSystem.importFile({ siteId: into.siteId, file });
		if (!("confirmation" in asked)) throw new Error("The first call should ask for a confirmation.");
		expect(asked.preview.changes).toMatchObject({
			tokens: [{ kind: "colours", added: ["brand"], removed: [], changed: [] }],
			classes: { added: ["card"], removed: [], changed: [] },
			baseStyles: ["h1"],
			customCss: true,
			darkMode: { from: false, to: true },
		});
		expect((await staff.api.designSystem.get({ siteId: into.siteId })).designSystem.draft.classes).toEqual([]);

		const done = await staff.api.designSystem.importFile({
			siteId: into.siteId,
			file,
			confirmation: asked.confirmation.id,
		});
		if (!("designSystem" in done)) throw new Error("The second call should import.");
		const { designSystem } = await staff.api.designSystem.get({ siteId: into.siteId });
		expect(designSystem.status).toBe("changed");
		expect(designSystem.draft.darkMode).toBe(true);
		expect(designSystem.draft.customCss).toBe(".notice { color: var(--brand-70); }");
		const lg = designSystem.draft.tokens.breakpoints.find((each) => each.name === "lg")?.id ?? "";
		expect(designSystem.draft.classes).toMatchObject([
			{ name: "card", styles: "padding: var(--space-m);", breakpoints: { [lg]: "padding: var(--space-l);" } },
		]);
		// Visitors see nothing of it until the Design system is published.
		expect(layerOf((await pageWithStyles(install, into.url)).css, "tokens")).toBe(before);
	});

	test("a confirmation works once, and not after the Draft changed", async () => {
		const from = await styledSite();
		const into = await newSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId: from.siteId });
		const asked = await staff.api.designSystem.importFile({ siteId: into.siteId, file });
		if (!("confirmation" in asked)) throw new Error("expected a confirmation");
		await staff.api.designSystem.saveDraft({ siteId: into.siteId, customCss: "p { margin: 0; }" });

		await expect(
			staff.api.designSystem.importFile({ siteId: into.siteId, file, confirmation: asked.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });
		expect((await staff.api.designSystem.get({ siteId: into.siteId })).designSystem.draft.customCss).toBe(
			"p { margin: 0; }",
		);
	});

	test("Classes and tokens keep their ids by name, so elements using them stay linked", async () => {
		const site = await styledSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId: site.siteId });
		const before = (await staff.api.designSystem.get({ siteId: site.siteId })).designSystem.draft;
		const changed = {
			...file,
			classes: file.classes.map((each) => ({ ...each, styles: "padding: var(--space-s);" })),
		};

		const asked = await staff.api.designSystem.importFile({ siteId: site.siteId, file: changed });
		if (!("confirmation" in asked)) throw new Error("expected a confirmation");
		expect(asked.preview.changes).toMatchObject({
			tokens: [],
			classes: { added: [], removed: [], changed: ["card"] },
			customCss: false,
			darkMode: null,
		});
		await staff.api.designSystem.importFile({
			siteId: site.siteId,
			file: changed,
			confirmation: asked.confirmation.id,
		});
		const after = (await staff.api.designSystem.get({ siteId: site.siteId })).designSystem.draft;
		expect(after.classes.map((each) => each.id)).toEqual(before.classes.map((each) => each.id));
		expect(after.tokens.colours.map((each) => each.id)).toEqual(before.tokens.colours.map((each) => each.id));
	});

	test("leaving out a Class an element uses is refused with where it is used", async () => {
		const site = await styledSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId: site.siteId });
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: '<main class="card">{{@outlet}}</main>',
		});

		await expect(
			staff.api.designSystem.importFile({ siteId: site.siteId, file: { ...file, classes: [] } }),
		).rejects.toMatchObject({ code: "CLASS_IN_USE" });
	});

	test("both are recorded in the Audit log", async () => {
		const from = await styledSite();
		const into = await newSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId: from.siteId });
		const asked = await staff.api.designSystem.importFile({ siteId: into.siteId, file });
		if (!("confirmation" in asked)) throw new Error("expected a confirmation");
		await staff.api.designSystem.importFile({ siteId: into.siteId, file, confirmation: asked.confirmation.id });

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(
			entries.find((entry) => entry.action === "designSystem.export" && entry.siteId === from.siteId),
		).toMatchObject({ details: { version: "draft" } });
		expect(
			entries.find((entry) => entry.action === "designSystem.import" && entry.siteId === into.siteId),
		).toMatchObject({ details: { classes: { added: ["card"] }, darkMode: { from: false, to: true } } });
		expect(entries.some((entry) => entry.action === "designSystem.import" && entry.siteId === from.siteId)).toBe(false);
	});

	test("API clients import in the same two steps", async () => {
		const from = await styledSite();
		const into = await newSite();
		const { secret } = await createApiToken(staff, { workspaceId, name: "Deploy" });
		const script = tokenClient(install, secret);
		const { file } = await script.api.designSystem.exportFile({ siteId: from.siteId });
		const asked = await script.api.designSystem.importFile({ siteId: into.siteId, file });
		if (!("confirmation" in asked)) throw new Error("expected a confirmation");
		await script.api.designSystem.importFile({ siteId: into.siteId, file, confirmation: asked.confirmation.id });

		expect((await staff.api.designSystem.get({ siteId: into.siteId })).designSystem.draft.darkMode).toBe(true);
	});
});

describe("files it refuses", () => {
	const refusal = async (file: Record<string, unknown>) => {
		const { siteId } = await newSite();
		try {
			await staff.api.designSystem.importFile({ siteId, file });
		} catch (error) {
			return error as { code: string; data: { problems: { at: string; message: string }[] } };
		}
		throw new Error("The file should be refused.");
	};

	test("a file that isn't a Design system file", async () => {
		const error = await refusal({ color: { brand: { $value: "#c2410c" } } });
		expect(error.code).toBe("DESIGN_SYSTEM_FILE_INVALID");
		expect(error.data.problems).toEqual([{ at: "format", message: expect.stringContaining("Design system file") }]);
	});

	test("a version a newer WebCraft wrote", async () => {
		const { siteId } = await newSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId });
		const error = await refusal({ ...file, version: 2 });
		expect(error.data.problems).toEqual([{ at: "version", message: expect.stringContaining("newer WebCraft") }]);
	});

	test("every broken part, each with where it is", async () => {
		const { siteId } = await newSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId });
		const error = await refusal({
			...file,
			darkMode: "yes",
			classes: [{ name: "card", breakpoints: { tablet: "padding: 0;" } }, { styles: "color: red;" }],
			baseStyles: { marquee: "color: red;" },
		});
		expect(error.code).toBe("DESIGN_SYSTEM_FILE_INVALID");
		expect(error.data.problems.map((problem) => problem.at).sort()).toEqual([
			"baseStyles.marquee",
			"classes[0].breakpoints.tablet",
			"classes[1].name",
			"darkMode",
		]);
	});

	test("CSS the Design system can't hold is refused like any save, with where", async () => {
		const { siteId } = await newSite();
		const { file } = await staff.api.designSystem.exportFile({ siteId });
		await expect(
			staff.api.designSystem.importFile({
				siteId,
				file: { ...file, classes: [{ name: "card", styles: "color: red !important;" }] },
			}),
		).rejects.toMatchObject({ code: "DESIGN_SYSTEM_INVALID", data: { problems: [{ at: "classes[0].styles" }] } });
	});
});

describe("who may", () => {
	test("only Staff: Members can neither export nor import", async () => {
		const { siteId } = await newSite();
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { file } = await staff.api.designSystem.exportFile({ siteId });
		await expect(owner.browser.api.designSystem.exportFile({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.browser.api.designSystem.importFile({ siteId, file })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
