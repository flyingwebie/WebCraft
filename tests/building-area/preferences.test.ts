// Editor preferences (ADR 0037): how each person likes the building area (where its panels are,
// "Format when I leave the box", the first-visit card seen) is kept on their account, so it is the
// same on every Site and in every browser. Only the person changes their own, never while someone
// impersonates them; the shape is checked and capped, and a layout from an older version of the
// building area is reset rather than refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import { EDITOR_LAYOUT_VERSION, EDITOR_PREFERENCES_MAX_BYTES, type EditorLayout } from "@webcraft/core";
import pg from "pg";

import { impersonate, withSecondFactor } from "../harness/impersonation.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let bakery: string;
let florist: string;
let elsewhere: string;
let staff: { account: TestAccount; personId: string; browser: TestBrowser };
let editor: { account: TestAccount; personId: string; browser: TestBrowser };

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	bakery = (await install.createSite(workspaceId, { name: "Acme Bakery" })).id;
	florist = (await install.createSite(workspaceId, { name: "Acme Florist" })).id;
	elsewhere = (await install.createSite((await install.createWorkspace("Other Ltd")).id)).id;
	staff = await install.createStaff({ workspaces: [workspaceId], name: "Agency Anna" });
	editor = await install.createMember({ workspaceId, role: "editor", name: "Eddie Editor" });
});

afterAll(async () => {
	await install.close();
});

const DEFAULTS = { version: EDITOR_LAYOUT_VERSION, layout: null, formatOnLeave: false, hintSeen: false };

/** The layout of the frame `docking/02`: Layers moved to the left dock, the bottom dock a little higher. */
const MOVED: EditorLayout = {
	docks: {
		left: { share: 0.2, panels: [{ id: "layers" }] },
		right: { panels: [{ id: "inspector" }, { id: "entry", collapsed: true }] },
		bottom: { share: 0.35, panels: [{ id: "html" }, { id: "css", hidden: true }, { id: "js", share: 0.5 }] },
	},
};

/** A person's own browser, signed in afresh: another browser than the one they saved with. */
async function anotherBrowser(person: { account: TestAccount }): Promise<ApiClient> {
	return (await install.signIn(person.account)).api;
}

describe("saved and read back", () => {
	test("a person who never changed anything reads the defaults", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "author" });

		expect((await browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(DEFAULTS);
	});

	test("what the person saves comes back, on another Site and in another browser", async () => {
		const saved = await staff.browser.api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, layout: MOVED, formatOnLeave: true },
		});

		const expected = { version: EDITOR_LAYOUT_VERSION, layout: MOVED, formatOnLeave: true, hintSeen: false };
		expect(saved.preferences).toEqual(expected);
		const elsewhereApi = await anotherBrowser(staff);
		expect((await elsewhereApi.me.editorPreferences({ siteId: florist })).preferences).toEqual(expected);
	});

	test("a save keeps what it leaves out, and a null layout goes back to the defaults", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "editor" });
		const api = browser.api;
		await api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, layout: MOVED, formatOnLeave: true },
		});

		// Another tab marks the first-visit card seen: the layout and the switch stay.
		await api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
		});
		expect((await api.me.editorPreferences({ siteId: bakery })).preferences).toEqual({
			version: EDITOR_LAYOUT_VERSION,
			layout: MOVED,
			formatOnLeave: true,
			hintSeen: true,
		});

		// "Reset panel layout".
		const reset = await api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, layout: null },
		});
		expect(reset.preferences).toEqual({ ...DEFAULTS, formatOnLeave: true, hintSeen: true });
	});

	test("two saves at once each keep what the other changed", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "editor" });
		const api = browser.api;

		await Promise.all([
			api.me.saveEditorPreferences({ siteId: bakery, preferences: { version: EDITOR_LAYOUT_VERSION, layout: MOVED } }),
			api.me.saveEditorPreferences({
				siteId: bakery,
				preferences: { version: EDITOR_LAYOUT_VERSION, formatOnLeave: true },
			}),
			api.me.saveEditorPreferences({ siteId: bakery, preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true } }),
		]);

		expect((await api.me.editorPreferences({ siteId: bakery })).preferences).toEqual({
			version: EDITOR_LAYOUT_VERSION,
			layout: MOVED,
			formatOnLeave: true,
			hintSeen: true,
		});
	});
});

