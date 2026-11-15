// The code panes beyond BA-11's checks (BA-33), in Chromium:
// - `{{` in the HTML box offers values, `{{` and a name the Components with their required Props, `{{@`
//   the Template commands, chosen from the keyboard (the box says which is active);
// - Tab goes from the HTML box through the CSS pane to the JS box and on: no box keeps it;
// - the CSS pane: the quick actions write plain declarations into the chosen Class; unsaved CSS shows
//   on the page before it is saved; a token utility is a chip that can be taken off, not edited; the
//   arrows move between the chips; @layer is refused; an unfinished + form doesn't follow the selection;
//   a repeat(n, 1fr) grid shows its Columns; a slow answer for an element selected before never
//   replaces the one selected now; a save over someone's newer CSS asks Reload or Overwrite;
// - Format keeps Components whole in markup; ⇧⌥F keeps the caret on its word, and a selection formats
//   only its lines;
// - a Component's Props declared in its markup preview on the page and are saved from the keyboard;
// - the shell with the suggestions open passes the accessibility checks, light and dark.
// The building area's own test of `code-mode` 152, 176, 192, 205, 261, 291, 309, `css-panel` 217, 280,
// 295, 320, 384, 415, 495, 524, `code-format` 152, `editor-keyboard` 291 and `builder` 607.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, eventually, frameOf, selectionIs, settled, stays } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let heroId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const ENTRY = [
	"<article>",
	'<h1 class="hero-title lead p-m">{{ title }}</h1>',
	'<p class="lead">Out of the oven</p>',
	'<p class="grid-box">Grid words</p>',
	"<p>Plain words</p>",
	'<Hero heading="Welcome" />',
	"</article>",
].join("");

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	for (const name of ["hero-title", "lead", "grid-box", "hero"])
		await api.designSystem.createClass({ siteId, name, styles: name === "lead" ? "line-height: 1.6;" : "" });
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", required: true }],
	});
	heroId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId: heroId,
		markup: '<section class="hero"><h2>{{ props.heading }}</h2></section>',
	});
	await api.components.publish({ siteId, componentId: heroId });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ENTRY });
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: made.id });
});

let sharedPage: Promise<Page> | undefined;

function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await page.getByRole("tree", { name: "Elements of the page" }).getByRole("treeitem").first().waitFor();
		return page;
	})();
	return sharedPage;
}

afterAll(async () => {
	await (await sharedPage)
		?.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const pane = (page: Page, id: "html" | "css" | "js") => page.locator(`[data-wc-panel="${id}"]`);
const box = (page: Page, id: "html" | "css" | "js") => page.locator(`textarea[data-wc-code-box="${id}"]`);

async function clickIn(page: Page, selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const element = (await frameOf(page)).locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			const found = await element.boundingBox();
			if (!found) throw new Error(`${selector} isn't on the page.`);
			await page.mouse.click(found.x + Math.min(12, found.width / 2), found.y + found.height / 2);
			await settled(page);
			return;
		} catch (failure) {
			if (attempt >= 3) throw failure;
			await page.waitForTimeout(250);
		}
	}
}

/** Selects an element of the page and waits for its panes, the HTML box holding its source's markup. */
async function select(page: Page, selector: string): Promise<void> {
	await clickIn(page, selector);
	// Selected (the boxes may still show the element before's source until then).
	await selectionIs(page, selector);
	await box(page, "html").waitFor();
	await eventually(
		() => box(page, "html").inputValue(),
		(text) => text.includes("<"),
	);
}

async function classOf(name: string) {
	const { api } = await install.install.superadmin();
	return (await api.designSystem.get({ siteId })).designSystem.draft.classes.find((each) => each.name === name);
}

/** The Entry template's Draft markup, without the ids the HTML box prints. */
async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

/** Puts the caret at the end of a box. */
async function toEnd(area: Locator): Promise<void> {
	await area.focus();
	await area.evaluate((element: HTMLTextAreaElement) =>
		element.setSelectionRange(element.value.length, element.value.length),
	);
}

