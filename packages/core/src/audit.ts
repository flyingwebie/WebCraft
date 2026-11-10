import type { Database, Transaction } from "@webcraft/db";
import { auditLog } from "@webcraft/db/schema";

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
 * - `impersonation`: the Superadmin or a Staff member acting in the admin as the person (ADR 0008):
 *   `name` is the impersonator's name as it was then and `by` their id, shown as "<Staff> as <Member>".
 *   The entry's person is the one impersonated, so it shows in their own activity too.
 */
export type AuditVia =
	| { kind: "admin" }
	| { kind: "command"; name: string }
	| { kind: "module"; name: string }
	| { kind: "editMode" }
	| { kind: "token"; name: string }
	| { kind: "translation" }
	| { kind: "aiClient"; name: string }
	| { kind: "impersonation"; name: string; by: string };

/** Every way in, as the Audit log stores it (`via`). */
export const AUDIT_VIA_KINDS = [
	"admin",
	"command",
	"module",
	"editMode",
	"token",
	"translation",
	"aiClient",
	"impersonation",
] as const satisfies readonly AuditVia["kind"][];

export type AuditViaKind = (typeof AUDIT_VIA_KINDS)[number];

/**
 * The API client or AI client an action came through (its name), or null when the person acted
 * themself (in the admin, in Edit mode). History shows it as "<person> via <client>".
 */
export function clientNameOf(via: AuditVia): string | null {
	return via.kind === "token" || via.kind === "aiClient" ? via.name : null;
}

/**
 * Who acted as the person (their name as it was then), when the Superadmin or a Staff member
 * impersonated them; null otherwise. History and presence show it as "<Staff> as <Member>", beside
 * `clientNameOf`'s "<person> via <client>".
 */
export function impersonatorNameOf(via: AuditVia): string | null {
	return via.kind === "impersonation" ? via.name : null;
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
		impersonatorId: via.kind === "impersonation" ? via.by : null,
		workspaceId: entry.workspaceId,
		siteId: entry.siteId,
		action: entry.action,
		details: entry.details ?? {},
	});
}

/** How an entry came in, read back from its stored columns. */
export function viaOf(kind: string, name: string | null, impersonatorId: string | null): AuditVia {
	if (kind === "impersonation") return { kind, name: name ?? "", by: impersonatorId ?? "" };
	if (kind === "command" || kind === "module" || kind === "token" || kind === "aiClient") {
		return { kind, name: name ?? "" };
	}
	if (kind === "editMode") return { kind: "editMode" };
	if (kind === "translation") return { kind: "translation" };
	return { kind: "admin" };
}
