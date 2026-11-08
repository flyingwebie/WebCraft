import type { Database, Transaction } from "@webcraft/db";
import { auditLog } from "@webcraft/db/schema";
import { desc } from "drizzle-orm";

type Executor = Database["db"] | Transaction;

/**
 * How an action came in, recorded with every Audit log entry:
 * - `admin`: the admin, at `/api/rpc` (the setup wizard included).
 * - `command`: a server command, `webcraft admin <name>`.
 *
 * Later ways in add their kinds here: Edit mode, an API token (its name), an AI client (its name),
 * a Module (its id), and Impersonation ("<Staff> as <Member>").
 */
export type AuditVia = { kind: "admin" } | { kind: "command"; name: string };

/** Something changed, as the Audit log keeps it. Values are plain JSON; never put a secret's value here. */
export type AuditDetails = Record<string, unknown>;

/** One Audit log entry to write. Workspace and Site are null for Install-level actions. */
export type NewAuditEntry = {
	/** Who acted; null when WebCraft itself did. */
	personId: string | null;
	via: AuditVia;
	workspaceId: string | null;
	siteId: string | null;
	/** What happened, as `<noun>.<verb>`, such as `site.create`. */
	action: string;
	details?: AuditDetails;
};

export type AuditEntry = Required<NewAuditEntry> & { id: string; at: Date };

/**
 * Writes one Audit log entry, inside the caller's transaction when given one, so the entry is saved
 * together with the change it records or not at all. The only way anything is written to the Audit
 * log; entries are never changed afterwards.
 */
export async function recordAudit(executor: Executor, at: Date, entry: NewAuditEntry): Promise<void> {
	const { via } = entry;
	await executor.insert(auditLog).values({
		occurredAt: at,
		personId: entry.personId,
		via: via.kind,
		viaName: via.kind === "command" ? via.name : null,
		workspaceId: entry.workspaceId,
		siteId: entry.siteId,
		action: entry.action,
		details: entry.details ?? {},
	});
}

/** The newest entries of the whole Install's Audit log, newest first. */
export async function listAuditEntries(executor: Executor, options: { limit: number }): Promise<AuditEntry[]> {
	const rows = await executor.select().from(auditLog).orderBy(desc(auditLog.id)).limit(options.limit);
	return rows.map((row) => ({
		id: String(row.id),
		at: row.occurredAt,
		action: row.action,
		personId: row.personId,
		via: row.via === "command" ? { kind: "command", name: row.viaName ?? "" } : { kind: "admin" },
		workspaceId: row.workspaceId,
		siteId: row.siteId,
		details: (row.details ?? {}) as AuditDetails,
	}));
}
