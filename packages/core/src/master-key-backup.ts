import type { Database } from "@webcraft/db";

import type { Clock } from "./clock.ts";
import { readSettingsRow, writeSettingsRow } from "./install-settings.ts";
import type { Logger } from "./log.ts";
import { personIdOf } from "./permissions/can.ts";
import type { InstallScope } from "./tenancy/data-layer.ts";

/**
 * Whether the Superadmin has confirmed that the Master key the Install runs with is stored outside
 * the server. Until they do, the admin shows them a banner. A confirmation is for one key: after a
 * rotation the banner asks again.
 */
export type MasterKeyBackup = {
	/** The running Master key's fingerprint: safe to show, never the key. */
	readonly fingerprint: string;
	status(): Promise<MasterKeyBackupStatus>;
	/**
	 * Records that the scope's person confirmed the running key is stored outside the server (open
	 * the Install with `install.manage` first), in the Audit log too, and logs it.
	 */
	confirmStored(scope: InstallScope): Promise<MasterKeyBackupStatus>;
};

export type MasterKeyBackupStatus = { stored: false } | { stored: true; confirmedAt: Date; confirmedBy: string | null };

export function createMasterKeyBackup(options: {
	database: Database;
	clock: Clock;
	log: Logger;
	fingerprint: string;
}): MasterKeyBackup {
	const { database, clock, log, fingerprint } = options;
	return {
		fingerprint,
		async status() {
			const row = await readSettingsRow(database.db);
			if (row?.masterKeyStoredFingerprint !== fingerprint || !row.masterKeyStoredAt) return { stored: false };
			return { stored: true, confirmedAt: row.masterKeyStoredAt, confirmedBy: row.masterKeyStoredBy };
		},
		async confirmStored(scope) {
			const personId = personIdOf(scope.access.actor);
			const confirmedAt = clock.now();
			await scope.transaction(async (tx) => {
				await writeSettingsRow(tx.db, {
					masterKeyStoredFingerprint: fingerprint,
					masterKeyStoredAt: confirmedAt,
					masterKeyStoredBy: personId,
				});
				await tx.audit("masterKey.confirmStored", { fingerprint });
			});
			log.info("The Superadmin confirmed the Master key is stored outside the server", {
				personId,
				masterKeyFingerprint: fingerprint,
			});
			return { stored: true, confirmedAt, confirmedBy: personId };
		},
	};
}
