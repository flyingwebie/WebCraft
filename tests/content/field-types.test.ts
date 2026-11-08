// Field types: every Field of a Post Type has a type, a label, help text, whether it is required,
// a default, whether it is a Translatable field, and the rules of its type (min/max, pattern, …).
// Staff define them; the server checks every definition and every value saved into a Draft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let postTypes = 0;

/** A Post Type with the given Fields, at its own URL pattern. */
async function postTypeWith(fields: Parameters<TestBrowser["api"]["postTypes"]["create"]>[0]["fields"]) {
	const key = `kind-${++postTypes}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${postTypes}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields,
	});
	return postType;
}

describe("defining Fields", () => {
	test("every Field type, with its settings in full", async () => {
		const postType = await postTypeWith([
			{ key: "summary", label: "Summary", type: "text", help: "One or two lines.", maxLength: 160, pattern: "[^<>]*" },
			{ key: "intro", label: "Intro", type: "richText", maxLength: 500 },
			{ key: "price", label: "Price", type: "number", min: 0, max: 1000, required: true },
			{ key: "servings", label: "Servings", type: "number", integer: true, default: 4 },
			{ key: "vegan", label: "Vegan", type: "boolean", default: true },
			{ key: "bakedOn", label: "Baked on", type: "date" },
			{ key: "opensAt", label: "Opens at", type: "date", mode: "time", min: "06:00", max: "12:00" },
			{
				key: "size",
				label: "Size",
				type: "select",
				options: [
					{ value: "small", label: "Small" },
					{ value: "large", label: "Large" },
				],
				default: "small",
			},
			{
				key: "allergens",
				label: "Allergens",
				type: "select",
				multiple: true,
				max: 2,
				options: [
					{ value: "gluten", label: "Gluten" },
					{ value: "nuts", label: "Nuts" },
					{ value: "milk", label: "Milk" },
				],
			},
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "orderLink", label: "Order link", type: "link" },
			{ key: "contact", label: "Contact", type: "email", translatable: true },
		]);

		const common = { help: "", required: false, translatable: false, default: null };
		expect(postType.fields).toEqual([
			{
				key: "summary",
				label: "Summary",
				type: "text",
				help: "One or two lines.",
				required: false,
				translatable: true,
				default: null,
				minLength: null,
				maxLength: 160,
				pattern: "[^<>]*",
			},
			{ key: "intro", label: "Intro", type: "richText", ...common, translatable: true, maxLength: 500 },
			{ key: "price", label: "Price", type: "number", ...common, required: true, min: 0, max: 1000, integer: false },
			{
				key: "servings",
				label: "Servings",
				type: "number",
				...common,
				default: 4,
				min: null,
				max: null,
				integer: true,
			},
			{ key: "vegan", label: "Vegan", type: "boolean", ...common, default: true },
			{ key: "bakedOn", label: "Baked on", type: "date", ...common, mode: "date", min: null, max: null },
			{ key: "opensAt", label: "Opens at", type: "date", ...common, mode: "time", min: "06:00", max: "12:00" },
			{
				key: "size",
				label: "Size",
				type: "select",
				...common,
				default: "small",
				options: [
					{ value: "small", label: "Small" },
					{ value: "large", label: "Large" },
				],
				multiple: false,
				min: null,
				max: null,
			},
			{
				key: "allergens",
				label: "Allergens",
				type: "select",
				...common,
				options: [
					{ value: "gluten", label: "Gluten" },
					{ value: "nuts", label: "Nuts" },
					{ value: "milk", label: "Milk" },
				],
				multiple: true,
				min: null,
				max: 2,
			},
			{ key: "photo", label: "Photo", type: "media", ...common },
			{ key: "orderLink", label: "Order link", type: "link", ...common, translatable: true },
			{ key: "contact", label: "Contact", type: "email", ...common, translatable: true, pattern: null },
		]);
		expect((await editor.api.postTypes.get({ siteId, postTypeId: postType.id })).postType.fields).toEqual(
			postType.fields,
		);
	});

	test("settings that don't fit their type are refused, each where it is", async () => {
		const cases: { field: Record<string, unknown>; at: string }[] = [
			{ field: { type: "text", minLength: 10, maxLength: 5 }, at: "fields[0].maxLength" },
			{ field: { type: "text", maxLength: 1_000_000 }, at: "fields[0].maxLength" },
			{ field: { type: "text", pattern: "(unclosed" }, at: "fields[0].pattern" },
			// Patterns run on a linear-time engine, which has no look-around and no back-references.
			{ field: { type: "text", pattern: "(?=a)a+" }, at: "fields[0].pattern" },
			{ field: { type: "text", pattern: "(a)\\1" }, at: "fields[0].pattern" },
			{ field: { type: "text", default: "abc", pattern: "[0-9]+" }, at: "fields[0].default" },
			{ field: { type: "number", min: 5, max: 1 }, at: "fields[0].max" },
			{ field: { type: "number", default: "four" }, at: "fields[0].default" },
			{ field: { type: "boolean", required: true }, at: "fields[0].required" },
			{ field: { type: "date", mode: "week" }, at: "fields[0].mode" },
			{ field: { type: "date", min: "2026-02-30" }, at: "fields[0].min" },
			{ field: { type: "select", options: [] }, at: "fields[0].options" },
			{
				field: {
					type: "select",
					options: [
						{ value: "a", label: "A" },
						{ value: "a", label: "Again" },
					],
				},
				at: "fields[0].options[1].value",
			},
			{ field: { type: "select", options: [{ value: "a b", label: "A" }] }, at: "fields[0].options[0].value" },
			{ field: { type: "select", options: [{ value: "a", label: "A" }], default: "b" }, at: "fields[0].default" },
			{ field: { type: "media", default: "x" }, at: "fields[0].default" },
			{ field: { type: "email", default: "not an address" }, at: "fields[0].default" },
			{ field: { type: "link", default: { url: "javascript:alert(1)", text: "Go" } }, at: "fields[0].default" },
			{ field: { type: "text", help: "x".repeat(501) }, at: "fields[0].help" },
		];
		for (const { field, at } of cases) {
			await expect(
				staff.api.postTypes.create({
					siteId,
					name: "Bad",
					urlPattern: "/bad/{slug}",
					// @ts-expect-error: settings as a client could send them
					fields: [{ key: "value", label: "Value", ...field }],
				}),
				`${JSON.stringify(field)} is refused at ${at}`,
			).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at }] } });
		}
	});

	test("a Field keeps its type, but its settings can change", async () => {
		const postType = await postTypeWith([{ key: "weight", label: "Weight", type: "number" }]);

		await expect(
			staff.api.postTypes.update({
				siteId,
				postTypeId: postType.id,
				fields: [{ key: "weight", label: "Weight", type: "text" }],
			}),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at: "fields[0].type" }] } });

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: [{ key: "weight", label: "Weight (g)", type: "number", min: 1, help: "In grams." }],
		});
		expect(changed.fields[0]).toMatchObject({ label: "Weight (g)", min: 1, help: "In grams." });
	});
});

describe("values", () => {
	test("each type keeps its own kind of value; empty ones read as nothing", async () => {
		const postType = await postTypeWith([
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "price", label: "Price", type: "number" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "bakedOn", label: "Baked on", type: "date" },
			{ key: "deliveredAt", label: "Delivered at", type: "date", mode: "dateTime" },
			{ key: "opensAt", label: "Opens at", type: "date", mode: "time" },
			{ key: "size", label: "Size", type: "select", options: [{ value: "small", label: "Small" }] },
			{
				key: "allergens",
				label: "Allergens",
				type: "select",
				multiple: true,
				options: [
					{ value: "gluten", label: "Gluten" },
					{ value: "nuts", label: "Nuts" },
				],
			},
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "orderLink", label: "Order link", type: "link" },
			{ key: "contact", label: "Contact", type: "email" },
		]);

		const { entry: empty } = await author.api.entries.create({ siteId, postTypeId: postType.id, title: "Empty" });
		expect(empty.draft.fields).toEqual({
			summary: null,
			intro: null,
			price: null,
			vegan: false,
			bakedOn: null,
			deliveredAt: null,
			opensAt: null,
			size: null,
			allergens: [],
			photo: null,
			orderLink: null,
			contact: null,
		});

		const { entry } = await author.api.entries.saveDraft({
			siteId,
			entryId: empty.id,
			fields: {
				summary: "  Crusty  ",
				intro: "<p>Baked <strong>daily</strong>.</p>",
				price: 4.5,
				vegan: true,
				bakedOn: "2026-03-02",
				deliveredAt: "2026-03-02T10:15:00+01:00",
				opensAt: "07:30",
				size: "small",
				allergens: ["nuts", "gluten", "nuts"],
				orderLink: { url: "https://shop.example/loaf", text: "Order" },
				contact: " Orders@Bakery.Example ",
			},
		});
		expect(entry.draft.fields).toEqual({
			summary: "Crusty",
			intro: "<p>Baked <strong>daily</strong>.</p>",
			price: 4.5,
			vegan: true,
			bakedOn: "2026-03-02",
			deliveredAt: "2026-03-02T09:15:00Z",
			opensAt: "07:30",
			size: "small",
			allergens: ["nuts", "gluten"],
			photo: null,
			orderLink: { url: "https://shop.example/loaf", text: "Order" },
			contact: "orders@bakery.example",
		});
		expect(entry.problems).toEqual([]);
	});

	test("rich text is cleaned when it is saved: only formatting and safe links are kept", async () => {
		const postType = await postTypeWith([{ key: "intro", label: "Intro", type: "richText" }]);

		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Rich",
			fields: {
				intro:
					'<p onclick="steal()" style="color:red" class="x">Hello <em>there</em><script>alert(1)</script></p>' +
					'<a href="javascript:alert(1)">bad</a> <a href="/menu" target="_blank">menu</a>' +
					"<iframe src=//evil.example></iframe><div>plain <b>bold</b></div><ul><li>one<li>two</ul>",
			},
		});

		expect(entry.draft.fields.intro).toBe(
			'<p>Hello <em>there</em></p><a href="#">bad</a> <a href="/menu">menu</a>plain <b>bold</b><ul><li>one</li><li>two</li></ul>',
		);
	});

	test("a value of the wrong kind is refused, and the Draft keeps what it had", async () => {
		const postType = await postTypeWith([
			{ key: "price", label: "Price", type: "number" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "bakedOn", label: "Baked on", type: "date" },
			{ key: "size", label: "Size", type: "select", options: [{ value: "small", label: "Small" }] },
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "orderLink", label: "Order link", type: "link" },
			{ key: "summary", label: "Summary", type: "text" },
		]);
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Loaf",
			fields: { price: 3 },
		});

		const refused: Record<string, unknown>[] = [
			{ price: "4.50" },
			{ price: [4] },
			{ vegan: "yes" },
			{ bakedOn: "2026-02-30" },
			{ bakedOn: "March 2nd" },
			{ size: "huge" },
			{ size: ["small"] },
			{ photo: "0b0c8a4e-9a51-4a31-9d6c-2c1c1b1e9f00" },
			{ orderLink: { url: "javascript:alert(1)", text: "Go" } },
			{ orderLink: "https://shop.example" },
			{ summary: 42 },
			{ summary: "x".repeat(2_001) },
		];
		for (const fields of refused) {
			const [key] = Object.keys(fields);
			await expect(
				author.api.entries.saveDraft({ siteId, entryId: entry.id, fields }),
				`${JSON.stringify(fields)} is refused`,
			).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: `fields.${key}` }] } });
		}
		expect((await author.api.entries.get({ siteId, entryId: entry.id })).entry.draft.fields.price).toBe(3);
	});
});

describe("rules", () => {
	test("a pattern that would backtrack for ages elsewhere is checked quickly, on a long value", async () => {
		const slow = ["(a+)+b", "(a|aa)*b", `${"(?:a*)".repeat(12)}b`, `${".*".repeat(15)}z`];
		const postType = await postTypeWith(
			slow.map((pattern, index) => ({ key: `slow${index}`, label: `Slow ${index}`, type: "text" as const, pattern })),
		);
		const fields = Object.fromEntries(slow.map((_, index) => [`slow${index}`, `${"a".repeat(1_500)}c`]));

		const { entry } = await author.api.entries.create({ siteId, postTypeId: postType.id, title: "Slow", fields });

		expect(entry.problems.map((problem) => [problem.at, problem.rule])).toEqual(
			slow.map((_, index) => [`fields.slow${index}`, "pattern"]),
		);
	});

	test("broken rules are kept in the Draft and listed by Field, and block publishing", async () => {
		const postType = await postTypeWith([
			{ key: "code", label: "Code", type: "text", minLength: 3, maxLength: 6, pattern: "[A-Z]+[0-9]*" },
			{ key: "price", label: "Price", type: "number", min: 1, max: 100, integer: true },
			{ key: "bakedOn", label: "Baked on", type: "date", min: "2026-01-01" },
			{
				key: "allergens",
				label: "Allergens",
				type: "select",
				multiple: true,
				min: 1,
				max: 1,
				options: [
					{ value: "gluten", label: "Gluten" },
					{ value: "nuts", label: "Nuts" },
				],
			},
			{ key: "contact", label: "Contact", type: "email" },
			{ key: "intro", label: "Intro", type: "richText", maxLength: 5 },
		]);

		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Rules",
			fields: {
				code: "ab1",
				price: 2.5,
				bakedOn: "2025-12-31",
				allergens: ["gluten", "nuts"],
				contact: "orders@",
				intro: "<p>Too <b>long</b></p>",
			},
		});

		expect(entry.problems).toEqual([
			{ at: "fields.code", rule: "pattern", message: expect.any(String) },
			{ at: "fields.price", rule: "integer", message: expect.any(String) },
			{ at: "fields.bakedOn", rule: "min", message: expect.any(String) },
			{ at: "fields.allergens", rule: "max", message: expect.any(String) },
			{ at: "fields.contact", rule: "email", message: expect.any(String) },
			{ at: "fields.intro", rule: "maxLength", message: expect.any(String) },
		]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: entry.problems },
		});

		const { entry: fixed } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: {
				code: "AB1",
				price: 3,
				bakedOn: "2026-01-01",
				allergens: ["nuts"],
				contact: "orders@bakery.example",
				intro: "<p>Short</p>",
			},
		});
		expect(fixed.problems).toEqual([]);
		expect((await editor.api.entries.publish({ siteId, entryId: entry.id })).entry.status).toBe("published");
	});

	test("required Fields may be empty in the Draft, are listed, and block publishing", async () => {
		const postType = await postTypeWith([
			{ key: "price", label: "Price", type: "number", required: true },
			{ key: "size", label: "Size", type: "select", required: true, options: [{ value: "small", label: "Small" }] },
			{
				key: "allergens",
				label: "Allergens",
				type: "select",
				multiple: true,
				min: 2,
				options: [
					{ value: "gluten", label: "Gluten" },
					{ value: "nuts", label: "Nuts" },
				],
			},
		]);

		const { entry } = await author.api.entries.create({ siteId, postTypeId: postType.id, title: "Unpriced" });

		expect(entry.problems).toEqual([
			{ at: "fields.price", rule: "required", message: expect.any(String) },
			{ at: "fields.size", rule: "required", message: expect.any(String) },
		]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
			data: { missing: ["price", "size"] },
		});

		const { entry: cleared } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			title: "",
			fields: { price: 2, size: "small", allergens: ["nuts"] },
		});
		expect(cleared.problems).toEqual([
			{ at: "title", rule: "required", message: expect.any(String) },
			{ at: "fields.allergens", rule: "min", message: expect.any(String) },
		]);
	});

	test("defaults fill a new Entry's Fields; values given win", async () => {
		const postType = await postTypeWith([
			{ key: "servings", label: "Servings", type: "number", default: 4 },
			{ key: "vegan", label: "Vegan", type: "boolean", default: true },
			{ key: "size", label: "Size", type: "select", options: [{ value: "small", label: "Small" }], default: "small" },
			{ key: "tagline", label: "Tagline", type: "text", default: "Fresh today" },
		]);

		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Defaults",
			fields: { tagline: "Fresh tomorrow" },
		});

		expect(entry.draft.fields).toEqual({ servings: 4, vegan: true, size: "small", tagline: "Fresh tomorrow" });
	});
});
