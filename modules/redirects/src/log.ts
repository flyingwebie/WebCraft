import { desc, eq, lt, type ModuleContext, ModuleError, type PageMiss } from "@webcraft/module-sdk";

import { MAX_PATH_LENGTH } from "./paths.ts";
import { misses } from "./tables.ts";

/** The most paths the 404 log keeps per Site: the most recently seen. */
export const MAX_LOGGED_PATHS = 1000;
/** How many more it lets in before trimming back, so it isn't trimmed on every miss. */
const TRIM_SLACK = 100;
/** How long the 404 log keeps a path after it was last asked for. */
export const LOG_KEPT_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

type MissRow = typeof misses.$inferSelect;

/** A path of the 404 log, as the Module's procedures answer it. */
export type MissView = {
	id: string;
	path: string;
	language: string;
	hits: number;
	firstSeen: Date;
	lastSeen: Date;
	referrerHost: string | null;
	ignored: boolean;
};

export function missView(row: MissRow): MissView {
	return {
		id: row.id,
		path: row.path,
		language: row.language,
		hits: row.hits,
		firstSeen: row.firstSeen,
		lastSeen: row.lastSeen,
		referrerHost: row.referrerHost,
		ignored: row.ignored,
	};
}

/**
 * Keeps one batch of a Site's misses: each path's count, when it was first and last asked for, and
 * the host of the last page that linked there. Past `MAX_LOGGED_PATHS` paths, those seen longest ago
 * go first.
 */
export async function recordMisses(context: ModuleContext, batch: readonly PageMiss[]): Promise<void> {
	await context.transaction(async (tx) => {
		for (const miss of batch) {
			if (miss.path.length > MAX_PATH_LENGTH || miss.hits < 1) continue;
			const row = await tx.data.first(misses, eq(misses.path, miss.path));
			if (!row) {
				await tx.data.insert(misses, {
					path: miss.path,
					language: miss.language,
					hits: miss.hits,
					firstSeen: miss.firstAt,
					lastSeen: miss.lastAt,
					referrerHost: miss.referrerHost,
					ignored: false,
				});
				continue;
			}
			const later = miss.lastAt >= row.lastSeen;
			await tx.data.update(
				misses,
				{
					hits: row.hits + miss.hits,
					firstSeen: new Date(Math.min(miss.firstAt.getTime(), row.firstSeen.getTime())),
					lastSeen: later ? miss.lastAt : row.lastSeen,
					language: later ? miss.language : row.language,
					referrerHost: later && miss.referrerHost !== null ? miss.referrerHost : row.referrerHost,
				},
				eq(misses.id, row.id),
			);
		}
		if ((await tx.data.count(misses)) <= MAX_LOGGED_PATHS + TRIM_SLACK) return;
		const kept = await tx.data.select(misses, undefined, { orderBy: [desc(misses.lastSeen)], limit: MAX_LOGGED_PATHS });
		const oldest = kept.at(-1);
		if (oldest) await tx.data.delete(misses, lt(misses.lastSeen, oldest.lastSeen));
	});
}

/** Deletes the paths nobody asked for in `LOG_KEPT_DAYS` days. */
export async function purgeMisses(context: ModuleContext): Promise<number> {
	const before = new Date(context.now().getTime() - LOG_KEPT_DAYS * DAY_MS);
	return context.data.delete(misses, lt(misses.lastSeen, before));
}

/** Hides a path from the 404 log's list, or shows it again. */
export async function ignoreMiss(context: ModuleContext, missId: string, ignored: boolean): Promise<MissView> {
	return context.transaction(async (tx) => {
		const [row] = await tx.data.update(misses, { ignored }, eq(misses.id, missId));
		if (!row) throw new ModuleError("MISS_NOT_FOUND", "That path is no longer in the 404 log.", 404);
		await tx.audit(ignored ? "notFound.ignore" : "notFound.show", { path: row.path });
		return missView(row);
	});
}

/** The 404 log: its paths asked for most often first (then most recently), the ignored ones apart. */
export async function listMisses(context: ModuleContext, ignored: boolean, limit: number) {
	const where = eq(misses.ignored, ignored);
	const rows = await context.data.select(misses, where, {
		orderBy: [desc(misses.hits), desc(misses.lastSeen)],
		limit,
	});
	return { misses: rows.map(missView), total: await context.data.count(misses, where) };
}
