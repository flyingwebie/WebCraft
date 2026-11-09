/** A scheduled Backup that was written and not removed yet. */
export type KeptBackup<Target extends string = string> = { id: string; name: string; target: Target; at: Date };

/**
 * The keep rules for scheduled Backups: the newest Backup of each of the last `daily` days that
 * have one, and the newest of each of the last `weekly` weeks (Monday to Sunday, UTC) that have
 * one, are kept; a Backup can count for both, so 7 to 11 are kept. Answers the others, oldest first.
 */
export function backupsToRemove<Backup extends KeptBackup>(
	backups: readonly Backup[],
	keep: { daily: number; weekly: number },
): Backup[] {
	const newestFirst = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
	const kept = new Set<string>();
	const keepNewestPer = (period: (at: Date) => string, count: number) => {
		const seen = new Set<string>();
		for (const backup of newestFirst) {
			const key = period(backup.at);
			if (seen.has(key)) continue;
			if (seen.size === count) break;
			seen.add(key);
			kept.add(backup.id);
		}
	};
	keepNewestPer((at) => at.toISOString().slice(0, 10), keep.daily);
	keepNewestPer(weekOf, keep.weekly);
	return newestFirst.filter((backup) => !kept.has(backup.id)).reverse();
}

/** The Monday (UTC) a moment's week starts on. */
function weekOf(at: Date): string {
	const day = (at.getUTCDay() + 6) % 7;
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - day)).toISOString().slice(0, 10);
}
