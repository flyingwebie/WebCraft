// The Forms place's Build tab in the building area (ADR 0037, BA-26; SPEC 15.2 and 10;
// `forms-builder/01`, `02`, `03`, `06`), in Chromium:
// - the place behind the rail's "more": the Site's Forms (Draft or Published, where each is placed),
//   New Form from a starter, the tabs with icons;
// - Build: the Form on a sheet with the Site's own styles, steps as tabs, every kind added by drag, by
//   click and by keyboard, fields moved by grip and by keys (across a section and into another step),
//   widths that snap by the right edge and by the Width setting, "Show only when" reading only earlier
//   fields with its chip on the canvas, Hidden fields as dashed rows, Delete with an Undo toast;
// - Try it sends nothing; Publish on the bottom bar publishes the fields and leaves the emails;
// - a Member gets no Forms place; the place passes the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyField, type FormField } from "@webcraft/renderer/forms";
import type { Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let cakeId: string;
let contactId: string;
const slug = "bakery";

/** The kinds' cards in the panel's order, and the layout items after them. */
const KINDS = [
	"text",
	"email",
	"phone",
	"url",
	"textarea",
	"number",
	"date",
	"select",
	"radio",
	"checkboxes",
	"consent",
	"file",
	"hidden",
	"section",
] as const;

const item = (key: string, type: FormField["type"], label: string, more: Partial<FormField> = {}): FormField => ({
	...emptyField(key, type, { text: label }),
	...more,
});

/** "Order a cake": two steps, a section, a choice that a later field's rule reads, a Hidden field. */
const CAKE: FormField[] = [
	item("details", "step", "Your details"),
	item("name", "text", "Name", { required: true, width: "half" }),
	item("email", "email", "Email", { required: true, width: "half" }),
	item("phone", "phone", "Phone"),
	item("order", "step", "Your cake"),
	item("cake", "select", "Cake", {
		required: true,
		options: [
			{ value: "wedding", label: { text: "Wedding cake" } },
			{ value: "birthday", label: { text: "Birthday cake" } },
		],
	}),
	item("tiers", "number", "How many tiers", {
		required: true,
		condition: { match: "all", rules: [{ field: "cake", op: "is", value: "wedding" }] },
	}),
	item("date", "date", "Date needed"),
	item("extras", "section", "Extras"),
	item("message", "textarea", "Message"),
	item("source", "hidden", "Source page"),
];

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;

	const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	const { entry } = await api.entries.create({ siteId, postTypeId: pages, title: "Home", slug: "home" });
	await api.entries.publish({ siteId, entryId: entry.id });
	await api.pages.setHomePage({ siteId, pageId: entry.id });

	const cake = await api.forms.create({ siteId, name: "Order a cake" });
	cakeId = cake.form.id;
	// Published without its Hidden field, which its Draft then adds: one change waits.
	await api.forms.saveDraft({ siteId, formId: cakeId, form: { fields: CAKE.slice(0, -1) } });
	await api.forms.publish({ siteId, formId: cakeId });
	await api.forms.saveDraft({ siteId, formId: cakeId, form: { fields: CAKE } });
	contactId = (await api.forms.create({ siteId, name: "Contact" })).form.id;
	// The Site template places "Order a cake": the place says where each Form is.
	const template = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<main>{{@outlet}}</main><aside>{{@form order-a-cake}}</aside>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
});

afterAll(async () => {
	await install?.close();
});

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
	if (address.includes("wc-place=forms"))
		await page.locator("[data-wcb-styled], [data-wc-forms-notice]").first().waitFor();
}

/** The shell's address with a place open over the home page. */
const placed = (place: string, view?: string) =>
	`/page/?wc-place=${encodeURIComponent(place)}${view ? `&wc-view=${encodeURIComponent(view)}` : ""}`;

/** A Form's Draft fields, as the admin reads them. */
async function fieldsOf(formId: string): Promise<FormField[]> {
	return (await superadmin.api.forms.get({ siteId, formId })).form.draft.fields;
}

