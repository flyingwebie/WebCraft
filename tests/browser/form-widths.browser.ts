// A Form whose fields have widths (whole, half, third) on a Site's page, in a real browser and in the
// device's light and dark themes: halves and thirds side by side from the Design system's smallest
// breakpoint up, wrapping onto the next line, in the Form itself, in a section and in a step; every
// field whole under that width; the same without JavaScript; and the Site's own CSS laying them out
// another way. Each page is checked with axe-core and the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import type { Page } from "playwright";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let siteId: string;
const slug = "bakery";
const ORDER = "/visit/order";
const STEPS = "/book/steps";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const CAKES = [
	{ value: "single", label: "Single tier" },
	{ value: "tiered", label: "Tiered" },
];

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	await api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await install.goLive(siteId);

	const { form: order } = await api.forms.create({ siteId, name: "Order a cake", key: "order" });
	await api.forms.saveDraft({
		siteId,
		formId: order.id,
		form: {
			fields: [
				{ key: "first_name", type: "text", label: "First name", width: "half", required: true },
				{ key: "last_name", type: "text", label: "Last name", width: "half" },
				{ key: "street", type: "text", label: "Street" },
				{ key: "postcode", type: "text", label: "Postcode", width: "third" },
				{ key: "town", type: "text", label: "Town", width: "third" },
				{ key: "county", type: "select", label: "County", width: "third", options: CAKES },
				// One of two on a line has help: both start at the top of the line.
				{ key: "email", type: "email", label: "Email", width: "half", help: "We reply here within a day." },
				{ key: "phone", type: "phone", label: "Phone", width: "half" },
				// Three halves: the third wraps onto a line of its own, and stays a half.
				{ key: "venue", type: "radio", label: "Venue", width: "half", options: CAKES },
				{ key: "extras", type: "checkboxes", label: "Extras", width: "half", options: CAKES },
				{ key: "date", type: "date", label: "Date needed", width: "half" },
				{ key: "cake_details", type: "section", label: "Your cake" },
				{ key: "cake", type: "select", label: "Cake", width: "half", options: CAKES },
				{ key: "tiers", type: "number", label: "Tiers", width: "half" },
				{ key: "message", type: "textarea", label: "Message" },
				// Two thirds: the last third of the line stays empty.
				{ key: "flavour", type: "text", label: "Flavour", width: "third" },
				{ key: "filling", type: "text", label: "Filling", width: "third" },
				{ key: "consent", type: "consent", label: "I agree to be contacted about my order", required: true },
			],
			spam: { minFillSeconds: 0, perMinute: 100, perHour: 1000 },
		},
	});
	await api.forms.publish({ siteId, formId: order.id });

	const { form: steps } = await api.forms.create({ siteId, name: "Booking", key: "steps" });
	await api.forms.saveDraft({
		siteId,
		formId: steps.id,
		form: {
			fields: [
				{ key: "you", type: "step", label: "Your details" },
				{ key: "first_name", type: "text", label: "First name", width: "half", required: true },
				{ key: "last_name", type: "text", label: "Last name", width: "half" },
				{ key: "email", type: "email", label: "Email" },
				{ key: "when", type: "step", label: "When" },
				{ key: "day", type: "date", label: "Day", width: "third" },
				{ key: "guests", type: "number", label: "Guests", width: "third" },
				{ key: "table", type: "text", label: "Table", width: "third" },
			],
			spam: { minFillSeconds: 0, perMinute: 100, perHour: 1000 },
		},
	});
	await api.forms.publish({ siteId, formId: steps.id });

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p></header><main>{{@outlet}}</main><footer><p>Open every day.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	// A page for each Form: /visit/order and /book/steps.
	for (const [name, pattern, title, key] of [
		["Visits", "/visit/{slug}", "Order a cake", "order"],
		["Bookings", "/book/{slug}", "Book a table", "steps"],
	] as const) {
		const { postType } = await api.postTypes.create({ siteId, name, urlPattern: pattern });
		const template = await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: `<article><h1>{{ title }}</h1>{{@form ${key}}}</article>`,
		});
		await api.templates.publish({ siteId, templateId: template.template.id });
		const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title, slug: key });
		await api.entries.publish({ siteId, entryId: entry.id });
	}
	await api.designSystem.saveDraft({ siteId, darkMode: true });
	await api.designSystem.publish({ siteId });
});

afterAll(async () => {
	await install.close();
});

type Box = { left: number; right: number; top: number; bottom: number; width: number };

