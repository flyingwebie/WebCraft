// The Design system's contrast Check (spec story 123, WCAG 1.4.3 and 1.4.11) and the preview the
// Design system screen shows beside what Staff edit: colour pairs below 4.5:1 for text, or 3:1 for
// large text and UI parts, are flagged in light and, with Dark mode on, in dark. Checks never stop a
// save. Expected ratios are the WCAG formula's for these greys (#767676 on white is the well-known
// 4.54:1; #777777 4.47:1, #949494 3.03:1, #5a5a5a on black 3.04:1).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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

type Draft = Awaited<ReturnType<TestBrowser["api"]["designSystem"]["get"]>>["designSystem"]["draft"];
type Result = Awaited<ReturnType<TestBrowser["api"]["designSystem"]["preview"]>>["preview"]["contrast"][number];

async function newSite() {
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `bakery-${++sites}` })).id;
	const { designSystem } = await staff.api.designSystem.get({ siteId });
	return { siteId, draft: designSystem.draft };
}

/** The tokens with a grey `brand` colour whose steps are set: white tint, `text` as step 95, #949494 as the base. */
function withBrand(draft: Draft, text: string, dark?: Record<string, string>) {
	return {
		...draft.tokens,
		colours: [
			...draft.tokens.colours,
			{
				name: "brand",
				light: { base: "#949494", steps: { "10": "#ffffff", "95": text } },
				dark: { base: null, steps: dark ?? {} },
			},
		],
	};
}

const brandPair = (results: readonly Result[], mode: string, role: string) =>
	results.find(
		(result) =>
			result.mode === mode &&
			result.foreground.name === "brand" &&
			result.sources.some((source) => source.kind === "ramp" && source.role === role),
	);

describe("each colour's ramp", () => {
	test("text on its tint needs 4.5:1: 4.47 is flagged, 4.54 passes", async () => {
		const { siteId, draft } = await newSite();
		const low = (await staff.api.designSystem.preview({ siteId, tokens: withBrand(draft, "#777777") })).preview;
		expect(brandPair(low.contrast, "light", "textOnTint")).toMatchObject({
			use: "text",
			foreground: { step: "95", value: "#777777" },
			background: { step: "10", value: "#ffffff" },
			ratio: 4.47,
			required: 4.5,
			passes: false,
		});
		const enough = (await staff.api.designSystem.preview({ siteId, tokens: withBrand(draft, "#767676") })).preview;
		expect(brandPair(enough.contrast, "light", "textOnTint")).toMatchObject({ ratio: 4.54, passes: true });
	});

	test("a label on the solid colour needs 4.5:1, the solid colour as a UI part on its tint 3:1", async () => {
		const { siteId, draft } = await newSite();
		const { preview } = await staff.api.designSystem.preview({ siteId, tokens: withBrand(draft, "#767676") });
		expect(brandPair(preview.contrast, "light", "labelOnSolid")).toMatchObject({
			use: "text",
			foreground: { step: "10" },
			background: { step: "60", value: "#949494" },
			ratio: 3.03,
			passes: false,
		});
		expect(
			preview.contrast.find(
				(result) =>
					result.foreground.name === "brand" &&
					result.foreground.step === "60" &&
					result.background.step === "10" &&
					result.mode === "light",
			),
		).toMatchObject({ use: "ui", required: 3, passes: true });
	});
});

describe("base styles and the focus style", () => {
	test("each element's text on its background; headings are large text; links take the body's background", async () => {
		const { siteId, draft } = await newSite();
		const { preview } = await staff.api.designSystem.preview({
			siteId,
			tokens: withBrand(draft, "#767676"),
			baseStyles: {
				...draft.baseStyles,
				body: "color: var(--brand-95); background-color: var(--brand-10);",
				h1: "color: var(--brand-60);",
				a: "color: var(--brand-60); text-underline-offset: 0.15em;",
			},
		});
		const fromBase = (target: string) =>
			preview.contrast.find((result) =>
				result.sources.some((source) => source.kind === "baseStyle" && source.target === target),
			);
		expect(fromBase("body")).toMatchObject({ ratio: 4.54, use: "text", passes: true });
		expect(fromBase("h1")).toMatchObject({ ratio: 3.03, use: "largeText", required: 3, passes: true });
		expect(fromBase("a")).toMatchObject({
			ratio: 3.03,
			use: "text",
			passes: false,
			background: { name: "brand", step: "10" },
		});
		expect(preview.contrast.find((result) => result.sources.some((source) => source.kind === "focus"))).toMatchObject({
			use: "ui",
			required: 3,
			foreground: { name: "primary", step: "70" },
			background: { name: "brand" },
		});
	});
});

