import type { Database } from "@webcraft/db";
import { errorGroupPlaces, errorGroups, people, sites, workspaces } from "@webcraft/db/schema";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { type LogContext, type Logger, withoutLogContext } from "../log.ts";
import { redactText } from "../redaction.ts";
import type { InstallScope } from "../tenancy/data-layer.ts";
import { fingerprintOf } from "./fingerprint.ts";

/**
 * The Error log (`GLOSSARY.md`): unexpected failures on the Install, grouped by cause, kept 30 days,
 * read by the Superadmin only.
 *
 * A failure is noted in memory (`capture`, which never waits and never throws) and written with the
 * others of its cause at most every `FLUSH_DELAY_MS`: a storm of one failure costs one write per cause
 * every few seconds, never one per failure. At most `MAX_PENDING_CAUSES` causes and `MAX_PLACES` places
 * per cause wait at a time; the rest is counted as dropped and said in the process's log.
 */

/** How long a failure waits in memory before it is written with the others of its cause. */
export const FLUSH_DELAY_MS = 5_000;

/** The most causes waiting to be written at once; failures of further causes are dropped (and logged). */
export const MAX_PENDING_CAUSES = 50;

/** The most Workspaces and Sites one cause keeps for each write. */
const MAX_PLACES = 20;

/** How long the Error log keeps a cause after it was last seen. */
export const ERROR_LOG_DAYS = 30;

const MESSAGE_LENGTH = 1_000;
const STACK_LENGTH = 6_000;

/** Where a failure happened: a request (its procedure, or method and path), a job, or the process. */
export type ErrorSource = { kind: "request" | "job" | "process"; name: string | null };

/** A cause in the Error log, as the Superadmin reads it. */
export type ErrorGroup = {
	id: string;
	name: string;
	message: string;
	source: ErrorSource;
	/** The newest example's request id, to find its lines in the process's log. */
	requestId: string | null;
	count: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	resolvedAt: Date | null;
	resolvedBy: { id: string; name: string } | null;
	reopenedAt: Date | null;
	/** The Workspaces and Sites it happened in, most often first. */
	places: ErrorPlace[];
};

export type ErrorPlace = {
	workspace: { id: string; name: string };
	site: { id: string; name: string } | null;
	count: number;
	lastSeenAt: Date;
};

/** A cause with its newest example's stack. */
export type ErrorGroupDetail = ErrorGroup & { stack: string | null };

/** Which causes to list: those not marked resolved (the default), those marked resolved, or all. */
export type ErrorLogState = "open" | "resolved" | "all";

export type ErrorLog = {
	/** Notes an unexpected failure, where the current work is (the log context). Never waits or throws. */
	capture(error: Error, at: { source: ErrorSource; context: LogContext }): void;
	/** Writes every failure noted so far. Reads do this first. */
	flush(): Promise<void>;
	/** A page of causes, the most recently seen first; `after` is the `next` of the page before. */
	list(
		scope: InstallScope,
		query: { state: ErrorLogState; limit: number; after?: string },
	): Promise<{
		groups: ErrorGroup[];
		next: string | null;
	}>;
	/** One cause with its stack; `ErrorGroupNotFoundError` when there is none. */
	get(scope: InstallScope, groupId: string): Promise<ErrorGroupDetail>;
	/** Marks a cause resolved (recorded in the Audit log); it opens again when it happens again. */
	resolve(scope: InstallScope, groupId: string): Promise<ErrorGroup>;
	/** How many causes were first seen since `since`, and aren't marked resolved. */
	newSince(since: Date): Promise<number>;
	/** Deletes causes not seen for `ERROR_LOG_DAYS`; answers how many. */
	prune(): Promise<number>;
};

/** There is no such cause in the Error log. */
export class ErrorGroupNotFoundError extends Error {
	override name = "ErrorGroupNotFoundError";
	constructor() {
		super("There is no such failure in the Error log: it may have been deleted after 30 days.");
	}
}

