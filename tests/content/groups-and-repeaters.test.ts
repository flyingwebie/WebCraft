// Groups and Repeaters: a Group holds a fixed set of other Fields, a Repeater an ordered list of
// rows, each a Group with a stable id. Every problem names the path of the Field inside them, so the
// admin can show it next to that Field.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Shops",
		key: "shops",
		urlPattern: "/shops/{slug}",
		fields: [
			{
				key: "address",
				label: "Address",
				type: "group",
				fields: [
					{ key: "street", label: "Street", type: "text" },
					{ key: "city", label: "City", type: "text", required: true, default: "Dublin" },
				],
			},
			{
				key: "team",
				label: "Team",
				type: "repeater",
				max: 3,
				fields: [
					{ key: "name", label: "Name", type: "text", required: true },
					{
						key: "role",
						label: "Role",
						type: "select",
						options: [{ value: "baker", label: "Baker" }],
						default: "baker",
					},
					{ key: "years", label: "Years", type: "number", min: 0 },
				],
			},
		],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

describe("defining them", () => {
	test("their Fields are listed inside them, with every setting", async () => {
		const { postType } = await staff.api.postTypes.get({ siteId, postTypeId });

		expect(postType.fields[0]).toMatchObject({
			key: "address",
			type: "group",
			translatable: false,
			required: false,
			default: null,
			fields: [
				{ key: "street", type: "text", translatable: true, required: false },
				{ key: "city", type: "text", required: true, default: "Dublin" },
			],
		});
		expect(postType.fields[1]).toMatchObject({ key: "team", type: "repeater", min: null, max: 3 });
	});

	test("problems inside them are named by where they are", async () => {
		const create = (fields: unknown) =>
			staff.api.postTypes.create({
				siteId,
				name: "Bad",
				urlPattern: "/bad/{slug}",
				// @ts-expect-error: Fields as a client could send them
				fields,
			});

		await expect(
			create([{ key: "box", label: "Box", type: "group", fields: [{ key: "Bad Key", label: "x", type: "text" }] }]),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at: "fields[0].fields[0].key" }] } });
		await expect(create([{ key: "box", label: "Box", type: "group", fields: [] }])).rejects.toMatchObject({
			data: { problems: [{ at: "fields[0].fields" }] },
		});
		await expect(
			create([{ key: "rows", label: "Rows", type: "repeater", fields: [{ key: "id", label: "Id", type: "text" }] }]),
		).rejects.toMatchObject({ data: { problems: [{ at: "fields[0].fields[0].key" }] } });
		await expect(
			create([
				{
					key: "box",
					label: "Box",
					type: "group",
					translatable: true,
					fields: [{ key: "a", label: "A", type: "text" }],
				},
			]),
		).rejects.toMatchObject({ data: { problems: [{ at: "fields[0].translatable" }] } });
		const deep = (depth: number): unknown =>
			depth === 0
				? { key: "leaf", label: "Leaf", type: "text" }
				: { key: `level${depth}`, label: "Level", type: "group", fields: [deep(depth - 1)] };
		await expect(create([deep(3)])).rejects.toMatchObject({
			data: { problems: [{ at: "fields[0].fields[0].fields[0].fields" }] },
		});
		// Keys inside a Group are its own: a Field may be called like a built-in one there.
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Nested titles",
			urlPattern: "/nested/{slug}",
			fields: [{ key: "seo", label: "SEO", type: "group", fields: [{ key: "title", label: "Title", type: "text" }] }],
		});
		expect(postType.fields[0]).toMatchObject({ fields: [{ key: "title" }] });
	});
});

