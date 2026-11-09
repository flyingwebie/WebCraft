import type { Database, Transaction } from "@webcraft/db";
import { sites, workspaces } from "@webcraft/db/schema";
import { and, count, eq, type InferInsertModel, type InferSelectModel, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { type AuditDetails, type AuditVia, type RecordedAuditEntry, recordAudit } from "../audit.ts";
import type { Clock } from "../clock.ts";
import { isUuid } from "../ids.ts";
import { type Actor, can, INSTALL, personIdOf, type Resource } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import type { SecretDescription, SecretOwner, Secrets } from "../secrets/index.ts";
import { PermissionDeniedError, SiteNotFoundError, WorkspaceNotFoundError } from "./errors.ts";

/**
 * The tenant data layer (ADR 0007). All Workspaces share one database, so every query on tenant
 * data goes through a scope that can't exist without a Workspace (and a Site where it applies):
 *
 *     const site = await services.data.site(access, siteId, "entry.publish");
 *     const drafts = await site.select(entries, eq(entries.status, "draft"));
 *
 * Opening a scope runs the permission check: `can(actor, permission, …)`. A Workspace or Site the
 * actor can't see answers "not found", one they can see without the Permission "permission denied".
 * Every query a scope runs is limited to its Workspace (and Site); every change can be recorded in
 * the Audit log with `scope.audit(…)`, which fills in who, when, how, the Workspace and the Site.
 */
export type DataLayer = {
	/** Opens the Install itself for an Install-level action, such as creating a Workspace. */
	install(access: Access, permission: Permission): Promise<InstallScope>;
	/** Opens one Workspace's data. */
	workspace(access: Access, workspaceId: string, permission: Permission): Promise<WorkspaceScope>;
	/** Opens one Site's data, and so its Workspace's. */
	site(access: Access, siteId: string, permission: Permission): Promise<SiteScope>;
	/**
	 * Opens a Site for its visitors: read-only, with nobody signed in, so only for what any visitor
	 * may see (published content). Only the Site request pipeline opens one, after finding the Site
	 * by hostname.
	 */
	visitors(site: Site): VisitorScope;
	/**
	 * Opens a Site for WebCraft's own work in the background, such as the worker cleaning an upload.
	 * No person acts, so nothing is checked with `can()` and nothing is written to the Audit log: only
	 * jobs open one, for the Site named in a payload that a checked procedure queued. Null when the
	 * Site no longer exists.
	 */
	background(siteId: string): Promise<BackgroundScope | null>;
};

/**
 * Who is acting and how they came in: the permission check and the Audit log both need it.
 * `identityCheckedAt` is when a person last proved who they are in the admin session the call came
 * with (null: not since signing in long ago); it is absent for anything that isn't an admin session,
 * which can never take a Sensitive action.
 */
export type Access = { actor: Actor; via: AuditVia; identityCheckedAt?: Date | null };

/** A Workspace, as the data layer hands it out. */
export type Workspace = { id: string; name: string; createdAt: Date };

/** A Site of a Workspace. */
export type Site = { id: string; workspaceId: string; name: string; slug: string; createdAt: Date };

/** A table of Workspace data: every row has a `workspace_id`. */
export type WorkspaceTable = PgTable & { workspaceId: AnyPgColumn };

/** A table of Site data: every row has a `workspace_id` and a `site_id`. */
export type SiteTable = WorkspaceTable & { siteId: AnyPgColumn };

/** A connection or a transaction: what a scope's queries run on. */
export type Executor = Database["db"] | Transaction;

type Row<Table extends PgTable> = InferSelectModel<Table>;

/**
 * The values of a new row, without the columns the scope fills in: `workspaceId` in a Workspace
 * scope, and `siteId` too in a Site scope. A Workspace table may still name one of its Workspace's
 * Sites (`membership_sites`); its foreign key to `sites (workspace_id, id)` keeps it in the Workspace.
 */
type NewRow<Table extends PgTable, Filled extends string> = Omit<InferInsertModel<Table>, Filled>;

export type SelectOptions = { orderBy?: readonly (SQL | AnyPgColumn)[]; limit?: number };

/**
 * Queries on tenant tables, limited to one scope. `where` is the extra condition, if any; the scope
 * always adds its own. `insert` fills in the Workspace (and Site) itself.
 */
export type ScopedQueries<Table extends PgTable, Filled extends string> = {
	select<T extends Table>(table: T, where?: SQL, options?: SelectOptions): Promise<Row<T>[]>;
	first<T extends Table>(table: T, where?: SQL, options?: Omit<SelectOptions, "limit">): Promise<Row<T> | undefined>;
	count<T extends Table>(table: T, where?: SQL): Promise<number>;
	insert<T extends Table>(table: T, values: NewRow<T, Filled>): Promise<Row<T>>;
	update<T extends Table>(table: T, set: Partial<NewRow<T, Filled>>, where?: SQL): Promise<Row<T>[]>;
	delete<T extends Table>(table: T, where?: SQL): Promise<number>;
	/**
	 * The condition limiting `table` to this scope, and `where` if given: for joins and other
	 * queries the helpers don't cover. Every such query must include it.
	 */
	where(table: Table, where?: SQL): SQL;
};

/** A Workspace's or Site's secrets: the same as `services.secrets`, with the owner filled in by the scope. */
export type ScopedSecrets = {
	set(name: string, value: string): Promise<void>;
	useWith<Result>(name: string, use: (value: string) => Result | Promise<Result>): Promise<Result>;
	describe(name: string): Promise<SecretDescription>;
	remove(name: string): Promise<void>;
	/** The names of this Workspace's (or Site's) secrets that start with `prefix`. */
	names(prefix: string): Promise<string[]>;
};

type ScopeBase = {
	readonly access: Access;
	/** The time, from the Install's clock. */
	now(): Date;
	/** Records an action in the Audit log, with who, when, how, and this scope's Workspace and Site. */
	audit(action: string, details?: AuditDetails): Promise<void>;
};

/** The Install, opened for an Install-level action. Its tables (Workspaces, Staff, invites) aren't tenant data. */
export type InstallScope = Omit<ScopeBase, "audit"> & {
	readonly level: "install";
	/**
	 * Records an Install-level action in the Audit log, with who, when and how. `about` names the
	 * Workspace (and Site) the action concerns, such as the Workspace it created.
	 */
	audit(action: string, details?: AuditDetails, about?: { workspaceId: string; siteId?: string }): Promise<void>;
	/** The database, for Install-level tables only; tenant tables go through a Workspace or Site scope. */
	readonly db: Executor;
	/** Runs `work` in one transaction: its queries and Audit log entries are saved together or not at all. */
	transaction<Result>(work: (scope: InstallScope) => Promise<Result>): Promise<Result>;
};

/**
 * The database a Workspace or Site scope runs on (its transaction inside `transaction`), for joins
 * and other queries the helpers don't cover. Every such query on a tenant table must include
 * `scope.where(table)`.
 */
type ScopeDatabase = { readonly db: Executor };

export type WorkspaceScope = Omit<ScopeBase, "audit"> &
	ScopedQueries<WorkspaceTable, "workspaceId"> &
	ScopeDatabase & {
		readonly level: "workspace";
		/**
		 * Records an action in the Audit log, with who, when, how and this Workspace. `about` names the
		 * Site the action concerns, such as the Site it created.
		 */
		audit(action: string, details?: AuditDetails, about?: { siteId: string }): Promise<void>;
		readonly workspace: Workspace;
		readonly secrets: ScopedSecrets;
		transaction<Result>(work: (scope: WorkspaceScope) => Promise<Result>): Promise<Result>;
	};

export type SiteScope = ScopeBase &
	ScopedQueries<SiteTable, "workspaceId" | "siteId"> &
	ScopeDatabase & {
		readonly level: "site";
		readonly workspace: Workspace;
		readonly site: Site;
		readonly secrets: ScopedSecrets;
		transaction<Result>(work: (scope: SiteScope) => Promise<Result>): Promise<Result>;
	};

/**
 * A Site opened for its visitors: reads only, limited to the Site, with no person, no Audit log and
 * no secrets. Code reading through it must only read what any visitor may see.
 */
export type VisitorScope = Pick<
	ScopedQueries<SiteTable, "workspaceId" | "siteId">,
	"select" | "first" | "count" | "where"
> &
	ScopeDatabase & {
		readonly level: "visitor";
		readonly site: Site;
		/** The time, from the Install's clock. */
		now(): Date;
	};

/**
 * A Site opened for WebCraft's own background work: the queries of a Site scope, limited to the
 * Site, with no person, no Audit log and no secrets.
 */
export type BackgroundScope = ScopedQueries<SiteTable, "workspaceId" | "siteId"> &
	ScopeDatabase & {
		readonly level: "background";
		readonly workspace: Workspace;
		readonly site: Site;
		/** The time, from the Install's clock. */
		now(): Date;
		transaction<Result>(work: (scope: BackgroundScope) => Promise<Result>): Promise<Result>;
	};

type DataLayerOptions = {
	database: Database;
	clock: Clock;
	secrets: Secrets;
	/**
	 * Hears of every Audit log entry a scope writes, once it is saved: after its transaction commits
	 * (never when it rolls back), or at once outside one. It must not throw; the Module host reacts
	 * to some entries by queuing Modules' events.
	 */
	afterAudit?: (entry: RecordedAuditEntry) => Promise<void>;
};

/** What runs once the transaction a scope works in commits. Null: the scope isn't in a transaction. */
type AfterCommit = (() => Promise<void>)[] | null;

export function createDataLayer({ database, clock, secrets, afterAudit }: DataLayerOptions): DataLayer {
	const { db } = database;

	const audit =
		(executor: Executor, access: Access, afterCommit: AfterCommit) =>
		async (
			action: string,
			details: AuditDetails | undefined,
			where: { workspaceId: string | null; siteId: string | null },
		) => {
			const at = clock.now();
			await recordAudit(executor, at, {
				personId: personIdOf(access.actor),
				via: access.via,
				...where,
				action,
				details,
			});
			if (!afterAudit) return;
			const announce = () => afterAudit({ action, ...where, at, details: details ?? {} }).catch(() => {});
			if (afterCommit) afterCommit.push(announce);
			else await announce();
		};

	const base = (
		executor: Executor,
		access: Access,
		where: { workspaceId: string | null; siteId: string | null },
		afterCommit: AfterCommit,
	) => ({
		access,
		now: () => clock.now(),
		audit: (action: string, details?: AuditDetails) => audit(executor, access, afterCommit)(action, details, where),
	});

	const installScope = (executor: Executor, access: Access, afterCommit: AfterCommit): InstallScope => ({
		access,
		now: () => clock.now(),
		audit: (action, details, about) =>
			audit(executor, access, afterCommit)(action, details, {
				workspaceId: about?.workspaceId ?? null,
				siteId: about?.siteId ?? null,
			}),
		level: "install",
		db: executor,
		transaction: (work) =>
			inTransaction(executor, afterCommit, (tx, pending) => work(installScope(tx, access, pending))),
	});

	const workspaceScope = (
		executor: Executor,
		access: Access,
		workspace: Workspace,
		afterCommit: AfterCommit,
	): WorkspaceScope => {
		const condition = (table: WorkspaceTable) => eq(table.workspaceId, workspace.id);
		return {
			...base(executor, access, { workspaceId: workspace.id, siteId: null }, afterCommit),
			audit: (action, details, about) =>
				audit(executor, access, afterCommit)(action, details, {
					workspaceId: workspace.id,
					siteId: about?.siteId ?? null,
				}),
			...scopedQueries(executor, condition, { workspaceId: workspace.id }),
			db: executor,
			level: "workspace",
			workspace,
			secrets: scopedSecrets(secrets, { kind: "workspace", workspaceId: workspace.id }),
			transaction: (work) =>
				inTransaction(executor, afterCommit, (tx, pending) => work(workspaceScope(tx, access, workspace, pending))),
		};
	};

	const siteScope = (
		executor: Executor,
		access: Access,
		workspace: Workspace,
		site: Site,
		afterCommit: AfterCommit,
	): SiteScope => {
		const condition = (table: SiteTable) => and(eq(table.workspaceId, workspace.id), eq(table.siteId, site.id)) as SQL;
		return {
			...base(executor, access, { workspaceId: workspace.id, siteId: site.id }, afterCommit),
			...scopedQueries(executor, condition, { workspaceId: workspace.id, siteId: site.id }),
			db: executor,
			level: "site",
			workspace,
			site,
			secrets: scopedSecrets(secrets, { kind: "site", workspaceId: workspace.id, siteId: site.id }),
			transaction: (work) =>
				inTransaction(executor, afterCommit, (tx, pending) => work(siteScope(tx, access, workspace, site, pending))),
		};
	};

	const backgroundScope = (executor: Executor, workspace: Workspace, site: Site): BackgroundScope => {
		const condition = (table: SiteTable) => and(eq(table.workspaceId, workspace.id), eq(table.siteId, site.id)) as SQL;
		return {
			...scopedQueries(executor, condition, { workspaceId: workspace.id, siteId: site.id }),
			db: executor,
			level: "background",
			workspace,
			site,
			now: () => clock.now(),
			transaction: (work) => inTransaction(executor, null, (tx) => work(backgroundScope(tx, workspace, site))),
		};
	};

	/**
	 * Runs `work` in a transaction, or in the one `executor` already is. What the transaction's scopes
	 * leave for after the commit runs once the outermost one commits.
	 */
	const inTransaction = async <Result>(
		executor: Executor,
		afterCommit: AfterCommit,
		work: (tx: Executor, afterCommit: AfterCommit) => Promise<Result>,
	): Promise<Result> => {
		if (executor !== db) return work(executor, afterCommit);
		const pending: (() => Promise<void>)[] = [];
		const result = await db.transaction((tx) => work(tx, pending));
		for (const announce of pending) await announce();
		return result;
	};

	return {
		async install(access, permission) {
			check(access.actor, permission, INSTALL);
			return installScope(db, access, null);
		},

		async workspace(access, workspaceId, permission) {
			const workspace = isUuid(workspaceId) ? await findWorkspace(db, workspaceId) : undefined;
			if (!workspace) throw new WorkspaceNotFoundError();
			const resource: Resource = { level: "workspace", workspaceId: workspace.id };
			if (!can(access.actor, "workspace.view", resource)) throw new WorkspaceNotFoundError();
			check(access.actor, permission, resource);
			return workspaceScope(db, access, workspace, null);
		},

		async site(access, siteId, permission) {
			const site = isUuid(siteId) ? await findSite(db, siteId) : undefined;
			if (!site) throw new SiteNotFoundError();
			const resource: Resource = { level: "site", workspaceId: site.workspaceId, siteId: site.id };
			if (!can(access.actor, "site.view", resource)) throw new SiteNotFoundError();
			check(access.actor, permission, resource);
			const workspace = await findWorkspace(db, site.workspaceId);
			if (!workspace) throw new SiteNotFoundError();
			return siteScope(db, access, workspace, site, null);
		},

		visitors(site) {
			const condition = (table: SiteTable) =>
				and(eq(table.workspaceId, site.workspaceId), eq(table.siteId, site.id)) as SQL;
			const { select, first, count, where } = scopedQueries(db, condition, {});
			return { select, first, count, where, db, level: "visitor", site, now: () => clock.now() };
		},

		async background(siteId) {
			const site = isUuid(siteId) ? await findSite(db, siteId) : undefined;
			const workspace = site ? await findWorkspace(db, site.workspaceId) : undefined;
			return site && workspace ? backgroundScope(db, workspace, site) : null;
		},
	};
}

function check(actor: Actor, permission: Permission, resource: Resource): void {
	if (!can(actor, permission, resource)) throw new PermissionDeniedError(permission);
}

async function findWorkspace(executor: Executor, workspaceId: string): Promise<Workspace | undefined> {
	const [row] = await executor
		.select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId));
	return row;
}

