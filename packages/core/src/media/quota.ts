import { installRoles, mediaFiles, mediaQuotas, memberships, staffWorkspaces } from "@webcraft/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { Email } from "../email/index.ts";
import type { Logger } from "../log.ts";
import { actingPerson } from "../permissions/can.ts";
import { roleDefinition } from "../permissions/roles.ts";
import type { Executor, Workspace, WorkspaceScope } from "../tenancy/data-layer.ts";
import { MediaQuotaFullError } from "./errors.ts";

/**
 * A Workspace's Media storage: what its Sites' Media libraries take in the Install's storage, and
 * its quota, if Staff set one. `warning` from 80% of the quota, `full` from 100%.
 */
export type MediaStorage = {
	usedBytes: number;
	quotaBytes: number | null;
	warning: boolean;
	full: boolean;
};

/** The share of a quota from which a Workspace is warned. */
export const QUOTA_WARNING_SHARE = 0.8;

/** The smallest quota Staff can set: 1 MB. */
export const MEDIA_QUOTA_MIN_BYTES = 1024 * 1024;

/**
 * The bytes a Workspace's Media takes in storage: every stored file of its Sites (originals,
 * variants, uploads the worker hasn't cleaned yet, files in the Trash and replaced files still
 * served), a file stored once counted once however many items share it.
 */
export async function workspaceMediaBytes(db: Executor, workspaceId: string): Promise<number> {
	const stored = db
		.selectDistinctOn([mediaFiles.storage, mediaFiles.key], { size: mediaFiles.sizeBytes })
		.from(mediaFiles)
		.where(eq(mediaFiles.workspaceId, workspaceId))
		.as("stored");
	const [row] = await db.select({ used: sql<string>`coalesce(sum(${stored.size}), 0)` }).from(stored);
	return Number(row?.used ?? 0);
}

/**
 * Ties uploads to quota changes, across processes: uploads hold it shared, so they still run side by
 * side, and a quota change holds it alone. Locking the quota row isn't enough while a Workspace has
 * none yet: there is nothing to lock, and an upload could slip past a first quota being set.
 */
async function lockQuota(db: Executor, workspaceId: string, mode: "shared" | "alone"): Promise<void> {
	const key = `webcraft:media-quota:${workspaceId}`;
	await db.execute(
		mode === "shared"
			? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
			: sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
	);
}

/** A Workspace's quota row, locked for the transaction when `lock` says so. */
async function quotaRow(db: Executor, workspaceId: string, lock = false) {
	const query = db.select().from(mediaQuotas).where(eq(mediaQuotas.workspaceId, workspaceId));
	const [row] = lock ? await query.for("update") : await query;
	return row;
}

/** A Workspace's storage as people see it. */
export async function mediaStorage(db: Executor, workspaceId: string): Promise<MediaStorage> {
	const [usedBytes, row] = await Promise.all([workspaceMediaBytes(db, workspaceId), quotaRow(db, workspaceId)]);
	return storageOf(usedBytes, row?.quotaBytes ?? null);
}

function storageOf(usedBytes: number, quotaBytes: number | null): MediaStorage {
	return {
		usedBytes,
		quotaBytes,
		warning: quotaBytes !== null && usedBytes >= quotaBytes * QUOTA_WARNING_SHARE,
		full: quotaBytes !== null && usedBytes >= quotaBytes,
	};
}

/**
 * Refuses (`MediaQuotaFullError`) a file of `adding` bytes that would take the Workspace past its
 * quota. With `lock`, it holds the quota row until the transaction ends, so two uploads checked at
 * once can't both squeeze past it, and waits for a quota change under way (`lockQuota`); call it
 * that way inside the transaction that records the file.
 */
export async function assertRoom(
	db: Executor,
	workspaceId: string,
	adding: number,
	options: { lock?: boolean } = {},
): Promise<void> {
	if (options.lock) await lockQuota(db, workspaceId, "shared");
	const row = await quotaRow(db, workspaceId, options.lock);
	if (!row) return;
	const used = await workspaceMediaBytes(db, workspaceId);
	if (used + adding > row.quotaBytes) throw new MediaQuotaFullError(used, row.quotaBytes);
}

type NoticePorts = { email: Email; log: Logger; clock: { now(): Date } };

/**
 * After the Workspace's storage grew or shrank: once it passes 80% of its quota, its Owners and
 * the Staff assigned to it get the `media-quota-warning` email, once, until it is back under 80%.
 */