describe("values", () => {
	test("a new Entry starts with the Group's defaults and no rows", async () => {
		const { entry } = await author.api.entries.create({ siteId, postTypeId, title: "Main Street" });

		expect(entry.draft.fields).toEqual({ address: { street: null, city: "Dublin" }, team: [] });
	});

	test("a Group's Fields change one by one; a Repeater's rows are given as a whole list", async () => {
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId,
			title: "Harbour",
			fields: {
				address: { street: "1 Quay" },
				team: [{ name: "Ada", years: 3 }, { name: "Bea" }],
			},
		});
		const [adaId, beaId] = (entry.draft.fields.team as { id: string }[]).map((row) => row.id);
		expect(entry.draft.fields).toEqual({
			address: { street: "1 Quay", city: "Dublin" },
			team: [
				{ id: expect.any(String), name: "Ada", role: "baker", years: 3 },
				{ id: expect.any(String), name: "Bea", role: "baker", years: null },
			],
		});

		// Rows keep their ids and the values not given; rows left out go; a new row gets an id.
		const { entry: changed } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: {
				address: { city: "Cork" },
				team: [{ id: beaId, years: 1 }, { name: "Cal" }, { id: adaId }],
			},
		});
		expect(changed.draft.fields).toEqual({
			address: { street: "1 Quay", city: "Cork" },
			team: [
				{ id: String(beaId), name: "Bea", role: "baker", years: 1 },
				{ id: expect.any(String), name: "Cal", role: "baker", years: null },
				{ id: String(adaId), name: "Ada", role: "baker", years: 3 },
			],
		});

		const { entry: cleared } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { address: null, team: null },
		});
		expect(cleared.draft.fields).toEqual({ address: { street: null, city: null }, team: [] });
	});

	test("values of the wrong kind inside them are refused at their path", async () => {
		const { entry } = await author.api.entries.create({ siteId, postTypeId, title: "Wrong kinds" });
		const cases: { fields: Record<string, unknown>; at: string }[] = [
			{ fields: { address: { street: 4 } }, at: "fields.address.street" },
			{ fields: { address: { postcode: "D01" } }, at: "fields.address.postcode" },
			{ fields: { address: "1 Quay" }, at: "fields.address" },
			{ fields: { team: { name: "Ada" } }, at: "fields.team" },
			{ fields: { team: [{ name: "Ada" }, { name: "Bea", years: "two" }] }, at: "fields.team[1].years" },
			{ fields: { team: [{ name: "Ada" }, "Bea"] }, at: "fields.team[1]" },
			{ fields: { team: [{ id: "x y", name: "Ada" }] }, at: "fields.team[0].id" },
			{ fields: { team: [{ id: "same" }, { id: "same" }] }, at: "fields.team[1].id" },
		];
		for (const { fields, at } of cases) {
			await expect(
				author.api.entries.saveDraft({ siteId, entryId: entry.id, fields }),
				`${JSON.stringify(fields)} is refused at ${at}`,
			).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at }] } });
		}
	});

	test("rules and required Fields inside them are listed at their path, and block publishing", async () => {
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId,
			title: "Docks",
			fields: {
				address: { city: null },
				team: [{ name: "Ada", years: -1 }, { years: 2 }, { name: "Cal" }, { name: "Dee" }],
			},
		});

		expect(entry.problems).toEqual([
			{ at: "fields.team", rule: "max", message: expect.any(String) },
			{ at: "fields.team[0].years", rule: "min", message: expect.any(String) },
			{ at: "fields.team[1].name", rule: "required", message: expect.any(String) },
		]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: entry.problems },
		});

		const { entry: fewer } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { address: { street: "Pier 4" }, team: [{ name: "Ada", years: 1 }, { years: 2 }] },
		});
		expect(fewer.problems).toEqual([
			{ at: "fields.address.city", rule: "required", message: expect.any(String) },
			{ at: "fields.team[1].name", rule: "required", message: expect.any(String) },
		]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
			data: { missing: ["address.city", "team[1].name"] },
		});
	});

	test("a required Group needs a value in one of its Fields; an empty optional Group asks nothing", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Contacts",
			urlPattern: "/contacts/{slug}",
			fields: [
				{
					key: "phone",
					label: "Phone",
					type: "group",
					required: true,
					fields: [{ key: "number", label: "Number", type: "text" }],
				},
				{
					key: "fax",
					label: "Fax",
					type: "group",
					fields: [
						{ key: "number", label: "Number", type: "text", required: true },
						{ key: "note", label: "Note", type: "text" },
					],
				},
				{
					key: "staff",
					label: "Staff",
					type: "repeater",
					required: true,
					fields: [{ key: "name", label: "Name", type: "text" }],
				},
			],
		});

		const { entry } = await author.api.entries.create({ siteId, postTypeId: postType.id, title: "Front desk" });
		expect(entry.problems.map((problem) => problem.at)).toEqual(["fields.phone", "fields.staff"]);

		const { entry: partly } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { phone: { number: "01 234" }, fax: { note: "Mornings only" }, staff: [{ name: "Ada" }] },
		});
		expect(partly.problems.map((problem) => problem.at)).toEqual(["fields.fax.number"]);
	});
});
