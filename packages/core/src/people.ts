import type { Database } from "@webcraft/db";
import { installRoles, people } from "@webcraft/db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AdminLanguageCode } from "./admin-languages.ts";
import { isAdminLanguage } from "./admin-languages.ts";

export const ADMIN_THEMES = ["system", "light", "dark"] as const;

/** Light or dark admin, or `system` to follow the device's setting. */
export type AdminTheme = (typeof ADMIN_THEMES)[number];

/** A person with an account on the Install, as the admin shows them. */
export type Person = {
	id: string;
	name: string;
	email: string;
	/** Their own Admin language, or null to follow the Install's default. */
	adminLanguage: AdminLanguageCode | null;
	adminTheme: AdminTheme;
	/** Their Install-level role key (`superadmin` or `staff`), or null for people who hold none. */
	installRole: string | null;
};

export type PersonPreferences = {
	adminLanguage: AdminLanguageCode | null;
	adminTheme: AdminTheme;
};

/**
 * The version of the building area's panel layout as it is stored. A layout saved with another
 * version reads as none (the defaults), and saving one from an older version resets it: raise it
 * whenever `editorLayoutSchema` changes in a way an older layout wouldn't fit.
 */
export const EDITOR_LAYOUT_VERSION = 1;

/** The most a change to a person's editor preferences may take, as JSON (UTF-8 bytes): about five times a full layout. */
export const EDITOR_PREFERENCES_MAX_BYTES = 4096;

/** The docks of the building area, where its panels go. */
export const EDITOR_DOCKS = ["left", "right", "bottom"] as const;

export type EditorDock = (typeof EDITOR_DOCKS)[number];

/** The most panels a layout places, in all its docks together. */
const MAX_PANELS = 64;

/** A share of the window or of a dock: more than nothing, at most all of it. */
const share = z.number().gt(0).max(1);

const panelPlacement = z.strictObject({
	/** The panel's key: `layers`, `inspector`, `entry`, `html`, or a Module's own, such as `m.forms.fields`. */
	id: z
		.string()
		.max(64)
		.regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
	/** Shown as its header only. */
	collapsed: z.boolean().optional(),
	/** Switched off in the Panels menu: it keeps its place for when it is switched on again. */
	hidden: z.boolean().optional(),
	/** Its share of the dock's length; the panels without one share what is left. */
	share: share.optional(),
});

const dock = z.strictObject({
	/** Its share of the window's width (left, right) or height (bottom); none for its default size. */
	share: share.optional(),
	/** Its panels, first to last (top to bottom, or left to right in the bottom dock). Empty: the dock is closed. */
	panels: z.array(panelPlacement).max(MAX_PANELS),
});

/**
 * Where the building area's panels are, as its docks draw them: each dock's size and its panels in
 * order, collapsed or switched off. A panel is in one dock at most.
 */
export const editorLayoutSchema = z
	.strictObject({ docks: z.strictObject({ left: dock, right: dock, bottom: dock }) })
	.refine((layout) => placedPanels(layout).length <= MAX_PANELS, { message: `At most ${MAX_PANELS} panels.` })
	.refine((layout) => new Set(placedPanels(layout)).size === placedPanels(layout).length, {
		message: "A panel is in one dock, once.",
	});

export type EditorLayout = z.infer<typeof editorLayoutSchema>;

/** How a person likes the building area, the same on every Site and in every browser. */
export type EditorPreferences = {
	/** `EDITOR_LAYOUT_VERSION`: the version this answer's layout is in. */
	version: number;
	/** Where their panels are; null for the defaults (they never moved one, reset them, or it was from an older version). */
	layout: EditorLayout | null;
	/** "Format when I leave the box" in the code boxes (off by default). */
	formatOnLeave: boolean;
	/** Whether they have seen, and closed, the building area's first-visit card. */
	hintSeen: boolean;
};

const flags = {
	formatOnLeave: z.boolean().optional(),
	hintSeen: z.boolean().optional(),
};

/**
 * A change to a person's editor preferences, as the building area saves it: what it names
 * replaces what was there, what it leaves out stays. `layout: null` resets the layout to the
 * defaults. `version` is the layout version the shell that sends it knows: one newer than this
 * build's is refused, an older one's layout is reset rather than kept (its other changes are
 * saved). Refused above `EDITOR_PREFERENCES_MAX_BYTES`.
 */
export const editorPreferencesChangeSchema = z
	.union([
		z.strictObject({
			version: z.literal(EDITOR_LAYOUT_VERSION),
			layout: editorLayoutSchema.nullable().optional(),
			...flags,
		}),
		z.strictObject({
			// 0: a layout from before the stored shape had a version.
			version: z.number().int().min(0).lt(EDITOR_LAYOUT_VERSION),
			/** Not read: an older layout is reset. */
			layout: z.unknown().optional(),
			...flags,
		}),
	])
	.refine((change) => jsonBytes(change) <= EDITOR_PREFERENCES_MAX_BYTES, {
		message: `Editor preferences take at most ${EDITOR_PREFERENCES_MAX_BYTES} bytes.`,
	});