describe("the HTML pane's suggestions", () => {
	test("the shell with the panes, then the suggestions, passes the accessibility checks, light and dark", async () => {
		const page = await shared();
		await select(page, "h1");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.waitForTimeout(1200);
			await expectAccessibleScreen(page, `the code panes (${theme})`);
		}
		const html = box(page, "html");
		const original = await html.inputValue();
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await toEnd(html);
			await page.keyboard.type("{{");
			await page.getByRole("listbox", { name: "Suggestions" }).waitFor();
			await expectNoAxeViolations(page, `the HTML pane's suggestions (${theme})`);
			await page.keyboard.press("Escape");
			await html.fill(original);
		}
		await page.emulateMedia({ colorScheme: "light" });
		await page.locator('[data-wc-rail="panels"]').focus();
	});

	test("{{ offers the values, chosen from the keyboard", async () => {
		const page = await shared();
		await select(page, "h1");
		const html = box(page, "html");
		const original = await html.inputValue();
		await toEnd(html);
		await page.keyboard.type("{{");
		const list = page.getByRole("listbox", { name: "Suggestions" });
		await list.waitFor();
		expect(await html.getAttribute("aria-activedescendant")).toBeTruthy();
		const second = (await list.getByRole("option").nth(1).locator("span").first().textContent()) ?? "";
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await list.waitFor({ state: "hidden" });
		expect(await html.inputValue()).toEndWith(second);
		expect(await html.getAttribute("aria-activedescendant")).toBeNull();
		expect(await html.evaluate((element) => element === document.activeElement)).toBe(true);
		await html.fill(original);
	});

	test("{{ and a name offer the Components, placed with their required Props", async () => {
		const page = await shared();
		await select(page, "h1");
		const html = box(page, "html");
		const original = await html.inputValue();
		await toEnd(html);
		await page.keyboard.type("{{Her");
		await page.getByRole("option", { name: /<Hero>/ }).waitFor();
		await page.keyboard.press("Enter");
		expect(await html.inputValue()).toEndWith('<Hero heading="" />');
		await html.fill(original);
	});

	test("{{@ offers the Template commands and presets", async () => {
		const page = await shared();
		await select(page, "h1");
		const html = box(page, "html");
		const original = await html.inputValue();
		await toEnd(html);
		await page.keyboard.type("{{@");
		await page
			.getByRole("option", { name: /\{\{@if\}\}/ })
			.first()
			.waitFor();
		while (!((await page.locator('[role="option"][aria-selected="true"]').textContent()) ?? "").includes("{{@if}}"))
			await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		expect(await html.inputValue()).toMatch(/\{\{@if [^}]*\}\}[\s\S]*\{\{\/if\}\}$/);
		await html.fill(original);
		await page.locator('[data-wc-rail="panels"]').focus();
	});

	test("Tab goes from the HTML box through the CSS pane to the JS box and on", async () => {
		const page = await shared();
		await select(page, "h1");
		await box(page, "html").focus();
		const reached: string[] = [];
		for (let press = 0; press < 60 && !reached.includes("js"); press++) {
			await page.keyboard.press("Tab");
			reached.push(
				await page.evaluate(() => {
					const element = document.activeElement;
					return (
						element?.getAttribute("data-wc-code-box") ??
						element?.closest("[data-wc-panel]")?.getAttribute("data-wc-panel") ??
						""
					);
				}),
			);
		}
		const css = reached.indexOf("css");
		const js = reached.indexOf("js");
		expect(css).toBeGreaterThan(-1);
		expect(js).toBeGreaterThan(css);
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box"))).not.toBe("js");
	});
});

