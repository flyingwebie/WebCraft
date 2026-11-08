import type { Database } from "@webcraft/db";
import { installRoles, people } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { AdminLanguageCode } from "./admin-languages.ts";
import { isAdminLanguage } from "./admin-languages.ts";

export const ADMIN_THEMES = ["system", "light", "dark"] as const;

/** Light or dark admin, or `system` to follow the device's setting. */
export type AdminTheme = (typeof ADMIN_THEMES)[number];

/** The Install-level role key of the Superadmin (ADR 0028). Staff get `staff`. */
export const SUPERADMIN_ROLE = "superadmin";

/** A person with an account on the Install, as the admin shows them. */
export type Person = {
	id: string;
	name: string;
	email: string;
	/** Their own Admin language, or null to follow the Install's default. */
	adminLanguage: AdminLanguageCode | null;
	adminTheme: AdminTheme;
	/** Their Install-level role key (`superadmin`), or null for people who hold none. */
	installRole: string | null;
};

export type PersonPreferences = {
	adminLanguage: AdminLanguageCode | null;
	adminTheme: AdminTheme;
};

export type People = {
	get(personId: string): Promise<Person | null>;
	/** Saves a person's own admin preferences and answers the person. */
	updatePreferences(personId: string, changes: Partial<PersonPreferences>): Promise<Person>;
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
	};
}

export function isAdminTheme(value: string): value is AdminTheme {
	return (ADMIN_THEMES as readonly string[]).includes(value);
}
