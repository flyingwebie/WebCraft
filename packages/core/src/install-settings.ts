import type { Database, Transaction } from "@webcraft/db";
import { installSettings } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { type AdminLanguageCode, DEFAULT_ADMIN_LANGUAGE, isAdminLanguage } from "./admin-languages.ts";
import type { InstallScope } from "./tenancy/data-layer.ts";

/** The Install-wide settings people see in Install settings › General. */
export type InstallSettingsValues = {
	/** The agency's name for this Install, or null when nobody has set one. */
	name: string | null;
	defaultAdminLanguage: AdminLanguageCode;
};

/** The largest file the Media library takes: 50 MB unless the Superadmin sets another, from 1 MB to 1 GB. */
export const MEDIA_MAX_FILE_BYTES = { default: 50 * 1024 * 1024, min: 1024 * 1024, max: 1024 * 1024 * 1024 } as const;

/** Install settings › Storage: what the Media library takes. */
export type InstallMediaSettings = {
	/** The largest file an upload, a replacement or an import may be, in bytes. */
	maxFileBytes: number;
};

/** Install settings › Security. */
export type InstallSecuritySettings = {
	/** Whether new passwords are checked against leaked-password lists. */
	leakedPasswordCheck: boolean;
};

export type InstallSettings = {
	read(): Promise<InstallSettingsValues>;
	/** Changes the given settings and answers all of them. */
	update(changes: Partial<InstallSettingsValues>): Promise<InstallSettingsValues>;
	/** Install settings › Security. */
	security(): Promise<InstallSecuritySettings>;
	/**
	 * Switches the leaked-password check on or off, and records it in the Audit log. A Sensitive
	 * action (`leakedPasswordCheck.change`): open the Install with `install.manage` and check first.
	 */
	setLeakedPasswordCheck(scope: InstallScope, on: boolean): Promise<InstallSecuritySettings>;
	/** Install settings › Storage: the largest file the Media library takes. */
	media(): Promise<InstallMediaSettings>;
	/**
	 * Sets the largest file the Media library takes (`MEDIA_MAX_FILE_BYTES.min` to `.max`), and
	 * records it in the Audit log. Open the Install with `install.manage` first.
	 */
	setMediaMaxFileBytes(scope: InstallScope, bytes: number): Promise<InstallMediaSettings>;
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
	const security = async (): Promise<InstallSecuritySettings> => {
		const row = await readSettingsRow(database.db);
		return { leakedPasswordCheck: row?.leakedPasswordCheck ?? true };
	};
	const read = async (): Promise<InstallSettingsValues> => {
		const row = await readSettingsRow(database.db);
		const language = row?.defaultAdminLanguage ?? DEFAULT_ADMIN_LANGUAGE;
		return {
			name: row?.name ?? null,
			defaultAdminLanguage: isAdminLanguage(language) ? language : DEFAULT_ADMIN_LANGUAGE,
		};
	};
	const media = async (): Promise<InstallMediaSettings> => {
		const row = await readSettingsRow(database.db);
		return { maxFileBytes: row?.mediaMaxFileBytes ?? MEDIA_MAX_FILE_BYTES.default };
	};
	return {
		read,
		media,
		async setMediaMaxFileBytes(scope, bytes) {
			if (!Number.isInteger(bytes) || bytes < MEDIA_MAX_FILE_BYTES.min || bytes > MEDIA_MAX_FILE_BYTES.max) {
				throw new RangeError(
					`The largest file must be ${MEDIA_MAX_FILE_BYTES.min} to ${MEDIA_MAX_FILE_BYTES.max} bytes.`,
				);
			}
			await scope.transaction(async (tx) => {
				await writeSettingsRow(tx.db, { mediaMaxFileBytes: bytes });
				await tx.audit("mediaMaxFileSize.change", { maxFileBytes: bytes });
			});
			return media();
		},
		async update(changes) {
			const values: Partial<Row> = {};
			if (changes.name !== undefined) values.name = changes.name?.trim() || null;
			if (changes.defaultAdminLanguage !== undefined) values.defaultAdminLanguage = changes.defaultAdminLanguage;
			if (Object.keys(values).length > 0) await writeSettingsRow(database.db, values);
			return read();
		},
		security,
		async setLeakedPasswordCheck(scope, on) {
			await scope.transaction(async (tx) => {
				await writeSettingsRow(tx.db, { leakedPasswordCheck: on });
				await tx.audit("leakedPasswordCheck.change", { on });
			});
			return security();
		},
	};
}
