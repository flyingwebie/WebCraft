// The Data tab (Staff only): a real item's values from the Draft, as JSON, with the bindings Template
// markup writes to read them, for a Loop, an Entry template and the Globals.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let recipesId: string;
let chefId: string;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-01T09:00:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	const { postType: chefs } = await staff.api.postTypes.create({
		siteId,
		name: "Chefs",
		key: "chefs",
		urlPattern: "/chefs/{slug}",
		fields: [{ key: "bio", label: "Bio", type: "text" }],
	});
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "minutes", label: "Minutes", type: "number" },
				{
					key: "difficulty",
					label: "Difficulty",
					type: "select",
					options: [{ value: "easy", label: "Easy" }],
				},
				{ key: "chef", label: "Chef", type: "relationship", postTypes: ["chefs"] },
				{
					key: "steps",
					label: "Steps",
					type: "repeater",
					fields: [{ key: "text", label: "Text", type: "text" }],
				},
			],
		})
	).postType.id;
	const { entry: chef } = await staff.api.entries.create({
		siteId,
		postTypeId: chefs.id,
		title: "Ada",
		fields: { bio: "Pastry" },
	});
	chefId = chef.id;
	await staff.api.entries.publish({ siteId, entryId: chefId });
	// Only a Draft: the Data tab shows Drafts.
	await staff.api.entries.create({
		siteId,
		postTypeId: recipesId,
		title: "Brioche",
		fields: { minutes: 20, difficulty: "easy", chef: chefId, steps: [{ text: "Knead" }] },
	});
	await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
	await staff.api.globals.saveDraft({ siteId, fields: { phone: "+353 1 234 5678" } });
});

afterAll(async () => {
	await install.close();
});

const bindingsOf = (data: { bindings: { binding: string }[] }) => data.bindings.map((binding) => binding.binding);

describe("a Loop's Data tab", () => {
	test("a query Loop: its first item from the Drafts, with the bindings of each value", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "recipes",
			source: "query",
			query: { postTypes: ["recipes"] },
		});

		const data = await staff.api.loops.data({ siteId, loopId: loop.id });

		expect(data.item).toMatchObject({
			label: "Brioche",
			values: {
				title: "Brioche",
				slug: "brioche",
				url: null,
				minutes: 20,
				difficulty: { value: "easy", label: "Easy" },
				chef: { title: "Ada", url: "/chefs/ada", bio: "Pastry" },
				steps: [{ text: "Knead" }],
			},
		});
		expect(bindingsOf(data)).toEqual(
			expect.arrayContaining([
				"{{ item.title }}",
				"{{ item.url }}",
				"{{ item.minutes }}",
				"{{ item.difficulty.label }}",
				"{{ item.chef.title }}",
				"{{ item.chef.bio }}",
				"{{@loop item.steps as step}}",
				"{{ step.text }}",
				"{{@if loop.first}}",
			]),
		);
	});

	test("a Loop of its own items: its first item, in the language asked for", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "hours",
			source: "items",
			fields: [{ key: "day", label: "Day", type: "text" }],
		});
		const { loop: saved } = await staff.api.loops.saveItems({ siteId, loopId: loop.id, items: [{ day: "Monday" }] });
		await staff.api.loops.saveItems({
			siteId,
			loopId: loop.id,
			language: "fr",
			items: [{ id: saved.draft.items[0]?.id, day: "Lundi" }],
		});

		expect((await staff.api.loops.data({ siteId, loopId: loop.id })).item?.values).toEqual({ day: "Monday" });
		expect((await staff.api.loops.data({ siteId, loopId: loop.id, language: "fr" })).item?.values).toEqual({
			day: "Lundi",
		});
		const { loop: empty } = await staff.api.loops.create({ siteId, name: "nothing", source: "items" });
		expect((await staff.api.loops.data({ siteId, loopId: empty.id })).item).toBeNull();
	});
});

describe("the Data tab of an Entry template and of the Globals", () => {
	test("an Entry of the Post Type from the Drafts, read as its Entry template reads it", async () => {
		const data = await staff.api.postTypes.data({ siteId, postTypeId: recipesId });

		expect(data.item?.values).toMatchObject({ title: "Brioche", chef: { title: "Ada" } });
		expect(bindingsOf(data)).toEqual(
			expect.arrayContaining(["{{ title }}", "{{ chef.bio }}", "{{@loop steps as step}}"]),
		);
	});

	test("the Globals' Draft values, read as site.x", async () => {
		const data = await staff.api.globals.data({ siteId });

		expect(data.item?.values).toEqual({ phone: "+353 1 234 5678", language: "en", name: "Acme Bakery" });
		expect(bindingsOf(data)).toEqual(["{{ site.phone }}", "{{ site.language }}", "{{ site.name }}"]);
	});

	test("only Staff see the Data tab", async () => {
		await expect(editor.api.postTypes.data({ siteId, postTypeId: recipesId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(editor.api.globals.data({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