type Pending = {
	error: Error;
	source: ErrorSource;
	requestId: string | null;
	count: number;
	firstAt: Date;
	lastAt: Date;
	places: Map<string, { workspaceId: string; siteId: string | null; count: number; lastAt: Date }>;
};

export function createErrorLog(deps: {
	database: Database;
	clock: Clock;
	/** Where the Error log says what went wrong with itself; never at error level, which feeds it. */
	log: Logger;
	/** Told of every failure as it is noted (an error tracker's DSN), besides being written here. */
	onCapture?: (error: Error, at: { source: ErrorSource; context: LogContext; fingerprint: string }) => void;
}): ErrorLog {
	const { database, clock, log } = deps;
	const { db } = database;
	const pending = new Map<string, Pending>();
	let dropped = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let writing: Promise<void> = Promise.resolve();

	const write = async () => {
		if (timer) clearTimeout(timer);
		timer = null;
		const batch = [...pending.entries()];
		pending.clear();
		const lost = dropped;
		dropped = 0;
		if (lost > 0) log.warn("Failures of more causes than the Error log takes at once were dropped", { dropped: lost });
		for (const [fingerprint, cause] of batch) {
			try {
				await writeCause(db, fingerprint, cause);
			} catch (error) {
				log.warn("A failure couldn't be written to the Error log", { error, failures: cause.count });
			}
		}
	};
	const flush = (): Promise<void> => {
		// Its own lines name no request: writing the Error log is the process's own work.
		writing = writing.then(() => withoutLogContext(write));
		return writing;
	};

	return {
		capture(error, { source, context }) {
			try {
				const fingerprint = fingerprintOf(error);
				const now = clock.now();
				let cause = pending.get(fingerprint);
				if (!cause) {
					if (pending.size >= MAX_PENDING_CAUSES) {
						dropped++;
						return;
					}
					cause = { error, source, requestId: null, count: 0, firstAt: now, lastAt: now, places: new Map() };
					pending.set(fingerprint, cause);
				}
				cause.error = error;
				cause.source = source;
				cause.requestId = context.requestId ?? null;
				cause.count++;
				cause.lastAt = now;
				if (context.workspaceId) {
					const key = `${context.workspaceId}/${context.siteId ?? ""}`;
					const place = cause.places.get(key);
					if (place) {
						place.count++;
						place.lastAt = now;
					} else if (cause.places.size < MAX_PLACES) {
						cause.places.set(key, {
							workspaceId: context.workspaceId,
							siteId: context.siteId ?? null,
							count: 1,
							lastAt: now,
						});
					}
				}
				deps.onCapture?.(error, { source, context, fingerprint });
				if (!timer) {
					timer = setTimeout(() => void flush().catch(() => {}), FLUSH_DELAY_MS);
					timer.unref?.();
				}
			} catch {
				// Noting a failure must never become one.
			}
		},

		flush,

		async list(scope, { state, limit, after }) {
			await flush();
			const conditions: SQL[] = [];
			if (state === "open") conditions.push(isNull(errorGroups.resolvedAt));
			if (state === "resolved") conditions.push(isNotNull(errorGroups.resolvedAt));
			const cursor = after ? parseCursor(after) : null;
			if (cursor) {
				conditions.push(
					or(
						lt(errorGroups.lastSeenAt, cursor.at),
						and(eq(errorGroups.lastSeenAt, cursor.at), lt(errorGroups.id, cursor.id)),
					) as SQL,
				);
			}
			const rows = await scope.db
				.select(groupColumns)
				.from(errorGroups)
				.leftJoin(people, eq(people.id, errorGroups.resolvedBy))
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(desc(errorGroups.lastSeenAt), desc(errorGroups.id))
				.limit(limit + 1);
			const page = rows.slice(0, limit);
			const places = await placesOf(
				scope,
				page.map((row) => row.id),
				10,
			);
			const last = page.at(-1);
			return {
				groups: page.map((row) => groupOf(row, places.get(row.id) ?? [])),
				next: rows.length > limit && last ? `${last.lastSeenAt.toISOString()}_${last.id}` : null,
			};
		},

		async get(scope, groupId) {
			await flush();
			const [row] = await scope.db
				.select({ ...groupColumns, stack: errorGroups.stack })
				.from(errorGroups)
				.leftJoin(people, eq(people.id, errorGroups.resolvedBy))
				.where(eq(errorGroups.id, groupId));
			if (!row) throw new ErrorGroupNotFoundError();
			const places = await placesOf(scope, [row.id], MAX_PLACES * 5);
			return { ...groupOf(row, places.get(row.id) ?? []), stack: row.stack };
		},

		async resolve(scope, groupId) {
			await flush();
			const now = scope.now();
			const personId = scope.access.actor.kind === "person" ? scope.access.actor.personId : null;
			return scope.transaction(async (tx) => {
				const [row] = await tx.db
					.update(errorGroups)
					.set({ resolvedAt: now, resolvedBy: personId })
					.where(eq(errorGroups.id, groupId))
					.returning({ id: errorGroups.id, name: errorGroups.name, count: errorGroups.count });
				if (!row) throw new ErrorGroupNotFoundError();
				await tx.audit("errorLog.resolve", { groupId: row.id, name: row.name, count: row.count });
				const [resolved] = await tx.db
					.select(groupColumns)
					.from(errorGroups)
					.leftJoin(people, eq(people.id, errorGroups.resolvedBy))
					.where(eq(errorGroups.id, groupId));
				if (!resolved) throw new ErrorGroupNotFoundError();
				const places = await placesOf(tx, [groupId], 10);
				return groupOf(resolved, places.get(groupId) ?? []);
			});
		},

		async newSince(since) {
			await flush();
			const [row] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(errorGroups)
				.where(and(gte(errorGroups.firstSeenAt, since), isNull(errorGroups.resolvedAt)));
			return row?.count ?? 0;
		},

		async prune() {
			await flush();
			const before = new Date(clock.now().getTime() - ERROR_LOG_DAYS * 24 * 60 * 60_000);
			const removed = await db
				.delete(errorGroups)
				.where(lt(errorGroups.lastSeenAt, before))
				.returning({ id: errorGroups.id });
			return removed.length;
		},
	};
}