export async function noticeQuotaUse(db: Executor, ports: NoticePorts, workspace: Workspace): Promise<void> {
	const row = await quotaRow(db, workspace.id);
	if (!row) return;
	const storage = storageOf(await workspaceMediaBytes(db, workspace.id), row.quotaBytes);
	if (!storage.warning) {
		if (row.warnedAt !== null) {
			await db.update(mediaQuotas).set({ warnedAt: null }).where(eq(mediaQuotas.workspaceId, workspace.id));
		}
		return;
	}
	// Only the one call that marks it sends: two uploads at once tell people once.
	const marked = await db
		.update(mediaQuotas)
		.set({ warnedAt: ports.clock.now() })
		.where(and(eq(mediaQuotas.workspaceId, workspace.id), isNull(mediaQuotas.warnedAt)))
		.returning({ workspaceId: mediaQuotas.workspaceId });
	if (marked.length === 0) return;
	const recipients = await quotaRecipients(db, workspace.id);
	if (recipients.length === 0) {
		ports.log.warn("No one to tell that a Workspace passed 80% of its Media storage", { workspaceId: workspace.id });
		return;
	}
	await ports.email.send({
		type: "media-quota-warning",
		to: recipients.map((personId) => ({ personId })),
		data: {
			workspaceName: workspace.name,
			percent: Math.min(100, Math.floor((storage.usedBytes / row.quotaBytes) * 100)),
			usedBytes: storage.usedBytes,
			quotaBytes: row.quotaBytes,
			workspacePath: `/workspaces/${workspace.id}`,
		},
		related: { kind: "workspace", id: workspace.id },
	});
}

/**
 * Who hears that a Workspace's storage is nearly full: its Owners (who manage its Members) and the
 * Staff assigned to it (who set the quota). Checked by Permission, never by role name (ADR 0028).
 */
async function quotaRecipients(db: Executor, workspaceId: string): Promise<string[]> {
	const members = await db
		.select({ personId: memberships.personId, role: memberships.role })
		.from(memberships)
		.where(eq(memberships.workspaceId, workspaceId));
	const staff = await db
		.selectDistinct({ personId: installRoles.personId, role: installRoles.role })
		.from(installRoles)
		.leftJoin(
			staffWorkspaces,
			and(eq(staffWorkspaces.personId, installRoles.personId), eq(staffWorkspaces.workspaceId, workspaceId)),
		)
		.where(or(eq(installRoles.allWorkspaces, true), eq(staffWorkspaces.workspaceId, workspaceId)));
	const holds = (role: string, permission: "member.manage" | "quota.manage") =>
		roleDefinition(role)?.permissions.includes(permission) ?? false;
	const people = new Set([
		...members.filter((row) => holds(row.role, "member.manage")).map((row) => row.personId),
		...staff
			.filter((row) => roleDefinition(row.role)?.reach === "assigned-workspaces" && holds(row.role, "quota.manage"))
			.map((row) => row.personId),
	]);
	return [...people];
}

/**
 * Sets or removes (null) a Workspace's quota, recorded as `storageQuota.change`. Open the Workspace
 * with `quota.manage`. A quota already passed refuses further uploads at once.
 */
export async function setMediaQuota(
	scope: WorkspaceScope,
	ports: NoticePorts,
	quotaBytes: number | null,
): Promise<MediaStorage> {
	if (quotaBytes !== null && (!Number.isInteger(quotaBytes) || quotaBytes < MEDIA_QUOTA_MIN_BYTES)) {
		throw new RangeError(`A quota is at least ${MEDIA_QUOTA_MIN_BYTES} bytes.`);
	}
	await scope.transaction(async (tx) => {
		await lockQuota(tx.db, tx.workspace.id, "alone");
		const before = await quotaRow(tx.db, tx.workspace.id, true);
		const from = before?.quotaBytes ?? null;
		if (from === quotaBytes) return;
		if (quotaBytes === null) {
			await tx.delete(mediaQuotas);
		} else if (before) {
			// A new quota is a new start: the warning is worked out again for it.
			await tx.update(mediaQuotas, {
				quotaBytes,
				warnedAt: null,
				updatedAt: tx.now(),
				updatedBy: actingPerson(tx.access.actor),
			});
		} else {
			await tx.insert(mediaQuotas, { quotaBytes, updatedAt: tx.now(), updatedBy: actingPerson(tx.access.actor) });
		}
		await tx.audit("storageQuota.change", { from, to: quotaBytes });
	});
	await noticeQuotaUse(scope.db, ports, scope.workspace);
	return mediaStorage(scope.db, scope.workspace.id);
}