describe("the CSS pane", () => {
	test("the quick actions write plain declarations into the chosen Class", async () => {
		const page = await shared();
		await select(page, "p.lead");
		await pane(page, "css").getByRole("button", { name: /^Grid/ }).first().click();
		expect(
			await eventually(
				async () => (await classOf("lead"))?.styles ?? "",
				(styles) => styles.includes("grid"),
			),
		).toContain("display: grid");
		// A second click takes it back off.
		await pane(page, "css").getByRole("button", { name: /^Grid/ }).first().click();
		expect(
			await eventually(
				async () => (await classOf("lead"))?.styles ?? "",
				(styles) => !styles.includes("grid"),
			),
		).not.toContain("grid");
	});

	test("unsaved CSS shows on the page before it is saved", async () => {
		const page = await shared();
		await select(page, "p.lead");
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/_webcraft/build/api/rpc/designSystem/updateClass", async (route) => {
			await held;
			await route.continue().catch(() => {});
		});
		try {
			await box(page, "css").fill(".lead {\n  line-height: 1.6;\n  color: rgb(1, 2, 3);\n}");
			const color = await eventually(
				() => frameOf(page).then((frame) => frame.locator("p.lead").evaluate((p) => getComputedStyle(p).color)),
				(value) => value === "rgb(1, 2, 3)",
			);
			expect(color).toBe("rgb(1, 2, 3)");
			expect((await classOf("lead"))?.styles).not.toContain("rgb(1, 2, 3)");
		} finally {
			release();
			await page.unroute("**/_webcraft/build/api/rpc/designSystem/updateClass");
		}
		expect(
			await eventually(
				async () => (await classOf("lead"))?.styles ?? "",
				(styles) => styles.includes("rgb(1, 2, 3)"),
			),
		).toContain("rgb(1, 2, 3)");
	});

	test("a token utility is a chip that can be taken off, not edited; the arrows move between the chips", async () => {
		const page = await shared();
		await select(page, "h1");
		const utilities = pane(page, "css").getByRole("list", { name: "Token utilities" });
		await utilities.waitFor();
		expect(await utilities.getByRole("textbox").count()).toBe(0);
		const chips = pane(page, "css").locator("button[aria-pressed]");
		await chips.first().focus();
		await page.keyboard.press("ArrowRight");
		expect(await chips.nth(1).getAttribute("aria-pressed")).toBe("true");
		expect(await chips.nth(1).evaluate((chip) => chip === document.activeElement)).toBe(true);
		await page.keyboard.press("Home");
		expect(await chips.first().getAttribute("aria-pressed")).toBe("true");
		const hasPm = /<h1 class="[^"]*\bp-m\b/;
		expect(await entryMarkup()).toMatch(hasPm);
		await utilities.getByRole("button", { name: "Remove token utility p-m" }).click();
		// Taken off the element in the Draft, not only on the page.
		expect(await eventually(entryMarkup, (text) => !hasPm.test(text))).toMatch(/<h1 class="hero-title lead">/);
		await (await frameOf(page)).locator("h1:not(.p-m)").waitFor();
		expect(
			await eventually(
				() => pane(page, "css").getByRole("list", { name: "Token utilities" }).count(),
				(count) => count === 0,
			),
		).toBe(0);
	});

	test("@layer is refused and nothing is saved", async () => {
		const page = await shared();
		await select(page, "p.lead");
		const before = await classOf("lead");
		expect(before?.styles).not.toContain("rgb(4, 5, 6)");
		let saves = 0;
		const counted = (request: { url(): string }) => {
			if (request.url().includes("/designSystem/updateClass")) saves++;
		};
		page.on("request", counted);
		try {
			// The valid part differs from what is saved: a save of it alone would show.
			await box(page, "css").fill(
				".lead {\n  line-height: 1.6;\n  color: rgb(4, 5, 6);\n}\n@layer custom {\n  p { color: red; }\n}",
			);
			await pane(page, "css").getByText("remove @layer").waitFor({ timeout: 5000 });
			// Longer than the pane waits before it saves what is typed (checked just below).
			await stays(
				() => classOf("lead"),
				(now) => JSON.stringify(now) === JSON.stringify(before),
				{ during: 4000, what: "The Class" },
			);
			expect(saves).toBe(0);
			// Without @layer the same words are saved in that time: the wait above was long enough to see one.
			await box(page, "css").fill(".lead {\n  line-height: 1.6;\n  color: rgb(4, 5, 6);\n}");
			expect(
				await eventually(
					async () => (await classOf("lead"))?.styles ?? "",
					(styles) => styles.includes("rgb(4, 5, 6)"),
					{ timeout: 4000 },
				),
			).toContain("rgb(4, 5, 6)");
		} finally {
			page.off("request", counted);
		}
	});

	test("an unfinished + form doesn't follow the selection to another element", async () => {
		const page = await shared();
		await select(page, "h1");
		await pane(page, "css").getByRole("button", { name: "Add a Class" }).click();
		await pane(page, "css").getByRole("textbox", { name: "Add a Class" }).fill("half-typed");
		await select(page, "p.lead");
		// The pane follows the selection on its next render (after saving what the box held, if anything).
		await pane(page, "css")
			.getByRole("textbox", { name: "Add a Class" })
			.waitFor({ state: "detached", timeout: 5000 })
			.catch(() => {});
		expect(await pane(page, "css").getByRole("textbox", { name: "Add a Class" }).count()).toBe(0);
	});

	test("a repeat(n, 1fr) grid shows its Columns, and changing them writes the grid", async () => {
		const page = await shared();
		const { api } = await install.install.superadmin();
		const grid = await classOf("grid-box");
		await api.designSystem.updateClass({
			siteId,
			classId: grid?.id ?? "",
			styles: "display: grid;\ngrid-template-columns: repeat(4, 1fr);",
		});
		await select(page, "p.grid-box");
		const columns = pane(page, "css").getByRole("spinbutton", { name: "Columns" });
		expect(
			await eventually(
				() => columns.inputValue().catch(() => ""),
				(value) => value === "4",
			),
		).toBe("4");
		await columns.fill("3");
		expect(await box(page, "css").inputValue()).toContain("grid-template-columns: repeat(3, 1fr);");
		expect(
			await eventually(
				async () => (await classOf("grid-box"))?.styles ?? "",
				(styles) => styles.includes("repeat(3"),
			),
		).toContain("repeat(3, 1fr)");
	});

	test("a slow answer for an element selected before never replaces the one selected now", async () => {
		const page = await shared();
		await select(page, "p:text-is('Plain words')");
		// The pane reads the Design system again when the selection moves (someone may have changed a Class
		// meanwhile), one read at a time. The one h1's selection sends is held until p.grid-box is selected,
		// and a peer changes p.grid-box's Class before it is answered: the late answer is shown, and shown
		// for p.grid-box, the element selected now.
		const chips = () =>
			pane(page, "css")
				.locator("[data-wc-css-class]")
				.evaluateAll((each) => each.map((chip) => chip.getAttribute("data-wc-css-class")));
		let reads = 0;
		let gridClicked = false;
		let heldSentBeforeGrid = null as boolean | null;
		const release = Promise.withResolvers<void>();
		const lateAnswered = Promise.withResolvers<void>();
		await page.route("**/_webcraft/build/api/rpc/designSystem/get", async (route) => {
			reads++;
			if (reads > 1) {
				await route.continue().catch(() => {});
				return;
			}
			heldSentBeforeGrid = !gridClicked;
			await release.promise;
			await route.continue().catch(() => {});
			await route
				.request()
				.response()
				.catch(() => null);
			lateAnswered.resolve();
		});
		try {
			await clickIn(page, "h1");
			await eventually(
				async () => reads,
				(count) => count >= 1,
				{ what: "The read h1's selection sends" },
			);
			gridClicked = true;
			await clickIn(page, "p.grid-box");
			// Shown from what the pane holds while the read waits.
			expect(await eventually(chips, (names) => names.join() === "grid-box")).toEqual(["grid-box"]);
			const { api } = await install.install.superadmin();
			const grid = await classOf("grid-box");
			await api.designSystem.updateClass({
				siteId,
				classId: grid?.id ?? "",
				styles: `${grid?.styles ?? ""}\ngap: 3rem;`,
			});
			release.resolve();
			await lateAnswered.promise;
			expect(heldSentBeforeGrid).toBe(true);
			// The late answer reached the pane (the peer's gap shows) for the element selected now.
			expect(
				await eventually(
					() => box(page, "css").inputValue(),
					(text) => text.includes("gap: 3rem"),
				),
			).toStartWith(".grid-box");
			await settled(page);
			expect(await chips()).toEqual(["grid-box"]);
		} finally {
			await page.unroute("**/_webcraft/build/api/rpc/designSystem/get");
		}
	});

	test("saving over CSS someone saved meanwhile asks Reload theirs or Overwrite with mine", async () => {
		const page = await shared();
		await select(page, "p.grid-box");
		const { api } = await install.install.superadmin();
		const grid = await classOf("grid-box");
		await api.designSystem.updateClass({ siteId, classId: grid?.id ?? "", styles: "display: grid;\ngap: 2rem;" });
		await box(page, "css").fill(".grid-box {\n  display: grid;\n  gap: 1rem;\n}");
		const dialog = page.getByRole("alertdialog");
		await dialog.waitFor({ timeout: 10000 });
		await expectNoAxeViolations(page, "the CSS conflict");
		await dialog.getByRole("button", { name: "Overwrite with mine" }).click();
		expect(
			await eventually(
				async () => (await classOf("grid-box"))?.styles ?? "",
				(styles) => styles.includes("1rem"),
			),
		).toContain("gap: 1rem");
	});
});

