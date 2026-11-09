import type { Database, Transaction } from "@webcraft/db";
import { auditLog } from "@webcraft/db/schema";
import { desc } from "drizzle-orm";

type Executor = Database["db"] | Transaction;

/**
 * How an action came in, recorded with every Audit log entry:
 * - `admin`: the admin, at `/api/rpc` (the setup wizard included).
 * - `command`: a server command, `webcraft admin <name>`.
 * - `module`: a Module acting by itself (its id): in a background job, an event or a Site route.
 * - `editMode`: Edit mode, on a Site's own domain.
 * - `token`: an API token (its name), through the Management API at `/api/v1` or the MCP server.
 * - `translation`: AI translation, writing on behalf of the person who asked for it (who published).
 * - `aiClient`: an AI client a person approved (its name as they approved it), through the MCP
 *   server at `/mcp`: shown as "<person> via <client>".
 *
 * Later ways in add their kinds here, such as Impersonation ("<Staff> as <Member>").
 */
export type AuditVia =
	| { kind: "admin" }
	| { kind: "command"; name: string }
	| { kind: "module"; name: string }
	| { kind: "editMode" }
	| { kind: "token"; name: string }
	| { kind: "translation" }
	| { kind: "aiClient"; name: string };

/**
 * The API client or AI client an action came through (its name), or null when the person acted
 * themself (in the admin, in Edit mode). History shows it as "<person> via <client>".
 */
export function clientNameOf(via: AuditVia): string | null {
	return via.kind === "token" || via.kind === "aiClient" ? via.name : null;
}

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

/** An Audit log entry a scope wrote, as the data layer announces it once it is saved. */
export type RecordedAuditEntry = {
	action: string;
	/** Who acted; null when nobody did (a Module by itself). */
	personId: string | null;
	via: AuditVia;
	workspaceId: string | null;
	siteId: string | null;
	at: Date;
	details: AuditDetails;
};

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
		viaName: "name" in via ? via.name : null,
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
		via: viaOf(row.via, row.viaName),
		workspaceId: row.workspaceId,
		siteId: row.siteId,
		details: (row.details ?? {}) as AuditDetails,
	}));
}

function viaOf(kind: string, name: string | null): AuditVia {
	if (kind === "command" || kind === "module" || kind === "token" || kind === "aiClient") {
		return { kind, name: name ?? "" };
	}
	if (kind === "editMode") return { kind: "editMode" };
	if (kind === "translation") return { kind: "translation" };
	return { kind: "admin" };
}