async function findSite(executor: Executor, siteId: string): Promise<Site | undefined> {
	const [row] = await executor
		.select({
			id: sites.id,
			workspaceId: sites.workspaceId,
			name: sites.name,
			slug: sites.slug,
			createdAt: sites.createdAt,
		})
		.from(sites)
		.where(eq(sites.id, siteId));
	return row;
}

/** The query helpers of one scope: `condition` limits a table to it, `fill` holds the columns `insert` sets. */
function scopedQueries<Table extends WorkspaceTable, Filled extends string>(
	executor: Executor,
	condition: (table: Table) => SQL,
	fill: Record<Filled, string>,
): ScopedQueries<Table, Filled> {
	const where = (table: Table, extra?: SQL) => (extra ? (and(condition(table), extra) as SQL) : condition(table));
	// Drizzle's builders are typed for one known table at a time; these helpers work on any tenant
	// table, so they go through `unknown` and type their answers by the table they were given.
	const select = (table: PgTable, extra: SQL, options: SelectOptions) => {
		let query = executor
			.select()
			.from(table as never)
			.where(extra)
			.$dynamic();
		if (options.orderBy?.length) query = query.orderBy(...options.orderBy);
		if (options.limit !== undefined) query = query.limit(options.limit);
		return query as unknown as Promise<unknown[]>;
	};
	return {
		where,
		async select(table, extra, options = {}) {
			return (await select(table, where(table, extra), options)) as Row<typeof table>[];
		},
		async first(table, extra, options = {}) {
			const [row] = await select(table, where(table, extra), { ...options, limit: 1 });
			return row as Row<typeof table> | undefined;
		},
		async count(table, extra) {
			const [row] = await executor
				.select({ count: count() })
				.from(table as never)
				.where(where(table, extra));
			return row?.count ?? 0;
		},
		async insert(table, values) {
			const rows = (await executor
				.insert(table as never)
				.values({ ...values, ...fill } as never)
				.returning()) as unknown as Row<typeof table>[];
			const [row] = rows;
			if (!row) throw new Error("The new row was not saved.");
			return row;
		},
		async update(table, set, extra) {
			return (await executor
				.update(table as never)
				.set(set as never)
				.where(where(table, extra))
				.returning()) as unknown as Row<typeof table>[];
		},
		async delete(table, extra) {
			const rows = (await executor
				.delete(table as never)
				.where(where(table, extra))
				.returning()) as unknown as unknown[];
			return rows.length;
		},
	};
}

function scopedSecrets(secrets: Secrets, owner: SecretOwner): ScopedSecrets {
	return {
		set: (name, value) => secrets.set({ owner, name }, value),
		useWith: (name, use) => secrets.useWith({ owner, name }, use),
		describe: (name) => secrets.describe({ owner, name }),
		remove: (name) => secrets.remove({ owner, name }),
		names: (prefix) => secrets.names(owner, prefix),
	};
}