export type EditorPreferencesChange = z.infer<typeof editorPreferencesChangeSchema>;

export type People = {
	get(personId: string): Promise<Person | null>;
	/** Saves a person's own admin preferences and answers the person. */
	updatePreferences(personId: string, changes: Partial<PersonPreferences>): Promise<Person>;
	/** A person's editor preferences, with the defaults for what they never set. */
	editorPreferences(personId: string): Promise<EditorPreferences>;
	/**
	 * Saves a change to a person's own editor preferences (`EditorPreferencesChange`, already
	 * checked) in one statement, so two tabs saving at once each keep what the other changed, and
	 * answers them as they now are.
	 */
	saveEditorPreferences(personId: string, change: EditorPreferencesChange): Promise<EditorPreferences>;
};

export function createPeople({ database, clock }: { database: Database; clock: { now(): Date } }): People {
	const { db } = database;
	const get = async (personId: string): Promise<Person | null> => {
		const [row] = await db
			.select({
				id: people.id,
				name: people.name,
				email: people.email,
				adminLanguage: people.adminLanguage,
				adminTheme: people.adminTheme,
				installRole: installRoles.role,
			})
			.from(people)
			.leftJoin(installRoles, eq(installRoles.personId, people.id))
			.where(eq(people.id, personId));
		if (!row) return null;
		return {
			...row,
			adminLanguage: row.adminLanguage && isAdminLanguage(row.adminLanguage) ? row.adminLanguage : null,
			adminTheme: isAdminTheme(row.adminTheme) ? row.adminTheme : "system",
		};
	};
	return {
		get,
		async updatePreferences(personId, changes) {
			const values: Partial<typeof people.$inferInsert> = { updatedAt: clock.now() };
			if (changes.adminLanguage !== undefined) values.adminLanguage = changes.adminLanguage;
			if (changes.adminTheme !== undefined) values.adminTheme = changes.adminTheme;
			await db.update(people).set(values).where(eq(people.id, personId));
			const person = await get(personId);
			if (!person) throw new Error(`No person ${personId}.`);
			return person;
		},
		async editorPreferences(personId) {
			const [row] = await db.select({ stored: people.editorPreferences }).from(people).where(eq(people.id, personId));
			if (!row) throw new Error(`No person ${personId}.`);
			return readEditorPreferences(row.stored);
		},
		async saveEditorPreferences(personId, change) {
			const current = change.version === EDITOR_LAYOUT_VERSION;
			const patch: Record<string, unknown> = { version: EDITOR_LAYOUT_VERSION };
			// Null is taken out after the merge: it removes the layout (the defaults).
			if (change.layout !== undefined) patch.layout = current ? change.layout : null;
			if (change.formatOnLeave !== undefined) patch.formatOnLeave = change.formatOnLeave;
			if (change.hintSeen !== undefined) patch.hintSeen = change.hintSeen;
			const stored = people.editorPreferences;
			// A stored layout of another version goes before the merge: kept, it would read as this version's.
			const [row] = await db
				.update(people)
				.set({
					editorPreferences: sql`jsonb_strip_nulls(
						(case when ${stored} -> 'version' = ${String(EDITOR_LAYOUT_VERSION)}::jsonb then ${stored} else ${stored} - 'layout' end)
						|| ${JSON.stringify(patch)}::jsonb
					)`,
					updatedAt: clock.now(),
				})
				.where(eq(people.id, personId))
				.returning({ stored });
			if (!row) throw new Error(`No person ${personId}.`);
			return readEditorPreferences(row.stored);
		},
	};
}

/**
 * Stored editor preferences as the building area reads them: a layout of another version, or one
 * that no longer fits, reads as none (the defaults); anything unknown is left out.
 */
function readEditorPreferences(stored: unknown): EditorPreferences {
	const value = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
	const layout =
		value.version === EDITOR_LAYOUT_VERSION && value.layout !== undefined
			? editorLayoutSchema.safeParse(value.layout)
			: null;
	return {
		version: EDITOR_LAYOUT_VERSION,
		layout: layout?.success ? layout.data : null,
		formatOnLeave: value.formatOnLeave === true,
		hintSeen: value.hintSeen === true,
	};
}

/** The keys of the panels a layout places, in every dock. */
function placedPanels(layout: { docks: Record<EditorDock, { panels: { id: string }[] }> }): string[] {
	return EDITOR_DOCKS.flatMap((side) => layout.docks[side].panels.map((panel) => panel.id));
}

function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function isAdminTheme(value: string): value is AdminTheme {
	return (ADMIN_THEMES as readonly string[]).includes(value);
}