describe("Format and Components' Props in the HTML pane", () => {
	test("Format keeps Components whole in markup", async () => {
		const page = await shared();
		await select(page, "h1");
		const html = box(page, "html");
		const original = await html.inputValue();
		// The box prints each element with its id, last (`<Hero heading="Welcome" data-wc-id="…" />`).
		const placed = /<Hero heading="Welcome"( data-wc-id="[^"]*")? \/>/;
		expect(original).toMatch(placed);
		const messy = original.replace(/<article\b[^>]*>/, "$&\n").replace(placed, '<Hero    heading="Welcome"$1/>');
		expect(messy).toContain("<Hero    heading=");
		expect(messy).not.toContain("\n  <h1");
		await html.fill(messy);
		await html.focus();
		await page.keyboard.press("Alt+Shift+KeyF");
		const tidied = await eventually(
			() => html.inputValue(),
			(text) => text.includes("\n  <h1"),
			{ what: "Format's indented markup" },
		);
		// Format ran (the article's children indented) and left the Placement whole: as it was typed, its
		// id kept, not split, renamed or tidied into something else.
		const typed = messy.match(/<Hero {4}heading="Welcome"( data-wc-id="[^"]*")?\/>/)?.[0] ?? "";
		expect(typed).not.toBe("");
		expect(tidied).toContain(typed);
		expect(tidied.match(/<Hero\b/g)).toHaveLength(1);
		await html.fill(original);
		await page.locator('[data-wc-rail="panels"]').focus();
	});

	test("⇧⌥F in the JS box keeps the caret on its word; a selection formats only its lines", async () => {
		const page = await shared();
		await select(page, "h1");
		const js = box(page, "js");
		const original = await js.inputValue();
		const messy = "const hero=document.querySelector('.hero');if(hero){hero.classList.add('is-ready')}";
		await js.fill(messy);
		await eventually(
			() => js.inputValue(),
			(text) => text === messy,
		);
		const at = messy.indexOf("classList");
		await js.evaluate((area: HTMLTextAreaElement, offset) => area.setSelectionRange(offset, offset), at + 3);
		await js.press("Alt+Shift+KeyF");
		const tidied = await eventually(
			() => js.inputValue(),
			(text) => text.includes("\n") && text.includes("classList"),
			{ what: "The formatted script" },
		);
		expect(tidied).not.toBe(messy);
		const caret = await js.evaluate((area: HTMLTextAreaElement) => area.selectionStart);
		// The word moved with the text around it, and the caret moved with it.
		expect(tidied.indexOf("classList")).not.toBe(at);
		expect(caret).not.toBe(at + 3);
		expect(tidied.slice(caret - 3, caret + 6)).toBe("classList");

		const lines = ["let a=1", "let b=2", "let c=3"] as const;
		await js.fill(lines.join("\n"));
		const start = lines[0].length + 1;
		await js.evaluate((area: HTMLTextAreaElement, [from, to]) => area.setSelectionRange(from, to), [
			start,
			start + lines[1].length,
		] as const);
		await js.press("Alt+Shift+KeyF");
		expect(
			await eventually(
				() => js.inputValue(),
				(text) => text.includes("let b = 2;"),
			),
		).toBe("let a=1\nlet b = 2;\nlet c=3");
		await js.fill(original);
		await page.locator('[data-wc-rail="panels"]').focus();
	});

	test("a Component's Props declared in its markup preview on the page and save from the keyboard", async () => {
		const page = await shared();
		await select(page, "section.hero h2");
		const html = box(page, "html");
		const shown = await html.inputValue();
		const declared = 'strapline: text exposed default="Preview words"\n';
		await html.fill(
			(shown.includes("{{/props}}")
				? shown.replace("{{/props}}", `${declared}{{/props}}`)
				: `{{@props}}\nheading: text\n${declared}{{/props}}\n${shown}`
			).replace("</h2>", "</h2><p>{{ props.strapline }}</p>"),
		);
		await (await frameOf(page)).getByText("Preview words").waitFor({ timeout: 10000 });
		await html.focus();
		await page.keyboard.press("ControlOrMeta+s");
		const { api } = await install.install.superadmin();
		const saved = await eventually(
			() => api.components.getMarkup({ siteId, componentId: heroId }),
			(got) => got.component.draft.props.some((prop) => prop.key === "strapline"),
		);
		expect(saved.component.draft.props.find((prop) => prop.key === "strapline")).toMatchObject({
			exposed: true,
			default: "Preview words",
		});
	});
});