/** Where a field's wrapper (its label, help and control together) is on the page, by the field's key. */
async function boxesOf(page: Page, keys: readonly string[]): Promise<Record<string, Box>> {
	return page.evaluate((names) => {
		const boxes: Record<string, Box> = {};
		for (const name of names) {
			const control = document.querySelector(`.wc-form [name="${name}"]`);
			const wrapper = control?.closest(".wc-form-field");
			if (!wrapper) throw new Error(`The page has no field ${name}.`);
			const { left, right, top, bottom, width } = wrapper.getBoundingClientRect();
			boxes[name] = { left, right, top, bottom, width };
		}
		return boxes;
	}, keys);
}

/** Whether two lengths are the same to the pixel a browser rounds to. */
function same(a: number, b: number): boolean {
	return Math.abs(a - b) <= 1;
}

/** The fields on one line, left to right: each starts where the line starts, right of the one before. */
function expectOneLine(boxes: Record<string, Box>, keys: readonly string[], where: string): void {
	const [first, ...rest] = keys.map((key) => boxes[key] as Box);
	if (!first) throw new Error("No fields given.");
	let before = first;
	for (const [index, box] of rest.entries()) {
		expect({ where, field: keys[index + 1], top: same(box.top, first.top) }).toEqual({
			where,
			field: keys[index + 1],
			top: true,
		});
		expect({ where, field: keys[index + 1], after: box.left > before.right }).toEqual({
			where,
			field: keys[index + 1],
			after: true,
		});
		before = box;
	}
}

/** Every field takes the whole line, one under the other. */
function expectStacked(boxes: Record<string, Box>, keys: readonly string[], where: string): void {
	const all = keys.map((key) => boxes[key] as Box);
	const [first] = all;
	if (!first) throw new Error("No fields given.");
	for (const [index, box] of all.entries()) {
		const summary = {
			where,
			field: keys[index],
			left: same(box.left, first.left),
			width: same(box.width, first.width),
		};
		expect(summary).toEqual({ where, field: keys[index], left: true, width: true });
		const previous = all[index - 1];
		if (previous)
			expect({ where, field: keys[index], below: box.top >= previous.bottom }).toMatchObject({ below: true });
	}
}

const ORDER_FIELDS = [
	"first_name",
	"last_name",
	"street",
	"postcode",
	"town",
	"county",
	"email",
	"phone",
	"venue",
	"extras",
	"date",
	"cake",
	"tiers",
	"message",
	"flavour",
	"filling",
	"consent",
] as const;

/** What the order Form looks like from the breakpoint up. */
async function expectSideBySide(page: Page, where: string): Promise<void> {
	const boxes = await boxesOf(page, ORDER_FIELDS);
	const box = (key: (typeof ORDER_FIELDS)[number]) => boxes[key] as Box;
	const whole = box("street");

	// Two halves share a line, as wide as each other, and together (with the gap) as wide as a whole field.
	expectOneLine(boxes, ["first_name", "last_name"], where);
	expect(same(box("first_name").width, box("last_name").width)).toBe(true);
	expect(same(box("first_name").left, whole.left)).toBe(true);
	expect(same(box("last_name").right, whole.right)).toBe(true);
	const gap = box("last_name").left - box("first_name").right;
	expect(gap).toBeGreaterThan(8);
	expect(same(box("first_name").width * 2 + gap, whole.width)).toBe(true);
	// A whole field keeps the line to itself, under the halves.
	expect(whole.top).toBeGreaterThanOrEqual(box("first_name").bottom);

	// Three thirds share the next line.
	expectOneLine(boxes, ["postcode", "town", "county"], where);
	expect(same(box("postcode").width, box("town").width)).toBe(true);
	expect(same(box("town").width, box("county").width)).toBe(true);
	expect(same(box("county").right, whole.right)).toBe(true);
	expect(same(box("postcode").width * 3 + gap * 2, whole.width)).toBe(true);

	// Fields on one line start at its top, whatever each holds (one has help).
	expectOneLine(boxes, ["email", "phone"], where);
	expect(box("email").bottom).toBeGreaterThan(box("phone").bottom);

	// Three halves: two share a line, the third wraps and stays a half.
	expectOneLine(boxes, ["venue", "extras"], where);
	expect(box("date").top).toBeGreaterThanOrEqual(Math.max(box("venue").bottom, box("extras").bottom));
	expect(same(box("date").left, whole.left)).toBe(true);
	expect(same(box("date").width, box("venue").width)).toBe(true);

	// In a section it is the same: halves side by side, a whole field under them, thirds in thirds.
	expectOneLine(boxes, ["cake", "tiers"], where);
	expect(same(box("cake").width, box("tiers").width)).toBe(true);
	expect(box("message").top).toBeGreaterThanOrEqual(box("cake").bottom);
	expect(same(box("message").left, box("cake").left)).toBe(true);
	expect(same(box("message").right, box("tiers").right)).toBe(true);
	expectOneLine(boxes, ["flavour", "filling"], where);
	expect(same(box("flavour").width, box("filling").width)).toBe(true);
	// Two thirds leave the last third of the line empty.
	expect(box("message").right - box("filling").right).toBeGreaterThan(box("filling").width * 0.9);
	// Nothing is squeezed: a control fills its field.
	const control = await page.locator("#wc-form-1-town").boundingBox();
	expect(same(control?.width ?? 0, box("town").width)).toBe(true);
}

