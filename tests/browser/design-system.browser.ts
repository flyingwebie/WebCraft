// The Design system screen in a browser: axe and keyboard checks in light and dark for each tab (the
// colour ramps and their Light/Dark switch, the scales, the contrast Check, the Class list and its
// style panel, base styles and custom CSS) and the Import dialog and Export menu; the switch shows the
// dark values from the keyboard, and the style panel offers Design tokens first and saves by itself.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

/**
 * The previews show Staff's own Design system, which the contrast Check on the screen looks at, and
 * run no script: axe leaves them out, as it leaves out the visual builder's canvas.
 */
const PREVIEWS = { exclude: ["iframe[data-design-preview]"] };

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let cardId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	const admin = await local.superadmin();
	const { designSystem } = await admin.api.designSystem.get({ siteId });
	const md = designSystem.draft.tokens.breakpoints.find((each) => each.name === "md")?.id ?? "";
	await admin.api.designSystem.saveDraft({
		siteId,
		darkMode: true,
		tokens: {
			...designSystem.draft.tokens,
			colours: designSystem.draft.tokens.colours.map((colour) =>
				colour.name === "secondary" ? { ...colour, light: { base: colour.light.base, steps: { "70": "#0f766e" } } } : colour,
			),
		},
	});
	cardId = (
		await admin.api.designSystem.createClass({
			siteId,
			name: "card",
			styles: "padding: var(--space-m); border-radius: var(--radius-m);",
			breakpoints: { [md]: "padding: var(--space-l);" },
			css: "& h2 { color: var(--primary-70); }",
		})
	).class.id;
	await admin.api.designSystem.createClass({ siteId, name: "hero", styles: "padding-block: var(--space-2xl);" });
});

afterAll(async () => {
	await install.close();
});

