// Design tokens (spec story 65): colours with generated shades, fluid spacing and type scales,
// fonts, radius, shadows, breakpoints and content widths, each a CSS custom property in the
// stylesheet's tokens layer. Any step can be given its own value, and tokens go out and come back
// as DTCG JSON.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
	const { designSystem } = await staff.api.designSystem.get({ siteId });
	return { siteId, url: `https://${slug}.live.test/`, tokens: designSystem.draft.tokens };
}

/** Tokens as a save takes them: a token without an id is new. */
type Tokens = NonNullable<Parameters<TestBrowser["api"]["designSystem"]["saveDraft"]>[0]["tokens"]>;

/** Saves `tokens`, publishes, and answers the published stylesheet's tokens layer. */
async function publishedTokens(site: { siteId: string; url: string }, tokens: Tokens): Promise<string> {
	await staff.api.designSystem.saveDraft({ siteId: site.siteId, tokens });
	await staff.api.designSystem.publish({ siteId: site.siteId });
	return layerOf((await pageWithStyles(install, site.url)).css, "tokens");
}

/** The value a custom property is set to in CSS text. */
function propertyValue(css: string, property: string): string {
	return new RegExp(`${property}:([^;]+);`).exec(css)?.[1] ?? "";
}

/** The relative luminance of `#rrggbb` (WCAG). */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((start) => {
		const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SHADES = ["10", "20", "30", "40", "50", "60", "70", "80", "90", "95"];

describe("colours", () => {
	test("each colour is one base colour: WebCraft makes its shades, lightest to darkest, and its transparencies", async () => {
		const site = await newSite();
		const css = await publishedTokens(site, {
			...site.tokens,
			colours: site.tokens.colours.map((colour) =>
				colour.name === "primary" ? { ...colour, light: { base: "#c2410c", steps: {} } } : colour,
			),
		});

		expect(propertyValue(css, "--primary-60")).toBe("#c2410c");
		const shades = SHADES.map((step) => propertyValue(css, `--primary-${step}`));
		expect(shades.every((shade) => /^#[0-9a-f]{6}$/.test(shade))).toBe(true);
		const lightness = shades.map(luminance);
		expect(lightness).toEqual([...lightness].sort((a, b) => b - a));
		expect(new Set(shades).size).toBe(SHADES.length);
		expect(propertyValue(css, "--primary-a50")).toBe("#c2410c80");
		expect(propertyValue(css, "--primary-a10")).toBe("#c2410c1a");
	});

	test("any shade can be given its own value, but 60 is the base colour itself", async () => {
		const site = await newSite();
		const withPeach = (steps: Record<string, string>) => ({
			...site.tokens,
			colours: site.tokens.colours.map((colour) =>
				colour.name === "primary" ? { ...colour, light: { base: colour.light.base, steps } } : colour,
			),
		});

		const css = await publishedTokens(site, withPeach({ "20": "#ffe4d6" }));
		expect(propertyValue(css, "--primary-20")).toBe("#ffe4d6");

		const refused = await staff.api.designSystem
			.saveDraft({ siteId: site.siteId, tokens: withPeach({ "60": "#000000" }) })
			.then(
				() => undefined,
				(error: { code: string; data: { problems: { at: string }[] } }) => error,
			);
		expect(refused?.code).toBe("DESIGN_SYSTEM_INVALID");
		expect(refused?.data.problems.map((problem) => problem.at)).toEqual(["tokens.colours[0].light.steps.60"]);
	});

	test("a new colour gets its own custom properties; names and values are checked", async () => {
		const site = await newSite();
		const css = await publishedTokens(site, {
			...site.tokens,
			colours: [
				...site.tokens.colours,
				{ name: "sage", light: { base: "#7c9a6b", steps: {} }, dark: { base: null, steps: {} } },
			],
		});
		expect(propertyValue(css, "--sage-60")).toBe("#7c9a6b");

		const refused = await staff.api.designSystem
			.saveDraft({
				siteId: site.siteId,
				tokens: {
					...site.tokens,
					colours: [
						...site.tokens.colours,
						{ name: "Sage Green", light: { base: "green", steps: {} }, dark: { base: null, steps: {} } },
						{ name: "wc-brand", light: { base: "#123456", steps: {} }, dark: { base: null, steps: {} } },
					],
				},
			})
			.then(
				() => undefined,
				(error: { data: { problems: { at: string; message: string }[] } }) => error.data.problems,
			);
		expect(refused).toEqual([
			{ at: "tokens.colours[4].name", message: expect.stringContaining("lower-case letters") },
			{ at: "tokens.colours[5].name", message: expect.stringContaining("WebCraft's") },
			{ at: "tokens.colours[4].light.base", message: "Give a colour as #rrggbb." },
		]);
	});
});

describe("fluid scales", () => {
	test("each step grows from its size at the smallest viewport to its size at the largest, written with clamp()", async () => {
		const site = await newSite();
		// Base 16 px at 360 px wide to 24 px at 1440 px wide; step m is the base itself.
		const css = await publishedTokens(site, {
			...site.tokens,
			space: { ...site.tokens.space, base: { min: 16, max: 24 } },
		});

		expect(propertyValue(css, "--space-m")).toBe("clamp(1rem, 0.8333rem + 0.7407vw, 1.5rem)");
		// One step up multiplies by the ratio, 1.5: 24 px to 36 px.
		expect(propertyValue(css, "--space-l")).toBe("clamp(1.5rem, 1.25rem + 1.1111vw, 2.25rem)");
	});

	test("any step can be given its own sizes", async () => {
		const site = await newSite();
		const css = await publishedTokens(site, {
			...site.tokens,
			text: {
				...site.tokens.text,
				steps: site.tokens.text.steps.map((step) =>
					step.name === "4xl" ? { ...step, size: { min: 40, max: 64 } } : step,
				),
			},
		});

		expect(propertyValue(css, "--text-4xl")).toBe("clamp(2.5rem, 2rem + 2.2222vw, 4rem)");
	});
});

describe("the other kinds of token", () => {
	test("fonts, radius, shadows and content widths are custom properties too", async () => {
		const site = await newSite();
		const css = await publishedTokens(site, {
			...site.tokens,
			fonts: [...site.tokens.fonts, { name: "display", family: ["Fraunces", "Iowan Old Style", "serif"] }],
			radius: [...site.tokens.radius, { name: "pill", value: { value: 2, unit: "rem" } }],
			shadows: [
				...site.tokens.shadows,
				{ name: "glow", layers: [{ offsetX: 0, offsetY: 0, blur: 12, spread: 2, color: "#c2410c66", inset: false }] },
			],
			widths: [...site.tokens.widths, { name: "prose", value: { value: 65, unit: "rem" } }],
		});

		expect(propertyValue(css, "--font-display")).toBe("Fraunces,Iowan Old Style,serif");
		expect(propertyValue(css, "--radius-pill")).toBe("2rem");
		expect(propertyValue(css, "--shadow-glow")).toBe("0 0 12px 2px #c2410c66");
		expect(propertyValue(css, "--width-prose")).toBe("65rem");
	});

	test("the focus style every page has is drawn from tokens", async () => {
		const site = await newSite();
		const accent = site.tokens.colours.find((colour) => colour.name === "accent");
		await publishedTokens(site, {
			...site.tokens,
			focus: { colour: { colour: accent?.id ?? "", step: "80" }, width: 3, offset: 1 },
		});

		const base = layerOf((await pageWithStyles(install, site.url)).css, "base");
		expect(base).toContain(":root{--wc-focus-color:var(--accent-80);--wc-focus-width:3px;--wc-focus-offset:1px;}");
	});
});

describe("DTCG JSON", () => {
	test("exports every value with its DTCG type, and WebCraft's own details in $extensions", async () => {
		const site = await newSite();

		const { tokens } = await staff.api.designSystem.exportTokens({ siteId: site.siteId });

		// The file as another tool reads it: plain JSON.
		const file = JSON.parse(JSON.stringify(tokens));
		expect(file.color?.$type).toBe("color");
		expect(file.color?.primary?.["60"]).toEqual({
			$value: { colorSpace: "srgb", components: [0.1451, 0.3882, 0.9216], hex: "#2563eb" },
		});
		expect(file.color?.primary?.a50).toMatchObject({ $value: { hex: "#2563eb", alpha: 0.502 } });
		expect(file.space?.$type).toBe("dimension");
		expect(file.space?.m).toEqual({
			$value: { value: 16, unit: "px" },
			$extensions: { webcraft: { id: "space-m", exponent: 0, fluid: { min: 16, max: 20 }, fixed: false } },
		});
		expect(file.font?.body).toMatchObject({ $value: expect.arrayContaining(["system-ui", "sans-serif"]) });
		expect(file.radius?.m).toMatchObject({ $value: { value: 8, unit: "px" } });
		expect(file.shadow?.$type).toBe("shadow");
		expect(file.breakpoint?.md).toMatchObject({ $value: { value: 768, unit: "px" } });
		expect(file.width?.content).toMatchObject({ $value: { value: 72, unit: "rem" } });
		expect(file.focus?.color).toEqual({ $type: "color", $value: "{color.primary.70}" });
	});

	test("importing an export gives back the same tokens, and their uses stay linked", async () => {
		const site = await newSite();
		const { class: card } = await staff.api.designSystem.createClass({
			siteId: site.siteId,
			name: "card",
			styles: "padding: var(--space-m); color: var(--primary-80);",
		});
		const { tokens } = await staff.api.designSystem.exportTokens({ siteId: site.siteId });

		const { designSystem } = await staff.api.designSystem.importTokens({ siteId: site.siteId, tokens });

		expect(designSystem.draft.tokens).toEqual(site.tokens);
		expect(designSystem.draft.classes.find((each) => each.id === card.id)?.styles).toBe(
			"padding: var(--space-m); color: var(--primary-80);",
		);
	});

	test("imports tokens from another tool: each group it holds replaces that kind, the rest stay", async () => {
		const site = await newSite();
		// The default base styles use the default colours: this Site has none.
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, baseStyles: {} });
		const file = {
			color: {
				brand: { $type: "color", $value: "#0f766e" },
				ink: { $type: "color", $value: { colorSpace: "srgb", components: [0.1, 0.1, 0.12] } },
			},
			breakpoint: { tablet: { $type: "dimension", $value: "700px" }, desktop: { $value: { value: 75, unit: "rem" } } },
			focus: { color: { $type: "color", $value: "{color.brand.80}" } },
		};

		const { designSystem } = await staff.api.designSystem.importTokens({ siteId: site.siteId, tokens: file });
		const { tokens } = designSystem.draft;

		expect(tokens.colours.map((colour) => [colour.name, colour.light.base])).toEqual([
			["brand", "#0f766e"],
			["ink", "#1a1a1f"],
		]);
		expect(tokens.breakpoints.map((breakpoint) => [breakpoint.name, breakpoint.width])).toEqual([
			["tablet", 700],
			["desktop", 1200],
		]);
		expect(tokens.space).toEqual(site.tokens.space);
		expect(tokens.focus.colour).toEqual({ colour: tokens.colours[0]?.id ?? "", step: "80" });
	});

	test("a file that can't be read, or leaves out a token in use, is refused", async () => {
		const site = await newSite();
		const refusal = (tokens: Record<string, unknown>) =>
			staff.api.designSystem.importTokens({ siteId: site.siteId, tokens }).then(
				() => undefined,
				(error: { code: string; data: unknown }) => error,
			);

		expect(await refusal({ color: { brand: { $type: "color", $value: "teal" } } })).toMatchObject({
			code: "TOKENS_FILE_INVALID",
			data: { problems: [{ at: "color.brand" }] },
		});
		// The default base styles use the neutral colour, and the focus style the primary one.
		expect(await refusal({ color: { brand: { $value: "#0f766e" } } })).toMatchObject({ code: "TOKEN_IN_USE" });
	});
});
