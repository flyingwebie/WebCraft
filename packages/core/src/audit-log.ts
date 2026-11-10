import type { Database } from "@webcraft/db";
import { auditLog, people, sites, workspaces } from "@webcraft/db/schema";
import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { type AuditEntry, type AuditViaKind, viaOf } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { csvCell } from "./dashboards/csv.ts";
import { readSettingsRow, writeSettingsRow } from "./install-settings.ts";
import { defineJob } from "./jobs/define.ts";
import { defineSchedule } from "./jobs/schedules.ts";
import { can } from "./permissions/can.ts";
import type { Access, DataLayer, Executor, InstallScope } from "./tenancy/data-layer.ts";

/**
 * Reading the Audit log (the screens, a person's own activity, the CSV export) and keeping it to
 * its retention. Writing is `recordAudit`'s alone (`audit.ts`); nothing here changes an entry.
 *
 * Who reads what: the Superadmin (`audit.view` on the Install) the whole Install, its own entries
 * too; Staff and Owners (`audit.view` on a Workspace) one Workspace at a time, and of its Sites only
 * those they see (an Owner reaching some Sites never reads the others'). Editors and Authors none.
 * Pages go newest first by entry id (keyset), so each costs the same however long the log is.
 */

/** What to read, beside who reads it. Dates: `from` included, `to` not. */
export type AuditQuery = {
	/** One Workspace's entries; without it, the whole Install's (the Superadmin). */
	workspaceId?: string;
	/** What one person did: as themselves, or as someone they impersonated. */
	personId?: string;
	/** One action, such as `entry.publish`. */
	action?: string;
	/** How it came in. */
	via?: AuditViaKind;
	siteId?: string;
	from?: Date;
	to?: Date;
	/** The `next` of the page before: entries older than it. */
	after?: string;
	limit: number;
};

/** One page of entries, with the names of the people, Workspaces and Sites they mention. */
export type AuditPage = {
	entries: AuditEntry[];
	/** Where the next (older) page starts, or null on the last page. */
	next: string | null;
	/** The people the entries name (who acted, who impersonated), by id; gone people are missing. */
	people: Record<string, { name: string; email: string }>;
	workspaces: Record<string, string>;
	sites: Record<string, string>;
};

/** The Audit log's retention: entries older than this many days are removed every day. */
export const AUDIT_RETENTION_DAYS = { default: 365, min: 90, max: 3650 } as const;

/** The most entries one CSV export holds: the newest ones that match. */
export const AUDIT_EXPORT_LIMIT = 50_000;

export type AuditLog = {
	/**
	 * A page of the Audit log `access` may read: one Workspace's (`audit.view` there: 404 when they
	 * can't see it, 403 without it) or, without `workspaceId`, the whole Install's (`audit.view` on
	 * the Install).
	 */
	list(access: Access, query: AuditQuery): Promise<AuditPage>;
	/**
	 * What a person did, anywhere on the Install, newest first: as themselves, what the Superadmin
	 * or Staff did as them while impersonating them, and what they did as someone else. `workspaceIds`
	 * limits it to those Workspaces (and the Install's own entries): what an impersonation reaches.
	 */
	activity(
		personId: string,
		query: { after?: string; limit: number; workspaceIds?: readonly string[] | null },
	): Promise<AuditPage>;
	/** The entries `list` would read, as a CSV file (UTF-8 with a BOM, formulas made text): the newest `AUDIT_EXPORT_LIMIT`. */
	export(
		access: Access,
		query: Omit<AuditQuery, "after" | "limit">,
	): Promise<{ filename: string; csv: string; truncated: boolean }>;
	/** How many days entries are kept. */
	retention(): Promise<{ days: number }>;
	/**
	 * Sets how many days entries are kept (`AUDIT_RETENTION_DAYS`), recorded in the Audit log
	 * (`auditRetention.change`). A Sensitive action: open the Install with `install.manage` and check first.
	 */
	setRetention(scope: InstallScope, days: number): Promise<{ days: number }>;
};