async function open(page: Page, path: string): Promise<void> {
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

/** The colour theme a preview frame shows. */
function previewTheme(page: Page, title: string) {
	return page.evaluate(
		(name) =>
			(document.querySelector(`iframe[title="${name}"]`) as HTMLIFrameElement | null)?.contentDocument?.documentElement.getAttribute(
				"data-wc-theme",
			),
		title,
	);
}

for (const theme of THEMES) {
	describe(`the Design system screen, ${theme}`, () => {
		test("Tokens: the colour ramps, the scales and the contrast Check", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/design-system`);
			await page.getByRole("heading", { level: 1, name: "Design system" }).waitFor();
			await page.getByRole("heading", { level: 2, name: "Colours" }).waitFor();
			await page.getByRole("heading", { level: 2, name: "Contrast" }).waitFor();
			await expectAccessibleScreen(page, `Design system, Tokens (${theme})`, PREVIEWS);
		});

		test("the Light/Dark switch shows the dark values, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/design-system`);
			const light = page.getByRole("button", { name: "Light", exact: true });
			const dark = page.getByRole("button", { name: "Dark", exact: true });
			const primary60 = page.getByRole("button", { name: /^primary 60:/ });
			const lightValue = await primary60.getAttribute("aria-label");
			expect(await light.getAttribute("aria-pressed")).toBe("true");
			expect(await previewTheme(page, "Preview of the colours, Light values")).toBe("light");

			await dark.focus();
			await page.keyboard.press("Space");
			await page.getByRole("table", { name: "Colour ramps, Dark values" }).waitFor();
			expect(await dark.getAttribute("aria-pressed")).toBe("true");
			// Step 60 is the base colour in both; step 10 is the page's end of each ramp.
			expect(await primary60.getAttribute("aria-label")).toBe(lightValue);
			const primary10 = await page.getByRole("button", { name: /^primary 10:/ }).getAttribute("aria-label");
			expect(primary10).toMatch(/^primary 10: #[0-3][0-9a-f]/);
			await page.waitForFunction(
				() =>
					(document.querySelector('iframe[title="Preview of the colours, Dark values"]') as HTMLIFrameElement | null)
						?.contentDocument?.documentElement.getAttribute("data-wc-theme") === "dark",
			);

			// A swatch opens its editor, in the mode shown.
			await page.getByRole("button", { name: /^secondary 70:/ }).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("group", { name: "secondary 70, Dark" }).waitFor();
			await expectAccessibleScreen(page, `Design system, dark values and a swatch (${theme})`, PREVIEWS);
		});

		test("Classes: search, and the style panel with token values first, per width and its own CSS", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/design-system?tab=classes&class=${cardId}`);
			await page.getByRole("heading", { level: 2, name: ".card" }).waitFor();
			await page.getByRole("group", { name: "From md (768 px) up" }).waitFor();
			await page.getByLabel("The Class's own CSS").waitFor();

			await page.getByLabel("Search Classes").fill("her");
			const list = page.getByRole("list", { name: "Classes" });
			await list.getByRole("button", { name: /\.hero/ }).waitFor();
			expect(await list.getByRole("button").count()).toBe(1);
			await page.getByLabel("Search Classes").fill("");

			// The value of a padding is offered the spacing steps first.
			const styles = page.getByRole("group", { name: "Styles for every width" });
			const value = styles.getByLabel("Styles for every width: value 1");
			const offered = await value.evaluate((input) =>
				[...((input as HTMLInputElement).list?.options ?? [])].map((option) => option.value),
			);
			expect(offered).toContain("var(--space-m)");
			expect(offered.every((each) => each.startsWith("var(--space-"))).toBe(true);

			await value.fill("var(--space-l)");
			await page.getByRole("status").getByText(/^Saved/).first().waitFor();
			await expectAccessibleScreen(page, `Design system, Classes (${theme})`, PREVIEWS);
		});

		test("Base styles and Custom CSS", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/design-system?tab=base`);
			await page.getByLabel("Element").waitFor();
			await page.getByRole("group", { name: "Styles of body" }).waitFor();
			await expectAccessibleScreen(page, `Design system, Base styles (${theme})`, PREVIEWS);

			await open(page, `/sites/${siteId}/design-system?tab=css`);
			await page.getByLabel("The Site's custom CSS").waitFor();
			await expectAccessibleScreen(page, `Design system, Custom CSS (${theme})`, PREVIEWS);
		});

		test("the Import dialog and the Export menu", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/design-system`);
			await expectOverlayUsable(page, page.getByRole("button", { name: "Import" }), "dialog", `Import (${theme})`, PREVIEWS);
			await expectOverlayUsable(page, page.getByRole("button", { name: "Export" }), "menu", `Export (${theme})`, PREVIEWS);
		});
	});
}

describe("importing a file", () => {
	test("shows what changes in the Draft, then replaces it", async () => {
		const page = await install.newPage("light");
		await open(page, `/sites/${siteId}/design-system`);
		const admin = await install.install.superadmin();
		const { file } = await admin.api.designSystem.exportFile({ siteId });
		const changed = { ...file, customCss: ".notice { color: var(--primary-70); }" };

		await page.getByRole("button", { name: "Import" }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByLabel("Design system file (.json)").setInputFiles({
			name: "design-system.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(changed)),
		});
		await dialog.getByText("The custom CSS changes").waitFor();
		await dialog.getByRole("button", { name: "Replace the Draft" }).click();
		await dialog.waitFor({ state: "hidden" });
		const { designSystem } = await admin.api.designSystem.get({ siteId });
		expect(designSystem.draft.customCss).toBe(".notice { color: var(--primary-70); }");
	});

	test("a file that isn't a Design system file says why", async () => {
		const page = await install.newPage("light");
		await open(page, `/sites/${siteId}/design-system`);
		await page.getByRole("button", { name: "Import" }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByLabel("Design system file (.json)").setInputFiles({
			name: "tokens.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({ color: {} })),
		});
		await dialog.getByRole("alert").getByText("This file can't be imported as a Design system.").waitFor();
		// The dialog sits outside the landmarks, as dialogs do: the landmark rule is skipped.
		await expectNoAxeViolations(page, "Design system, a refused file", ["region"], PREVIEWS);
	});
});