describe("light and dark", () => {
	test("dark values are checked once Dark mode is on", async () => {
		const { siteId, draft } = await newSite();
		const tokens = withBrand(draft, "#767676", { "10": "#000000", "95": "#5a5a5a" });
		const off = (await staff.api.designSystem.preview({ siteId, tokens })).preview;
		expect(off.contrast.every((result) => result.mode === "light")).toBe(true);

		const on = (await staff.api.designSystem.preview({ siteId, tokens, darkMode: true })).preview;
		expect(brandPair(on.contrast, "dark", "textOnTint")).toMatchObject({
			foreground: { value: "#5a5a5a" },
			background: { value: "#000000" },
			ratio: 3.04,
			passes: false,
		});
		expect(brandPair(on.contrast, "light", "textOnTint")).toMatchObject({ passes: true });
	});

	test("the default Design system's own pairs: body text and links pass in light and dark", async () => {
		const { siteId } = await newSite();
		const { preview } = await staff.api.designSystem.preview({ siteId, darkMode: true });
		const base = preview.contrast.filter((result) => result.sources.some((source) => source.kind === "baseStyle"));
		expect(base.length).toBeGreaterThan(0);
		expect(base.filter((result) => !result.passes)).toEqual([]);
	});
});

describe("the preview", () => {
	test("shows the unsaved change and saves nothing; a Check never stops a save", async () => {
		const { siteId, draft } = await newSite();
		const tokens = withBrand(draft, "#777777");
		const { preview } = await staff.api.designSystem.preview({ siteId, tokens });
		expect(preview.stylesheet).toContain("--brand-95:#777777");
		expect((await staff.api.designSystem.get({ siteId })).designSystem.draft.tokens.colours).toHaveLength(4);

		await staff.api.designSystem.saveDraft({ siteId, tokens });
		expect((await staff.api.designSystem.get({ siteId })).designSystem.draft.tokens.colours).toHaveLength(5);
	});

	test("its stylesheet has every Class and the dark values; ramps show generated values beneath overrides", async () => {
		const { siteId, draft } = await newSite();
		await staff.api.designSystem.createClass({ siteId, name: "card", styles: "padding: var(--space-m);" });
		const { preview } = await staff.api.designSystem.preview({ siteId, tokens: withBrand(draft, "#777777") });

		expect(preview.stylesheet).toContain(".card{");
		expect(preview.stylesheet).toContain(":root[data-wc-theme=dark]");
		const brand = Object.values(preview.ramps).find((ramp) => ramp.light.shown["95"] === "#777777");
		expect(brand?.light.generated["95"]).not.toBe("#777777");
		expect(brand?.light.shown["60"]).toBe("#949494");
		expect(brand?.dark.shown["60"]).toBe("#949494");
		expect(preview.scales.space.find((step) => step.name === "m")).toMatchObject({
			size: { min: 16, max: 20 },
			custom: false,
		});
	});

	test("counts where each Class and token is used", async () => {
		const { siteId } = await newSite();
		// The default base styles use --space-m already (blockquotes and rules).
		const before = (await staff.api.designSystem.preview({ siteId })).preview.uses.tokens["space-m"] ?? 0;
		const { class: card } = await staff.api.designSystem.createClass({
			siteId,
			name: "card",
			styles: "padding: var(--space-m);",
		});
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<main class="card p-m"><div class="card">{{@outlet}}</div></main>',
		});
		const { preview } = await staff.api.designSystem.preview({ siteId });
		expect(preview.uses.classes[card.id]).toBe(2);
		// The card Class's CSS and the main element's utility.
		expect(preview.uses.tokens["space-m"]).toBe(before + 2);
	});

	test("refused as saving it would be, and only for Staff", async () => {
		const { siteId } = await newSite();
		await expect(
			staff.api.designSystem.preview({ siteId, customCss: "p { color: red !important; }" }),
		).rejects.toMatchObject({ code: "DESIGN_SYSTEM_INVALID" });
		const owner = await install.createMember({ workspaceId, role: "owner" });
		await expect(owner.browser.api.designSystem.preview({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