for (const theme of THEMES) {
	describe(`a Form whose fields have widths, ${theme}`, () => {
		test("at a desktop's width, halves and thirds sit side by side and wrap", async () => {
			const page = await install.newPage(theme);
			await page.setViewportSize(DESKTOP);
			await page.goto(install.liveUrl(slug, ORDER));
			await page.waitForLoadState("load");

			await expectSideBySide(page, `desktop (${theme})`);
			await expectAccessibleScreen(page, `a Form with widths, desktop (${theme})`);
		});

		test("on a phone every field is whole", async () => {
			const page = await install.newPage(theme);
			await page.setViewportSize(PHONE);
			await page.goto(install.liveUrl(slug, ORDER));
			await page.waitForLoadState("load");

			expectStacked(await boxesOf(page, ORDER_FIELDS), ORDER_FIELDS, `phone (${theme})`);
			await expectAccessibleScreen(page, `a Form with widths, phone (${theme})`);
		});

		test("in a step: side by side in the step shown, and in every step without JavaScript", async () => {
			const page = await install.newPage(theme);
			await page.setViewportSize(DESKTOP);
			await page.goto(install.liveUrl(slug, STEPS));
			await page.getByRole("button", { name: "Next" }).waitFor();

			const first = await boxesOf(page, ["first_name", "last_name", "email"]);
			expectOneLine(first, ["first_name", "last_name"], `first step (${theme})`);
			const [one, two, whole] = [first.first_name as Box, first.last_name as Box, first.email as Box];
			expect(same(whole.width, one.width + two.width + (two.left - one.right))).toBe(true);
			await expectAccessibleScreen(page, `a Form with widths, in steps (${theme})`);

			await page.getByLabel("First name").fill("Niamh");
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByLabel("Day").waitFor();
			expectOneLine(
				await boxesOf(page, ["day", "guests", "table"]),
				["day", "guests", "table"],
				`second step (${theme})`,
			);

			const plain = await install.newPage(theme, { javaScript: false });
			await plain.setViewportSize(DESKTOP);
			await plain.goto(install.liveUrl(slug, STEPS));
			await plain.waitForLoadState("load");
			const every = await boxesOf(plain, ["first_name", "last_name", "day", "guests", "table"]);
			expectOneLine(every, ["first_name", "last_name"], `no JavaScript (${theme})`);
			expectOneLine(every, ["day", "guests", "table"], `no JavaScript (${theme})`);
			await expectAccessibleScreen(plain, `a Form with widths, without JavaScript (${theme})`);
		});
	});
}

describe("where narrow ends, and the Site's own CSS", () => {
	test("fields are whole just under the Design system's smallest breakpoint and side by side from it", async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 767, height: 900 });
		await page.goto(install.liveUrl(slug, ORDER));
		await page.waitForLoadState("load");

		expectStacked(await boxesOf(page, ORDER_FIELDS), ORDER_FIELDS, "767 px");

		await page.setViewportSize({ width: 768, height: 900 });
		await expectSideBySide(page, "768 px");
	});

	// Last: it changes the Site's stylesheet.
	test("the Site's custom CSS lays the fields out another way", async () => {
		const { api } = await install.install.superadmin();
		await api.designSystem.saveDraft({
			siteId,
			customCss:
				".wc-form-field[data-wc-width=third] { grid-column: span 3; }\n.wc-form-field[data-wc-width=half] { grid-column: 1 / -1; }",
		});
		await api.designSystem.publish({ siteId });
		const page = await install.newPage("light");
		await page.setViewportSize(DESKTOP);
		await page.goto(install.liveUrl(slug, ORDER));
		await page.waitForLoadState("load");

		const boxes = await boxesOf(page, ["first_name", "last_name", "street", "postcode", "town", "county"]);
		const box = (key: string) => boxes[key] as Box;
		// Halves are whole now, and thirds are halves: two share a line, the third wraps.
		expectStacked(boxes, ["first_name", "last_name", "street"], "custom CSS");
		expectOneLine(boxes, ["postcode", "town"], "custom CSS");
		expect(box("county").top).toBeGreaterThanOrEqual(box("postcode").bottom);
		const gap = box("town").left - box("postcode").right;
		expect(same(box("postcode").width * 2 + gap, box("street").width)).toBe(true);
	});
});
