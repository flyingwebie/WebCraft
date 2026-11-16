// The Forms place's own reading (BA-26): its addresses (the Form and its tab, the Build tab's view),
// a new Form's key, the arithmetic of a Form's items (steps, moving across sections and steps, removing
// a step's title, widths that snap, where a drop lands, how many changes a Draft holds), what New Form
// starts from, and the Site's stylesheet read for the sheet's shadow root.
import { describe, expect, test } from "bun:test";
import { emptyField, type FormField, type FormVersion } from "@webcraft/renderer/forms";

import en from "../../apps/server/src/messages/en.json" with { type: "json" };
import { isPlace } from "../../apps/server/src/ui/building-area/documents.ts";
import {
	addStep,
	changesOf,
	dropAt,
	insertAt,
	moveStep,
	moveTo,
	nudge,
	removeAt,
	snapWidth,
	stepOf,
	stepRange,
	stepsOf,
} from "../../apps/server/src/ui/building-area/places/forms/build-tab/layout.ts";
import { forShadowRoot } from "../../apps/server/src/ui/building-area/places/forms/build-tab/site-styles.ts";
import { STARTERS, starterFields } from "../../apps/server/src/ui/building-area/places/forms/starters.ts";
import {
	formsAt,
	formsPlace,
	keyFromName,
	printBuildView,
	readBuildView,
} from "../../apps/server/src/ui/building-area/places/forms/view.ts";

const id = "11111111-1111-4111-8111-111111111111";
const field = (key: string, type: FormField["type"] = "text") => emptyField(key, type, { text: key });
const keys = (items: readonly FormField[]) => items.map((item) => item.key);

describe("addresses", () => {
	test("a Form and its tab; Build is the Form's own address", () => {
		expect(formsAt("forms")).toEqual({ formId: null, tab: "build" });
		expect(formsAt(`forms/${id}`)).toEqual({ formId: id, tab: "build" });
		expect(formsAt(`forms/${id}/emails`)).toEqual({ formId: id, tab: "emails" });
		expect(formsAt(`forms/${id}/after-sending`)).toEqual({ formId: id, tab: "after-sending" });
		expect(formsAt(`forms/${id}/nothing`)).toEqual({ formId: id, tab: "build" });
		expect(formsAt("media")).toBeNull();
		expect(formsPlace(id)).toBe(`forms/${id}`);
		expect(formsPlace(id, "build")).toBe(`forms/${id}`);
		expect(formsPlace(id, "translations")).toBe(`forms/${id}/translations`);
		for (const place of [formsPlace(id), formsPlace(id, "after-sending"), formsPlace(null)]) {
			expect(isPlace(place)).toBe(true);
		}
	});

	test("the Build tab's view: the field chosen and the step, round-tripped", () => {
		expect(readBuildView(null)).toEqual({ field: null, step: null });
		expect(readBuildView("field=3&step=2")).toEqual({ field: 3, step: 2 });
		expect(readBuildView("field=-1&step=0&other=1")).toEqual({ field: null, step: null });
		expect(printBuildView({ field: null, step: 1 })).toBeNull();
		expect(printBuildView({ field: 0, step: 1 })).toBe("field=0");
		expect(readBuildView(printBuildView({ field: 7, step: 3 }))).toEqual({ field: 7, step: 3 });
	});

	test("a new Form's key, made from its name as the server makes it", () => {
		expect(keyFromName("Booking request")).toBe("booking-request");
		expect(keyFromName("  Crème brûlée enquiry! ")).toBe("creme-brulee-enquiry");
		expect(keyFromName("2026 orders")).toBe("form-2026-orders");
		expect(keyFromName("")).toBe("");
	});
});