/** Writes one cause's failures: added to its row (made if new, opened again if it was resolved) and its places. */
async function writeCause(db: Database["db"], fingerprint: string, cause: Pending): Promise<void> {
	const { error, source } = cause;
	const message = redactText(error.message || error.name).slice(0, MESSAGE_LENGTH);
	const stack = error.stack ? redactText(error.stack).slice(0, STACK_LENGTH) : null;
	await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(errorGroups)
			.values({
				fingerprint,
				name: error.name.slice(0, 200),
				message,
				stack,
				sourceKind: source.kind,
				sourceName: source.name?.slice(0, 500) ?? null,
				requestId: cause.requestId,
				count: cause.count,
				firstSeenAt: cause.firstAt,
				lastSeenAt: cause.lastAt,
			})
			.onConflictDoUpdate({
				target: errorGroups.fingerprint,
				set: {
					name: sql`excluded.name`,
					message: sql`excluded.message`,
					stack: sql`excluded.stack`,
					sourceKind: sql`excluded.source_kind`,
					sourceName: sql`excluded.source_name`,
					requestId: sql`excluded.request_id`,
					count: sql`${errorGroups.count} + excluded.count`,
					firstSeenAt: sql`least(${errorGroups.firstSeenAt}, excluded.first_seen_at)`,
					lastSeenAt: sql`greatest(${errorGroups.lastSeenAt}, excluded.last_seen_at)`,
					// It happened again: a cause marked resolved opens again.
					reopenedAt: sql`case when ${errorGroups.resolvedAt} is not null then excluded.last_seen_at else ${errorGroups.reopenedAt} end`,
					resolvedAt: sql`null`,
					resolvedBy: sql`null`,
				},
			})
			.returning({ id: errorGroups.id });
		if (!row) return;
		for (const place of cause.places.values()) {
			// A Workspace or Site deleted meanwhile has no place to be named in.
			await tx.execute(sql`
				insert into ${errorGroupPlaces} (group_id, workspace_id, site_id, count, last_seen_at)
				select ${row.id}, w.id, s.id, ${place.count}, ${place.lastAt}
				from ${workspaces} w left join ${sites} s on s.id = ${place.siteId} and s.workspace_id = w.id
				where w.id = ${place.workspaceId} and (${place.siteId}::uuid is null or s.id is not null)
				on conflict on constraint error_group_places_place_key do update
					set count = ${errorGroupPlaces}.count + excluded.count,
						last_seen_at = greatest(${errorGroupPlaces}.last_seen_at, excluded.last_seen_at)`);
		}
	});
}

