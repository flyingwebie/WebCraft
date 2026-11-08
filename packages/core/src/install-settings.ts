import type { Database, Transaction } from "@webcraft/db";
import { installSettings } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { type AdminLanguageCode, DEFAULT_ADMIN_LANGUAGE, isAdminLanguage } from "./admin-languages.ts";

/** The Install-wide settings people see in Install settings › General. */
export type InstallSettingsValues = {
	/** The agency's name for this Install, or null when nobody has set one. */
	name: string | null;
	defaultAdminLanguage: AdminLanguageCode;
};

export type InstallSettings = {
	read(): Promise<InstallSettingsValues>;
	/** Changes the given settings and answers all of them. */
	update(changes: Partial<InstallSettingsValues>): Promise<InstallSettingsValues>;
};

/** The longest Install name, in characters. */
export const INSTALL_NAME_MAX_LENGTH = 80;

const ROW_ID = 1;

type Executor = Database["db"] | Transaction;

type Row = typeof installSettings.$inferSelect;

/** The settings row, or null before anything was ever saved. */
export async function readSettingsRow(executor: Executor): Promise<Row | null> {
	const [row] = await executor.select().from(installSettings).where(eq(installSettings.id, ROW_ID));
	return row ?? null;
}

/** Writes some columns of the settings row, creating it with defaults the first time. */
export async function writeSettingsRow(
	executor: Executor,
	values: Partial<Omit<typeof installSettings.$inferInsert, "id">>,
): Promise<void> {
	await executor
		.insert(installSettings)
		.values({ id: ROW_ID, ...values })
		.onConflictDoUpdate({ target: installSettings.id, set: values });
}

export function createInstallSettings(database: Database): InstallSettings {
	const read = async (): Promise<InstallSettingsValues> => {
		const row = await readSettingsRow(database.db);
		const language = row?.defaultAdminLanguage ?? DEFAULT_ADMIN_LANGUAGE;
		return {
			name: row?.name ?? null,
			defaultAdminLanguage: isAdminLanguage(language) ? language : DEFAULT_ADMIN_LANGUAGE,
		};
	};
	return {
		read,
		async update(changes) {
			const values: Partial<Row> = {};
			if (changes.name !== undefined) values.name = changes.name?.trim() || null;
			if (changes.defaultAdminLanguage !== undefined) values.defaultAdminLanguage = changes.defaultAdminLanguage;
			if (Object.keys(values).length > 0) await writeSettingsRow(database.db, values);
			return read();
		},
	};
}
