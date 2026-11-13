import type { Database, Transaction } from "@webcraft/db";

import { readSettingsRow, writeSettingsRow } from "../install-settings.ts";
import type { InstallScope } from "../tenancy/data-layer.ts";

type Executor = Database["db"] | Transaction;

/**
 * Install settings › Revisions: whether publishing saves Revisions anywhere on the Install, and how
 * long Revisions and Checkpoints are kept. A Revision goes once it is older than `revisionDays` and
 * isn't among its item's newest `revisionsKept` (whichever keeps more); a Checkpoint once it is older
 * than `checkpointDays`. Turning Revisions off stops new ones; those saved before follow the same rules.
 */
export type HistorySettings = {
	revisionsOn: boolean;
	revisionDays: number;
	revisionsKept: number;
	checkpointDays: number;
};

/** The defaults, and the range the Superadmin may choose from. */
export const HISTORY_LIMITS = {
	revisionDays: { default: 90, min: 1, max: 3650 },
	revisionsKept: { default: 50, min: 0, max: 1000 },
	checkpointDays: { default: 30, min: 1, max: 365 },
} as const;

/** The Install's history settings, with the defaults for those nobody set. */
export async function readHistorySettings(executor: Executor): Promise<HistorySettings> {
	const row = await readSettingsRow(executor);
	return {
		revisionsOn: row?.revisionsOn ?? true,
		revisionDays: row?.revisionDays ?? HISTORY_LIMITS.revisionDays.default,
		revisionsKept: row?.revisionsKept ?? HISTORY_LIMITS.revisionsKept.default,
		checkpointDays: row?.checkpointDays ?? HISTORY_LIMITS.checkpointDays.default,
	};
}

/**
 * Changes the given settings (open the Install with `install.manage`), each within `HISTORY_LIMITS`,
 * and records it in the Audit log (`historySettings.change`). Answers all of them.
 */
export async function changeHistorySettings(
	scope: InstallScope,
	changes: Partial<HistorySettings>,
): Promise<HistorySettings> {
	for (const key of ["revisionDays", "revisionsKept", "checkpointDays"] as const) {
		const value = changes[key];
		const { min, max } = HISTORY_LIMITS[key];
		if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
			throw new RangeError(`${key} must be a whole number from ${min} to ${max}.`);
		}
	}
	return scope.transaction(async (tx) => {
		const before = await readHistorySettings(tx.db);
		const after = { ...before, ...changes };
		await writeSettingsRow(tx.db, after);
		const changed = Object.fromEntries(
			(Object.keys(after) as (keyof HistorySettings)[])
				.filter((key) => after[key] !== before[key])
				.map((key) => [key, { from: before[key], to: after[key] }]),
		);
		if (Object.keys(changed).length > 0) await tx.audit("historySettings.change", changed);
		return after;
	});
}