const groupColumns = {
	id: errorGroups.id,
	name: errorGroups.name,
	message: errorGroups.message,
	sourceKind: errorGroups.sourceKind,
	sourceName: errorGroups.sourceName,
	requestId: errorGroups.requestId,
	count: errorGroups.count,
	firstSeenAt: errorGroups.firstSeenAt,
	lastSeenAt: errorGroups.lastSeenAt,
	resolvedAt: errorGroups.resolvedAt,
	resolvedById: errorGroups.resolvedBy,
	resolvedByName: people.name,
	reopenedAt: errorGroups.reopenedAt,
};

type GroupRow = {
	id: string;
	name: string;
	message: string;
	sourceKind: string;
	sourceName: string | null;
	requestId: string | null;
	count: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	resolvedAt: Date | null;
	resolvedById: string | null;
	resolvedByName: string | null;
	reopenedAt: Date | null;
};

function groupOf(row: GroupRow, places: ErrorPlace[]): ErrorGroup {
	return {
		id: row.id,
		name: row.name,
		message: row.message,
		source: { kind: row.sourceKind as ErrorSource["kind"], name: row.sourceName },
		requestId: row.requestId,
		count: Number(row.count),
		firstSeenAt: row.firstSeenAt,
		lastSeenAt: row.lastSeenAt,
		resolvedAt: row.resolvedAt,
		resolvedBy: row.resolvedById ? { id: row.resolvedById, name: row.resolvedByName ?? "" } : null,
		reopenedAt: row.reopenedAt,
		places,
	};
}

/** The places of each cause, most often first, at most `perGroup` each. */
async function placesOf(
	scope: Pick<InstallScope, "db">,
	groupIds: readonly string[],
	perGroup: number,
): Promise<Map<string, ErrorPlace[]>> {
	const found = new Map<string, ErrorPlace[]>();
	if (groupIds.length === 0) return found;
	const rows = await scope.db
		.select({
			groupId: errorGroupPlaces.groupId,
			workspaceId: workspaces.id,
			workspaceName: workspaces.name,
			siteId: sites.id,
			siteName: sites.name,
			count: errorGroupPlaces.count,
			lastSeenAt: errorGroupPlaces.lastSeenAt,
		})
		.from(errorGroupPlaces)
		.innerJoin(workspaces, eq(workspaces.id, errorGroupPlaces.workspaceId))
		.leftJoin(sites, eq(sites.id, errorGroupPlaces.siteId))
		.where(inArray(errorGroupPlaces.groupId, [...groupIds]))
		.orderBy(desc(errorGroupPlaces.count), desc(errorGroupPlaces.lastSeenAt));
	for (const row of rows) {
		const list = found.get(row.groupId) ?? [];
		if (list.length >= perGroup) continue;
		list.push({
			workspace: { id: row.workspaceId, name: row.workspaceName },
			site: row.siteId ? { id: row.siteId, name: row.siteName ?? "" } : null,
			count: Number(row.count),
			lastSeenAt: row.lastSeenAt,
		});
		found.set(row.groupId, list);
	}
	return found;
}

function parseCursor(after: string): { at: Date; id: string } | null {
	const [at, id] = after.split("_");
	const date = new Date(at ?? "");
	return id && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}