export function createAuditLog({
	database,
	data,
	clock,
}: {
	database: Database;
	data: DataLayer;
	clock: Clock;
}): AuditLog {
	/** The condition limiting the log to what `access` may read at the level asked for. */
	const readable = async (access: Access, workspaceId: string | undefined): Promise<SQL | undefined> => {
		if (!workspaceId) {
			await data.install(access, "audit.view");
			return undefined;
		}
		const workspace = await data.workspace(access, workspaceId, "audit.view");
		const all = await workspace.select(sites);
		const seen = all
			.filter((site) => can(access.actor, "site.view", { level: "site", workspaceId, siteId: site.id }))
			.map((site) => site.id);
		if (seen.length === all.length) return workspace.where(auditLog);
		const ofSites =
			seen.length > 0 ? or(isNull(auditLog.siteId), inArray(auditLog.siteId, seen)) : isNull(auditLog.siteId);
		return workspace.where(auditLog, ofSites);
	};

	const page = async (where: SQL | undefined, after: string | undefined, limit: number): Promise<AuditPage> => {
		const conditions = [where, after ? lt(auditLog.id, Number(after)) : undefined].filter(
			(condition): condition is SQL => condition !== undefined,
		);
		const rows = await database.db
			.select()
			.from(auditLog)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(auditLog.id))
			.limit(limit + 1);
		const entries = rows.slice(0, limit).map(entryOf);
		const last = entries.at(-1);
		return {
			entries,
			next: rows.length > limit && last ? last.id : null,
			...(await namesOf(database.db, rows.slice(0, limit))),
		};
	};

	return {
		async list(access, query) {
			const where = and(await readable(access, query.workspaceId), ...filtersOf(query));
			return page(where, query.after, query.limit);
		},

		activity(personId, query) {
			const theirs = or(eq(auditLog.personId, personId), eq(auditLog.impersonatorId, personId));
			const reach = query.workspaceIds
				? query.workspaceIds.length > 0
					? or(isNull(auditLog.workspaceId), inArray(auditLog.workspaceId, [...query.workspaceIds]))
					: isNull(auditLog.workspaceId)
				: undefined;
			return page(and(theirs, reach), query.after, query.limit);
		},

		async export(access, query) {
			const where = and(await readable(access, query.workspaceId), ...filtersOf(query));
			const read = await page(where, undefined, AUDIT_EXPORT_LIMIT);
			return {
				filename: `audit-log-${clock.now().toISOString().slice(0, 10)}.csv`,
				csv: auditCsv(read),
				truncated: read.next !== null,
			};
		},

		async retention() {
			return { days: (await readSettingsRow(database.db))?.auditRetentionDays ?? AUDIT_RETENTION_DAYS.default };
		},

		async setRetention(scope, days) {
			const { min, max } = AUDIT_RETENTION_DAYS;
			if (!Number.isInteger(days) || days < min || days > max) {
				throw new RangeError(`Audit log entries are kept from ${min} to ${max} days.`);
			}
			return scope.transaction(async (tx) => {
				const before = (await readSettingsRow(tx.db))?.auditRetentionDays ?? AUDIT_RETENTION_DAYS.default;
				if (before !== days) {
					await writeSettingsRow(tx.db, { auditRetentionDays: days });
					await tx.audit("auditRetention.change", { from: before, to: days });
				}
				return { days };
			});
		},
	};
}

/** The conditions a query's filters add. */
function filtersOf(query: Omit<AuditQuery, "after" | "limit">): SQL[] {
	const conditions: (SQL | undefined)[] = [
		query.personId ? or(eq(auditLog.personId, query.personId), eq(auditLog.impersonatorId, query.personId)) : undefined,
		query.action ? eq(auditLog.action, query.action) : undefined,
		query.via ? eq(auditLog.via, query.via) : undefined,
		query.siteId ? eq(auditLog.siteId, query.siteId) : undefined,
		query.from ? gte(auditLog.occurredAt, query.from) : undefined,
		query.to ? lt(auditLog.occurredAt, query.to) : undefined,
	];
	return conditions.filter((condition): condition is SQL => condition !== undefined);
}