describe("the person's own only", () => {
	test("one person's preferences are never another's", async () => {
		await staff.browser.api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, layout: MOVED, formatOnLeave: true },
		});

		expect((await editor.browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(DEFAULTS);
	});

	test("naming another person changes only the caller's own", async () => {
		const { personId, browser } = await install.createMember({ workspaceId, role: "owner" });
		const theirs = (await browser.api.me.editorPreferences({ siteId: bakery })).preferences;

		await editor.browser.api.me.saveEditorPreferences({
			siteId: bakery,
			// @ts-expect-error: the procedure takes no person; the person is whoever is signed in.
			personId,
			preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
		});

		expect((await browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(theirs);
		expect((await editor.browser.api.me.editorPreferences({ siteId: bakery })).preferences.hintSeen).toBe(true);
	});

	test("the Site named must be one the person edits", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "editor" });

		await expect(browser.api.me.editorPreferences({ siteId: elsewhere })).rejects.toMatchObject({ status: 404 });
		await expect(
			browser.api.me.saveEditorPreferences({
				siteId: elsewhere,
				preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
			}),
		).rejects.toMatchObject({ status: 404 });
		expect((await browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(DEFAULTS);
	});

	test("signed out, nothing answers", async () => {
		await expect(install.browser().api.me.editorPreferences({ siteId: bakery })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	test("an impersonator reads them but can't change them", async () => {
		const member = await install.createMember({ workspaceId, role: "owner" });
		const saved = await member.browser.api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, layout: MOVED },
		});
		const anna = await withSecondFactor(install, await install.createStaff({ workspaces: [workspaceId] }));
		await impersonate(anna.browser, member.personId);

		expect((await anna.browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(saved.preferences);
		await expect(
			anna.browser.api.me.saveEditorPreferences({
				siteId: bakery,
				preferences: { version: EDITOR_LAYOUT_VERSION, layout: null, formatOnLeave: true },
			}),
		).rejects.toMatchObject({ code: "NOT_WHILE_IMPERSONATING", data: { what: "preferences" } });
		expect((await member.browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(saved.preferences);
	});
});

describe("the shape", () => {
	/** Changes that aren't editor preferences, each refused. */
	const REFUSED: Record<string, unknown> = {
		"no version": { formatOnLeave: true },
		"a version newer than this build's": { version: EDITOR_LAYOUT_VERSION + 1, formatOnLeave: true },
		"a key it doesn't know": { version: EDITOR_LAYOUT_VERSION, theme: "dark" },
		"a switch that isn't on or off": { version: EDITOR_LAYOUT_VERSION, formatOnLeave: "yes" },
		"a dock it doesn't know": {
			version: EDITOR_LAYOUT_VERSION,
			layout: { docks: { ...MOVED.docks, top: { panels: [] } } },
		},
		"a dock missing": { version: EDITOR_LAYOUT_VERSION, layout: { docks: { left: MOVED.docks.left } } },
		"a panel with a key it doesn't know": {
			version: EDITOR_LAYOUT_VERSION,
			layout: { docks: { ...MOVED.docks, left: { panels: [{ id: "layers", floating: true }] } } },
		},
		"a panel key that isn't one": {
			version: EDITOR_LAYOUT_VERSION,
			layout: { docks: { ...MOVED.docks, left: { panels: [{ id: "<script>" }] } } },
		},
		"a panel in two docks": {
			version: EDITOR_LAYOUT_VERSION,
			layout: { docks: { ...MOVED.docks, left: { panels: [{ id: "inspector" }] } } },
		},
		"a dock larger than the window": {
			version: EDITOR_LAYOUT_VERSION,
			layout: { docks: { ...MOVED.docks, left: { share: 1.5, panels: [{ id: "layers" }] } } },
		},
		"a dock of no size": {
			version: EDITOR_LAYOUT_VERSION,
			layout: { docks: { ...MOVED.docks, left: { share: 0, panels: [{ id: "layers" }] } } },
		},
		"a layout that is a list": { version: EDITOR_LAYOUT_VERSION, layout: [] },
	};

	for (const [name, preferences] of Object.entries(REFUSED)) {
		test(`refused: ${name}`, async () => {
			const { browser } = await install.createMember({ workspaceId, role: "editor" });

			await expect(
				browser.api.me.saveEditorPreferences({
					siteId: bakery,
					preferences: preferences as Parameters<ApiClient["me"]["saveEditorPreferences"]>[0]["preferences"],
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect((await browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(DEFAULTS);
		});
	}

	test(`refused above ${EDITOR_PREFERENCES_MAX_BYTES} bytes, nothing saved`, async () => {
		const { browser } = await install.createMember({ workspaceId, role: "editor" });
		// 60 panels (within the count) with long keys: a valid shape, too large.
		const panels = Array.from({ length: 60 }, (_, index) => ({
			id: `m.${"module".repeat(8)}.panel-${index}`,
			collapsed: true,
			hidden: true,
			share: 0.333_333_333_333_333,
		}));
		const layout = { docks: { left: { panels }, right: { panels: [] }, bottom: { panels: [] } } };
		expect(new TextEncoder().encode(JSON.stringify(layout)).length).toBeGreaterThan(EDITOR_PREFERENCES_MAX_BYTES);

		await expect(
			browser.api.me.saveEditorPreferences({ siteId: bakery, preferences: { version: EDITOR_LAYOUT_VERSION, layout } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(DEFAULTS);

		// The same panels, few enough bytes: saved.
		const fewer = { ...layout, docks: { ...layout.docks, left: { panels: panels.slice(0, 20) } } };
		await expect(
			browser.api.me.saveEditorPreferences({
				siteId: bakery,
				preferences: { version: EDITOR_LAYOUT_VERSION, layout: fewer },
			}),
		).resolves.toMatchObject({ preferences: { layout: fewer } });
	});
});

describe("a layout from an older version", () => {
	test("saved by an older building area, it is reset and the rest of the change kept", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "editor" });
		await browser.api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION, layout: MOVED },
		});

		// An older shape, as a tab still running an older building area sends it.
		const saved = await browser.api.me.saveEditorPreferences({
			siteId: bakery,
			preferences: { version: EDITOR_LAYOUT_VERSION - 1, layout: { panels: ["layers"] }, hintSeen: true },
		});

		expect(saved.preferences).toEqual({ ...DEFAULTS, hintSeen: true });
		expect((await browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(saved.preferences);
	});

	test("stored by an older release, it reads as the defaults, and saving the rest doesn't bring it back", async () => {
		const member = await install.createMember({ workspaceId, role: "editor" });
		const api = member.browser.api;
		const database = new pg.Client({ connectionString: install.databaseUrl });
		await database.connect();
		try {
			await database.query("update people set editor_preferences = $1 where id = $2", [
				{ version: EDITOR_LAYOUT_VERSION - 1, layout: { panels: ["layers"] }, formatOnLeave: true },
				member.personId,
			]);

			expect((await api.me.editorPreferences({ siteId: bakery })).preferences).toEqual({
				...DEFAULTS,
				formatOnLeave: true,
			});

			await api.me.saveEditorPreferences({
				siteId: bakery,
				preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
			});
			const { rows } = await database.query<{ editor_preferences: unknown }>(
				"select editor_preferences from people where id = $1",
				[member.personId],
			);
			expect(rows[0]?.editor_preferences).toEqual({
				version: EDITOR_LAYOUT_VERSION,
				formatOnLeave: true,
				hintSeen: true,
			});
		} finally {
			await database.end();
		}
	});

	test("stored in a shape this version no longer takes, it reads as the defaults", async () => {
		const member = await install.createMember({ workspaceId, role: "editor" });
		const database = new pg.Client({ connectionString: install.databaseUrl });
		await database.connect();
		try {
			await database.query("update people set editor_preferences = $1 where id = $2", [
				{ version: EDITOR_LAYOUT_VERSION, layout: { docks: { left: "wide" } }, hintSeen: "yes" },
				member.personId,
			]);
		} finally {
			await database.end();
		}

		expect((await member.browser.api.me.editorPreferences({ siteId: bakery })).preferences).toEqual(DEFAULTS);
	});
});