describe("a Form's items", () => {
	const plain = [
		field("name"),
		field("email", "email"),
		field("cake", "section"),
		field("kind", "select"),
		field("date", "date"),
	];
	const stepped = [
		field("details", "step"),
		field("name"),
		field("email", "email"),
		field("order", "step"),
		field("cake", "section"),
		field("kind", "select"),
		field("date", "date"),
	];

	test("steps, the step an item is in, and what a step shows", () => {
		expect(stepsOf(plain)).toEqual([]);
		expect(stepRange(plain, 1)).toEqual({ indexes: [0, 1, 2, 3, 4], end: 5 });
		expect(stepsOf(stepped)).toEqual([
			{ index: 0, number: 1 },
			{ index: 3, number: 2 },
		]);
		expect(stepOf(stepped, 2)).toBe(1);
		expect(stepOf(stepped, 5)).toBe(2);
		expect(stepRange(stepped, 1)).toEqual({ indexes: [1, 2], end: 3 });
		expect(stepRange(stepped, 2)).toEqual({ indexes: [4, 5, 6], end: 7 });
		expect(stepRange(stepped, 9)).toEqual({ indexes: [4, 5, 6], end: 7 });
	});

	test("adding, moving to a gap and moving one place, across a section's and a step's title", () => {
		expect(keys(insertAt(plain, 2, field("phone", "phone")))).toEqual([
			"name",
			"email",
			"phone",
			"cake",
			"kind",
			"date",
		]);
		expect(moveTo(plain, 0, 3)).toEqual({
			items: [plain[1], plain[2], plain[0], plain[3], plain[4]] as FormField[],
			index: 2,
		});
		expect(moveTo(plain, 4, 0).index).toBe(0);
		// A move to its own place changes nothing.
		expect(keys(moveTo(plain, 1, 2).items)).toEqual(keys(plain));
		// Down past the section's title: into the section.
		expect(keys(nudge(plain, 1, 1).items)).toEqual(["name", "cake", "email", "kind", "date"]);
		// Down past the next step's title: into that step.
		const across = nudge(stepped, 2, 1);
		expect(keys(across.items)).toEqual(["details", "name", "order", "email", "cake", "kind", "date"]);
		expect(stepOf(across.items, across.index)).toBe(2);
		// Nothing goes above the first step's title.
		expect(nudge(stepped, 1, -1).items).toEqual(stepped);
	});

	test("a step's title removed joins its fields to the step before; the first step's, to the next", () => {
		expect(keys(removeAt(stepped, 3))).toEqual(["details", "name", "email", "cake", "kind", "date"]);
		expect(keys(removeAt(stepped, 0))).toEqual(["order", "name", "email", "cake", "kind", "date"]);
		expect(keys(removeAt(plain, 0))).toEqual(["email", "cake", "kind", "date"]);
	});

	test("a new step: a Form without steps puts everything in a first one", () => {
		const make = (number: number) => field(`step_${number}`, "step");
		const first = addStep(plain, make);
		expect(keys(first.items)).toEqual(["step_1", "name", "email", "cake", "kind", "date", "step_2"]);
		expect(first.step).toBe(2);
		const next = addStep(stepped, make);
		expect(keys(next.items).at(-1)).toBe("step_3");
		expect(next.step).toBe(3);
	});

	test("a step moves with everything in it", () => {
		expect(keys(moveStep(stepped, 2, 1))).toEqual(["order", "cake", "kind", "date", "details", "name", "email"]);
		expect(moveStep(stepped, 1, 1)).toEqual(stepped);
	});

	test("a width snaps to a third, a half or the whole line", () => {
		expect(snapWidth(0.2)).toBe("third");
		expect(snapWidth(0.41)).toBe("third");
		expect(snapWidth(0.45)).toBe("half");
		expect(snapWidth(0.6)).toBe("half");
		expect(snapWidth(0.8)).toBe("whole");
		expect(snapWidth(1.4)).toBe("whole");
	});

	test("where a drop lands: before the item below the pointer, beside a field on a shared line, or at the end", () => {
		const box = (top: number, left = 0, width = 600) => ({ top, left, width, height: 60 });
		const items = [
			{ index: 0, box: box(0, 0, 290) },
			{ index: 1, box: box(0, 310, 290) },
			{ index: 2, box: box(80) },
			{ index: 4, box: box(160) },
		];
		expect(dropAt(items, { x: 100, y: 30 })?.before).toBe(0);
		expect(dropAt(items, { x: 250, y: 30 })?.before).toBe(1);
		expect(dropAt(items, { x: 500, y: 30 })?.before).toBe(2);
		expect(dropAt(items, { x: 500, y: 30 })?.line.vertical).toBe(true);
		expect(dropAt(items, { x: 300, y: 85 })?.before).toBe(2);
		expect(dropAt(items, { x: 300, y: 130 })?.before).toBe(4);
		expect(dropAt(items, { x: 300, y: 150 })?.line).toEqual({ x: 0, y: 150, length: 600, vertical: false });
		expect(dropAt(items, { x: 300, y: 400 })?.before).toBeNull();
		expect(dropAt([], { x: 0, y: 0 })).toBeNull();
	});

	test("a Draft's changes against what is published", () => {
		const version = (fields: FormField[]): FormVersion => ({
			fields,
			submitLabel: { text: "Send" },
			success: { kind: "message", message: { text: "Thanks" } },
			spam: { minFillSeconds: 3, perMinute: 5, perHour: 30 },
		});
		const published = version(plain);
		expect(changesOf(published, published)).toBe(0);
		expect(changesOf(version(plain), null)).toBe(5);
		expect(changesOf(version([]), null)).toBe(1);
		const changed = version([
			{ ...field("name"), required: true },
			field("email", "email"),
			field("cake", "section"),
			field("kind", "select"),
			field("phone", "phone"),
		]);
		// `name` changed, `date` gone, `phone` new.
		expect(changesOf(changed, published)).toBe(3);
		expect(changesOf({ ...published, submitLabel: { text: "Order" } }, published)).toBe(1);
	});
});