function entryOf(row: typeof auditLog.$inferSelect): AuditEntry {
	return {
		id: String(row.id),
		at: row.occurredAt,
		action: row.action,
		personId: row.personId,
		via: viaOf(row.via, row.viaName, row.impersonatorId),
		workspaceId: row.workspaceId,
		siteId: row.siteId,
		details: (row.details ?? {}) as AuditEntry["details"],
	};
}

/** The names of the people, Workspaces and Sites some entries mention, in three queries. */
async function namesOf(
	executor: Executor,
	rows: readonly (typeof auditLog.$inferSelect)[],
): Promise<Pick<AuditPage, "people" | "workspaces" | "sites">> {
	const ids = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))];
	const personIds = ids(rows.flatMap((row) => [row.personId, row.impersonatorId]));
	const workspaceIds = ids(rows.map((row) => row.workspaceId));
	const siteIds = ids(rows.map((row) => row.siteId));
	const [personRows, workspaceRows, siteRows] = await Promise.all([
		personIds.length > 0
			? executor
					.select({ id: people.id, name: people.name, email: people.email })
					.from(people)
					.where(inArray(people.id, personIds))
			: [],
		workspaceIds.length > 0
			? executor
					.select({ id: workspaces.id, name: workspaces.name })
					.from(workspaces)
					.where(inArray(workspaces.id, workspaceIds))
			: [],
		siteIds.length > 0
			? executor.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds))
			: [],
	]);
	return {
		people: Object.fromEntries(personRows.map((row) => [row.id, { name: row.name, email: row.email }])),
		workspaces: Object.fromEntries(workspaceRows.map((row) => [row.id, row.name])),
		sites: Object.fromEntries(siteRows.map((row) => [row.id, row.name])),
	};
}

/**
 * A page as a CSV file for spreadsheets: one line per entry, the time in UTC, who acted and how,
 * where, the action's name and its details as JSON. Formulas are made text (`csvCell`).
 */
function auditCsv(read: AuditPage): string {
	const header = ["time_utc", "action", "person", "email", "via", "via_name", "workspace", "site", "details"];
	const lines = read.entries.map((entry) => {
		const person = entry.personId ? read.people[entry.personId] : undefined;
		return [
			entry.at.toISOString(),
			entry.action,
			person?.name ?? "",
			person?.email ?? "",
			entry.via.kind,
			"name" in entry.via ? entry.via.name : "",
			entry.workspaceId ? (read.workspaces[entry.workspaceId] ?? entry.workspaceId) : "",
			entry.siteId ? (read.sites[entry.siteId] ?? entry.siteId) : "",
			JSON.stringify(entry.details),
		];
	});
	return `﻿${[header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** How many entries one statement removes at most, so pruning a large log never holds one long lock. */
const PRUNE_BATCH = 5_000;

/** Removes the entries older than the retention, as of `now`; answers how many went. */
export async function pruneAuditLog(database: Database, now: Date): Promise<number> {
	const days = (await readSettingsRow(database.db))?.auditRetentionDays ?? AUDIT_RETENTION_DAYS.default;
	const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	let total = 0;
	for (;;) {
		const result = await database.db.execute(
			sql`delete from audit_log where id in (select id from audit_log where occurred_at < ${before} limit ${PRUNE_BATCH})`,
		);
		const deleted = Number((result as { rowCount?: number | null }).rowCount ?? 0);
		total += deleted;
		if (deleted < PRUNE_BATCH) return total;
	}
}

/** Removes Audit log entries past the Install's retention (1 year unless the Superadmin chose another). */
export const auditPrune = defineJob({
	name: "audit.prune",
	payload: z.object({}),
	async run(_payload, { database, clock, log }) {
		const removed = await pruneAuditLog(database, clock.now());
		log.info("Removed Audit log entries past their retention", { removed });
	},
});

/** The prune runs every day at 03:27 UTC. */
export const auditPruneSchedule = defineSchedule({ job: auditPrune, cron: "27 3 * * *", payload: {} });