/** Waits until the API reads what the place saved. */
async function eventually(read: () => Promise<unknown>, expected: unknown): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (JSON.stringify(await read()) === JSON.stringify(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	expect(await read()).toEqual(expected);
}

const keysOf = async (formId: string) => (await fieldsOf(formId)).map((each) => each.key);

/** The option on the canvas for the item at `index` of the Form. */
const option = (page: Page, index: number) => page.locator(`[data-wcb-index="${index}"] > [data-wcb-hit]`);

/** Waits until focus is on the canvas, on the item at `index` when given (it moves there a frame after a change). */
async function canvasFocus(page: Page, index?: number): Promise<void> {
	await page.waitForFunction((at) => {
		const active = document.querySelector("[data-wcb-sheet]")?.shadowRoot?.activeElement;
		return (
			active?.hasAttribute("data-wcb-hit") === true &&
			(at === undefined || active.parentElement?.getAttribute("data-wcb-index") === String(at))
		);
	}, index);
}

/** Shows "Add a field" in the panel (after the field chosen, when one is). */
async function showCards(page: Page): Promise<void> {
	const after = page.locator("[data-wc-add-after]");
	if (await after.count()) await after.click();
	await page.locator("[data-wc-add-field]").waitFor();
}

/** Drags a kind's card from the panel to a point, checking the line drawn where it lands. */
async function dragKind(page: Page, kind: string, to: { x: number; y: number }, label: string): Promise<void> {
	const card = await page.locator(`[data-wc-kind="${kind}"]`).boundingBox();
	if (!card) throw new Error(`No card for ${kind}.`);
	await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
	await page.mouse.down();
	await page.mouse.move(card.x - 40, card.y + card.height / 2, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.locator("[data-wc-drag-ghost]").waitFor();
	await page.locator("[data-wc-drop-line]", { hasText: `${label} goes here` }).waitFor();
	await page.mouse.up();
	await page.locator("[data-wc-drag-ghost]").waitFor({ state: "detached" });
}

describe("the Forms place, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("more opens the place: the Forms with their state and where they are placed, and the tabs with icons", async () => {
		const more = page.locator('[data-wc-place="more"]');
		await more.click();
		await page.locator('[data-wc-choice="forms"]').click();
		await page.locator('[data-wc-place-frame="forms"]').waitFor();
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("forms");
		expect(await more.getAttribute("aria-expanded")).toBe("false");

		const rows = page.locator("[data-wc-form-row]");
		await rows.nth(1).waitFor();
		expect(await rows.allTextContents()).toEqual([
			"ContactDraft · Not placed yet",
			"Order a cakeUnpublished changes · Placed in 1 place",
		]);
		// The first Form opens: Contact, with no fields yet.
		expect(await rows.first().getAttribute("aria-current")).toBe("page");
		await page.locator("[data-wcb-empty]").waitFor();

		const tabs = page.locator("[data-wc-form-tab]");
		expect(await tabs.allTextContents()).toEqual(["Build", "After sending", "Emails", "Translations", "Settings"]);
		expect(await tabs.evaluateAll((all) => all.every((tab) => tab.querySelector("svg") !== null))).toBe(true);
		expect(await page.locator('[data-wc-form-tab="build"]').getAttribute("aria-selected")).toBe("true");

		// Sizes (SPEC 4 and 15.2): header 40, sidebar 256, the panel 320, the sheet 680.
		expect((await page.locator("[data-wc-place-header]").boundingBox())?.height).toBe(40);
		expect((await page.locator("[data-wc-place-sidebar]").boundingBox())?.width).toBe(256);
		expect((await page.locator("[data-wc-build-panel]").boundingBox())?.width).toBe(320);
		expect((await page.locator("[data-wcb-page]").boundingBox())?.width).toBe(680);
		// Nothing chosen: "Add a field", the kinds then Section and Step.
		expect(await page.locator("[data-wc-kind]").count()).toBe(KINDS.length + 1);

		// A later tab says so, and links to the Form's page in the admin.
		await page.locator('[data-wc-form-tab="emails"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === `forms/${contactId}/emails`);
		const later = page.locator("[data-wc-place-later] a");
		expect(await later.getAttribute("href")).toEndWith(`/sites/${siteId}/forms/${contactId}?tab=emails`);
		await page.goBack();
		await page.locator("[data-wcb-empty]").waitFor();
	});

	test("the Form on its sheet, with the Site's own styles; steps as tabs; Hidden fields as dashed rows", async () => {
		await go(page, placed(`forms/${cakeId}`));
		await option(page, 1).waitFor();
		// The Site's Form hooks style it: a grid, two half fields side by side.
		const form = page.locator("[data-wcb-list]");
		expect(await form.evaluate((element) => getComputedStyle(element).display)).toBe("grid");
		// Both read at one moment, once the sheet has settled (it lays out again for a frame or two after
		// the Site's styles arrive, and two reads apart could straddle that).
		const [name, email] = await form.evaluate(async (list) => {
			let last = "";
			for (let frame = 0; frame < 60; frame++) {
				await new Promise((done) => requestAnimationFrame(done));
				const boxes = [1, 2].map((index) => list.querySelector(`[data-wcb-index="${index}"]`)?.getBoundingClientRect());
				const now = JSON.stringify(boxes);
				if (now === last) break;
				last = now;
			}
			return [1, 2].map((index) => {
				const box = list.querySelector(`[data-wcb-index="${index}"]`)?.getBoundingClientRect();
				return box ? { x: box.x, y: box.y, width: box.width } : null;
			});
		});
		expect(Math.abs((name?.y ?? 0) - (email?.y ?? 1))).toBeLessThan(1);
		expect((email?.x ?? 0) > (name?.x ?? 0) + (name?.width ?? 0)).toBe(true);
		// The shell's own styles stop at the sheet: its body text isn't the chrome's.
		const colour = await page.locator("[data-wcb-page]").evaluate((element) => getComputedStyle(element).color);
		expect(colour).not.toBe("rgb(228, 228, 231)");

		const steps = page.locator("[data-wc-step-tab]");
		expect(await steps.allTextContents()).toEqual(["1 Your details", "2 Your cake"]);
		expect(await steps.first().getAttribute("aria-selected")).toBe("true");
		await steps.nth(1).click();
		await option(page, 5).waitFor();
		expect(await page.locator('[data-wcb-index="1"]').count()).toBe(0);
		// The section is a titled group; the Hidden field a slim dashed row seen only here.
		expect(await page.locator('[data-wcb-index="8"] > legend').textContent()).toBe("Extras");
		const hidden = page.locator("[data-wcb-hidden-row]");
		expect(await hidden.textContent()).toBe("Source page · the page's address");
		expect(await hidden.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed");
		// A field with a rule carries its chip.
		expect(await page.locator('[data-wcb-index="6"] [data-wcb-chip]').textContent()).toBe(
			"Shown when Cake is Wedding cake",
		);
	});

	test("every kind is added by click, by keyboard and by drag, each where it was asked", async () => {
		await go(page, placed(`forms/${contactId}`));
		await page.locator("[data-wcb-empty]").waitFor();
		// By click: each after the one added before.
		for (const kind of KINDS) {
			await showCards(page);
			await page.locator(`[data-wc-kind="${kind}"]`).click();
			await page.locator("[data-wc-field-settings]").waitFor();
			await canvasFocus(page);
		}
		// By keyboard: "Add a field after" then Enter on a card.
		for (const kind of KINDS) {
			await page.locator("[data-wc-add-after]").focus();
			await page.keyboard.press("Enter");
			// "Add a field after" puts focus on the first card, a frame later.
			await page.waitForFunction(() => document.activeElement?.getAttribute("data-wc-kind") === "text");
			await page.locator(`[data-wc-kind="${kind}"]`).focus();
			await page.keyboard.press("Enter");
			await page.locator("[data-wc-field-settings]").waitFor();
			await canvasFocus(page);
		}
		expect(await announced(page)).toBe("Section added");
		// By drag: onto the Form below its last field, where the line shows.
		for (const kind of KINDS) {
			await showCards(page);
			const count = await page.locator("[data-wcb-hit]").count();
			const last = page.locator("[data-wcb-hit]").last();
			await last.scrollIntoViewIfNeeded();
			const box = await last.boundingBox();
			if (!box) throw new Error("No last field.");
			const label = (await page.locator(`[data-wc-kind="${kind}"]`).textContent()) ?? "";
			await dragKind(page, kind, { x: box.x + box.width / 2, y: box.y + box.height + 12 }, label);
			await page.locator("[data-wcb-hit]").nth(count).waitFor();
			await canvasFocus(page);
		}
		const kinds = [...KINDS, ...KINDS, ...KINDS];
		await eventually(async () => (await fieldsOf(contactId)).map((each) => each.type), kinds);
		// Each new field is labelled with its kind, and a choice starts with two options.
		const saved = await fieldsOf(contactId);
		expect(saved[7]?.label.text).toBe("Dropdown");
		expect(saved[7]?.options).toHaveLength(2);
	});

	test("a kind dragged between two fields lands where its line shows", async () => {
		await go(page, placed(`forms/${cakeId}`));
		const phone = page.locator('[data-wcb-index="3"]');
		await phone.waitFor();
		await showCards(page);
		const box = await phone.boundingBox();
		if (!box) throw new Error("No Phone field.");
		await dragKind(page, "date", { x: box.x + box.width / 2, y: box.y + 4 }, "Date");
		await eventually(async () => (await keysOf(cakeId)).slice(0, 5), ["details", "name", "email", "date_2", "phone"]);
		// Undo (the bottom bar's) takes it back.
		await page.locator('[data-wc-bar="undo"]').click();
		await eventually(async () => (await keysOf(cakeId)).includes("date_2"), false);
	});

	test("fields move by keys (Space, the arrows, Space) into the next step, and by their grip", async () => {
		await go(page, placed(`forms/${cakeId}`));
		await option(page, 3).click();
		await page.keyboard.press("Space");
		expect(await announced(page)).toContain("Phone picked up");
		await page.keyboard.press("ArrowDown");
		await canvasFocus(page, 4);
		await page.keyboard.press("Space");
		expect(await announced(page)).toBe("Phone dropped");
		await eventually(async () => (await keysOf(cakeId)).slice(3, 5), ["order", "phone"]);
		// It went into step 2, which the canvas now shows with it chosen.
		expect(await page.locator('[data-wc-step-tab="2"]').getAttribute("aria-selected")).toBe("true");
		expect(await option(page, 4).getAttribute("aria-selected")).toBe("true");
		await page.locator('[data-wc-bar="undo"]').click();
		await eventually(async () => (await keysOf(cakeId)).slice(3, 5), ["phone", "order"]);

		// By the grip: Email to before Name.
		await go(page, placed(`forms/${cakeId}`));
		const email = page.locator('[data-wcb-index="2"]');
		await email.hover();
		const grip = await email.locator(":scope > [data-wcb-grip]").boundingBox();
		const name = await page.locator('[data-wcb-index="1"]').boundingBox();
		if (!grip || !name) throw new Error("No grip.");
		await page.mouse.move(grip.x + 10, grip.y + 10);
		await page.mouse.down();
		await page.mouse.move(name.x + 20, name.y + name.height / 2, { steps: 10 });
		await page.locator("[data-wc-drop-line]", { hasText: "Email goes here" }).waitFor();
		await page.mouse.up();
		await eventually(async () => (await keysOf(cakeId)).slice(0, 3), ["details", "email", "name"]);
		await page.locator('[data-wc-bar="undo"]').click();
		await eventually(async () => (await keysOf(cakeId)).slice(0, 3), ["details", "name", "email"]);
	});

	test("a width snaps by the right edge, with its readout, and by the Width setting", async () => {
		await go(page, placed(`forms/${cakeId}`, "field=3"));
		const phone = page.locator('[data-wcb-index="3"]');
		await phone.waitFor();
		const handle = await phone.locator(":scope > [data-wcb-width]").boundingBox();
		const line = await page.locator("[data-wcb-list]").boundingBox();
		if (!handle || !line) throw new Error("No width handle.");
		await page.mouse.move(handle.x + 3, handle.y + 14);
		await page.mouse.down();
		await page.mouse.move(line.x + line.width * 0.52, handle.y + 14, { steps: 8 });
		expect(await phone.locator(":scope > [data-wcb-readout]").textContent()).toBe("50%");
		await page.mouse.up();
		await eventually(async () => (await fieldsOf(cakeId))[3]?.width, "half");
		expect(await page.locator('[data-wc-width-choice="half"]').getAttribute("aria-checked")).toBe("true");
		await page.locator('[data-wc-width-choice="third"]').click();
		await eventually(async () => (await fieldsOf(cakeId))[3]?.width, "third");
		await page.locator('[data-wc-width-choice="whole"]').click();
		await eventually(async () => (await fieldsOf(cakeId))[3]?.width, "whole");
	});

	test("Show only when may look only at the fields before; the first field has none to look at", async () => {
		await go(page, placed(`forms/${cakeId}`, "field=6&step=2"));
		const settings = page.locator('[data-wc-field-settings="tiers"]');
		await settings.waitFor();
		const ruleField = settings
			.locator("select")
			.filter({ has: page.locator('option[value="cake"]') })
			.first();
		expect(await ruleField.locator("option").allTextContents()).toEqual(["Name", "Email", "Phone", "Cake"]);
		// A rule added on Date can't read Date itself or what comes after it.
		await go(page, placed(`forms/${cakeId}`, "field=7&step=2"));
		const date = page.locator('[data-wc-field-settings="date"]');
		await date.getByRole("button", { name: "Add a rule" }).click();
		const offered = await date
			.locator("select")
			.filter({ has: page.locator('option[value="name"]') })
			.first()
			.locator("option")
			.allTextContents();
		expect(offered).toEqual(["Name", "Email", "Phone", "Cake", "How many tiers"]);
		expect(offered).not.toContain("Message");
		await eventually(async () => (await fieldsOf(cakeId))[7]?.condition?.rules[0]?.field, "name");
		expect(await page.locator('[data-wcb-index="7"] [data-wcb-chip]').textContent()).toBe(
			"Shown when Name is filled in",
		);
		await page.locator('[data-wc-bar="undo"]').click();
		await eventually(async () => (await fieldsOf(cakeId))[7]?.condition ?? null, null);
		// The first field has nothing before it to look at.
		await go(page, placed(`forms/${cakeId}`, "field=1"));
		const first = page.locator('[data-wc-field-settings="name"]');
		await first.waitFor();
		expect(await first.getByRole("button", { name: "Add a rule" }).count()).toBe(0);
	});

	test("Delete removes a field with an Undo toast; Escape clears the choice, then leaves the place", async () => {
		await go(page, placed(`forms/${cakeId}`));
		await option(page, 3).click();
		await page.keyboard.press("Delete");
		const toast = page.locator("[data-wc-toast]", { hasText: "Phone removed" });
		await toast.waitFor();
		await eventually(async () => (await keysOf(cakeId)).includes("phone"), false);
		await toast.locator("[data-wc-toast-action]").click();
		await eventually(async () => (await keysOf(cakeId)).slice(3, 4), ["phone"]);

		await option(page, 1).click();
		await page.keyboard.press("Escape");
		expect(await option(page, 1).getAttribute("aria-selected")).toBe("false");
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe(`forms/${cakeId}`);
		await page.keyboard.press("Escape");
		await page.locator('[data-wc-place-frame="forms"]').waitFor({ state: "detached" });
	});

	test("Try it: rules and steps work as visitors see them, and nothing is sent", async () => {
		const posts: string[] = [];
		page.on("request", (request) => {
			if (request.url().includes("/_webcraft/forms/")) posts.push(request.url());
		});
		await go(page, placed(`forms/${cakeId}`));
		await option(page, 1).waitFor();
		await page.locator("[data-wc-try-it]").click();
		expect(await page.locator("[data-wc-try-it]").getAttribute("aria-checked")).toBe("true");
		await page.getByText("Fill the Form in here to try rules and steps. Nothing is sent.").waitFor();
		const trying = page.locator("[data-wcb-trying]");
		await trying.locator("#wcb-name").fill("Jane Doe");
		await trying.locator("#wcb-email").fill("not-an-email");
		await trying.locator(".wc-form-next").click();
		// Its error, as a visitor would see it.
		await trying.locator("#wcb-email-error").waitFor();
		await trying.locator("#wcb-email").fill("jane@example.com");
		await trying.locator(".wc-form-next").click();
		await trying.locator("#wcb-cake").waitFor();
		// How many tiers shows only for a wedding cake.
		expect(await trying.locator("#wcb-tiers").count()).toBe(0);
		await trying.locator("#wcb-cake").selectOption("wedding");
		await trying.locator("#wcb-tiers").waitFor();
		await trying.locator(".wc-form-submit").click();
		await trying.locator("#wcb-tiers-error").waitFor();
		await trying.locator("#wcb-tiers").fill("3");
		await trying.locator(".wc-form-submit").click();
		await page.getByText("Nothing was sent: this was a try.").first().waitFor();
		expect(posts).toEqual([]);
		await page.locator("[data-wc-try-it]").click();
		await option(page, 5).waitFor();
	});

	test("Publish on the bottom bar publishes the Form's fields, and leaves its emails", async () => {
		await go(page, placed(`forms/${cakeId}`));
		await option(page, 1).waitFor();
		const state = page.locator("[data-wc-bar-cluster=end] [data-wc-draft-state]");
		expect(await state.textContent()).toContain("Draft · 1 change");
		const publish = page.locator("[data-wc-publish]");
		expect(await publish.isEnabled()).toBe(true);
		const width = (await publish.boundingBox())?.width;
		await publish.click();
		await eventually(async () => (await superadmin.api.forms.get({ siteId, formId: cakeId })).form.status, "published");
		const { form } = await superadmin.api.forms.get({ siteId, formId: cakeId });
		expect(form.published?.fields).toEqual(form.draft.fields);
		expect(form.emails.published).toBeNull();
		await page.locator('[data-wc-publish="published"]').waitFor();
		// Label, progress and result share one cell: the button never changes width.
		expect((await publish.boundingBox())?.width).toBe(width);
		expect(await state.textContent()).toContain("Saved");
		expect(await page.locator(`[data-wc-form-row="${cakeId}"]`).textContent()).toContain("Published");
		// A field published keeps its key: Submissions are kept under it.
		await go(page, placed(`forms/${cakeId}`, "field=1"));
		const key = page.locator('[data-wc-field-settings="name"] input[readonly]');
		expect(await key.inputValue()).toBe("name");
	});

	test("New Form from a starter: its key made from the name, its fields, and its Build tab", async () => {
		await go(page, placed(`forms/${cakeId}`));
		await page.locator("[data-wc-new-form-open]").click();
		const dialog = page.locator("[data-wc-new-form]");
		await dialog.waitFor();
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-new-form-name"))).toBe(true);
		await expectNoAxeViolations(page, "building area, New Form");
		await dialog.locator("[data-wc-new-form-name]").fill("Booking request");
		expect(await dialog.textContent()).toContain("booking-request");
		await dialog.locator('[data-wc-starter="booking"]').click();
		await dialog.locator("[data-wc-new-form-create]").click();
		await page.waitForURL((url) => {
			const at = url.searchParams.get("wc-place") ?? "";
			return /^forms\/[0-9a-f-]{36}$/.test(at) && at !== `forms/${cakeId}`;
		});
		const made = (await superadmin.api.forms.list({ siteId })).forms.find((each) => each.name === "Booking request");
		expect(made?.key).toBe("booking-request");
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe(`forms/${made?.id}`);
		expect(await keysOf(made?.id ?? "")).toEqual(["name", "email", "phone", "date", "people", "message"]);
		await option(page, 0).waitFor();
	});

	for (const theme of THEMES) {
		test(`the place passes the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, placed(`forms/${cakeId}`));
			await option(page, 1).waitFor();
			await expectAccessibleScreen(page, `building area, Forms, Add a field (${theme})`);
			await go(page, placed(`forms/${cakeId}`, "field=6&step=2"));
			await page.locator('[data-wc-field-settings="tiers"]').waitFor();
			await expectAccessibleScreen(page, `building area, Forms, a field's settings (${theme})`);
			await page.emulateMedia({ colorScheme: "light" });
		});
	}
});

describe("the Forms place, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("a Member builds no Forms, even at the place's address", async () => {
		await go(page, placed(`forms/${cakeId}`));
		await page.locator("[data-wc-place-pane]", { hasText: "only Staff build them" }).waitFor();
		expect(await page.locator("[data-wc-form-row]").count()).toBe(0);
		expect(await page.locator("[data-wcb-sheet]").count()).toBe(0);
	});
});