describe("New Form", () => {
	test("each starter's fields have keys of their own and labels in the person's words", () => {
		const words = en.buildingArea;
		expect(starterFields("blank", words)).toEqual([]);
		for (const starter of STARTERS) {
			const fields = starterFields(starter, words);
			expect(new Set(keys(fields)).size).toBe(fields.length);
			for (const each of fields) expect(each.label.text.length).toBeGreaterThan(0);
		}
		expect(keys(starterFields("contact", words))).toEqual(["name", "email", "message"]);
		expect(starterFields("booking", words).find((each) => each.key === "people")?.label.text).toBe("Number of people");
	});
});

describe("the Site's stylesheet on the sheet", () => {
	test(":root and html are the host, body the sheet, inside layers and media queries; @font-face is set apart", () => {
		const css = [
			"@layer reset,tokens;",
			"@layer reset{html{-webkit-text-size-adjust:100%}body{margin:0}}",
			"@layer tokens{:root{--a:1}@media (prefers-color-scheme:dark){:root:not([data-wc-theme=light]){--a:2}}:root[data-wc-theme=dark]{--a:3}}",
			'@font-face{font-family:"Brand";src:url("/_media/brand;x{y}.woff2")}',
			'body.home .x,html body>p{content:"body {"}',
			".somebody{color:red}",
			"@keyframes k{from{opacity:0}to{opacity:1}}",
		].join("");
		const { css: shadow, fontFaces } = forShadowRoot(css);
		expect(shadow).toBe(
			[
				"@layer reset,tokens;",
				"@layer reset{:host{-webkit-text-size-adjust:100%}[data-wcb-page]{margin:0}}",
				"@layer tokens{:host{--a:1}@media (prefers-color-scheme:dark){:host(:not([data-wc-theme=light])){--a:2}}:host([data-wc-theme=dark]){--a:3}}",
				'[data-wcb-page].home .x,:host [data-wcb-page]>p{content:"body {"}',
				".somebody{color:red}",
				"@keyframes k{from{opacity:0}to{opacity:1}}",
			].join(""),
		);
		expect(fontFaces).toBe('@font-face{font-family:"Brand";src:url("/_media/brand;x{y}.woff2")}');
	});
});
