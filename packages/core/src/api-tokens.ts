import type { Database } from "@webcraft/db";
import { apiTokenSites, apiTokens, people, sites, workspaces } from "@webcraft/db/schema";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { type AuditVia, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { isUuid } from "./ids.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { can, type PersonActor, type Reach, type TokenActor, workspacesReached } from "./permissions/can.ts";
import type { People, Person } from "./people.ts";
import type { RateLimitRule, RateLimits, RateLimitTally } from "./rate-limits.ts";
import type { Access, Executor, WorkspaceScope } from "./tenancy/data-layer.ts";
import { SiteNotFoundError } from "./tenancy/errors.ts";
import { newToken } from "./tokens.ts";

/**
 * API tokens (spec › Management API): credentials people create in the admin (Your account › API
 * tokens) so scripts and AI clients act as them through `/api/v1`, within one Workspace and, if
 * they choose, some of its Sites, read-only if they choose. Creating one is a Sensitive action.
 *
 * A token is shown once. Only a keyed hash of it is stored (HMAC-SHA256 under a key derived from
 * the Master key), so a request finds its token with one indexed lookup, and a new Master key ends
 * every token, as it signs everyone out.
 *
 * A token acts as its person now: their access is read fresh on every request (`TokenActor`), so
 * it never does more than they may. When the person no longer reaches what the token was made for
 * (their Membership removed, their Staff Workspaces changed, the token's Sites out of their reach),
 * WebCraft revokes it at once, in the same transaction as the change, and again on its next use for
 * any other way access ends. While the person's account is locked, their tokens wait.
 */

/** What every API token starts with, so people (and secret scanners) recognise one. */
export const API_TOKEN_PREFIX = "webcraft_";

/** How long a new token lasts, in days; null never ends. 90 unless chosen. */
export const API_TOKEN_LIFETIMES = [30, 90, 365, null] as const;

export type ApiTokenLifetime = (typeof API_TOKEN_LIFETIMES)[number];

export const DEFAULT_API_TOKEN_LIFETIME: ApiTokenLifetime = 90;

/** At most this many requests, and of them this many writes, a minute per token. */
export const API_TOKEN_LIMITS = {
	requests: { limit: 300, windowMs: 60_000 },
	writes: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/** How a procedure counts against a token: one that changes nothing (`read`) or one that may (`write`). */
export type ApiAccess = "read" | "write";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `lastUsedAt` is written at most this often. */
const LAST_USED_EVERY_MS = 60_000;

/** A token as its person sees it in the list; never the token itself. */
export type ApiTokenView = {
	id: string;
	name: string;
	workspace: { id: string; name: string };
	/** Every Site of the Workspace (`"all"`, later ones too) or the listed ones. */
	sites: "all" | { id: string; name: string }[];
	readOnly: boolean;
	/** The token's last 4 characters. */
	hint: string;
	createdAt: Date;
	/** Null: it never expires. */
	expiresAt: Date | null;
	lastUsedAt: Date | null;
	status: "active" | "expired" | "revoked";
	revokedAt: Date | null;
	/** Who ended it: its person (`person`), or WebCraft when the person lost access (`access`). */
	revokedReason: "person" | "access" | null;
};

/** What a person may make tokens for: their Workspaces, each with the Sites they see there. */
export type ApiTokenOffer = { id: string; name: string; sites: { id: string; name: string }[] }[];

export type NewApiToken = {
	name: string;
	/** Every Site of the Workspace (later ones too), or at least one of its Sites. */
	sites: "all" | readonly string[];
	readOnly: boolean;
	/** Days until it expires, or null for never. */
	lifetimeDays: ApiTokenLifetime;
};

/** A request's token, found and checked: who acts, and how the Audit log names it. */
export type ApiTokenUse = {
	token: { id: string; name: string; readOnly: boolean };
	person: Person;
	access: Access;
};

/** Why a request's token doesn't work. */
export type ApiTokenProblem = "missing" | "unknown" | "expired" | "revoked" | "locked";

/**
 * The request carries no token, or one that doesn't work: unknown, expired, revoked, or its person's
 * account is locked for now (`retryAfterSeconds`).
 */
export class ApiTokenInvalidError extends Error {
	override name = "ApiTokenInvalidError";
	readonly problem: ApiTokenProblem;
	readonly retryAfterSeconds: number | undefined;
	constructor(problem: ApiTokenProblem, retryAfterSeconds?: number) {
		super(
			problem === "missing"
				? "Send an API token: `Authorization: Bearer <token>`."
				: problem === "expired"
					? "This API token has expired. Create a new one under Your account › API tokens."
					: problem === "revoked"
						? "This API token was revoked. Create a new one under Your account › API tokens."
						: problem === "locked"
							? "The account this API token belongs to is locked for now. Try again later."
							: "This API token isn't known to this Install.",
		);
		this.problem = problem;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** The token isn't one of the person's own. */
export class ApiTokenNotFoundError extends Error {
	override name = "ApiTokenNotFoundError";
	constructor() {
		super("There is no such API token among yours.");
	}
}

/** A read-only token called a procedure that may change something. */
export class ApiTokenReadOnlyError extends Error {
	override name = "ApiTokenReadOnlyError";
	constructor() {
		super("This API token is read-only: it can't call procedures that change anything.");
	}
}

export type ApiTokens = {
	/** The person's tokens, newest first: active, expired and revoked. */
	list(personId: string): Promise<ApiTokenView[]>;
	/** The Workspaces (and their Sites) the person may make a token for: those they reach now. */
	offer(actor: PersonActor): Promise<ApiTokenOffer>;
	/**
	 * Makes a token for the person acting in `workspace` (opened for them), and answers it with the
	 * token itself, the only time it is shown. Logged as `apiToken.create`. Sites must be ones they see.
	 */
	create(workspace: WorkspaceScope, input: NewApiToken): Promise<{ token: ApiTokenView; secret: string }>;
	/** Revokes one of the person's own tokens, at once. Logged as `apiToken.revoke`. */
	revoke(access: Access, tokenId: string): Promise<ApiTokenView>;
	/**
	 * The token a request carries (the whole `Authorization: Bearer` value's token), checked:
	 * throws `ApiTokenInvalidError` unless it works now, revoking it first when its person no longer
	 * reaches what it was made for.
	 */
	use(secret: string | null): Promise<ApiTokenUse>;
	/**
	 * Counts one request of a token against its limits: every request against `requests`, and a
	 * `write` against `writes` too. Answers each count, so the caller refuses past either.
	 */
	count(tokenId: string, access: ApiAccess): Promise<{ requests: RateLimitTally; writes: RateLimitTally | null }>;
	/**
	 * Revokes the person's tokens whose Workspace (or every listed Site) they no longer reach, inside
	 * the transaction of the change that took their access (a Membership removed, Staff Workspaces
	 * changed). Logged as `apiToken.revoke` with `reason: "access"`, as `by` did it.
	 */
	revokeUnreachable(
		executor: Executor,
		personId: string,
		by: { personId: string | null; via: AuditVia },
	): Promise<number>;
};

export function createApiTokens({
	database,
	clock,
	people: peopleService,
	rateLimits,
	keyHash,
}: {
	database: Database;
	clock: Clock;
	people: People;
	rateLimits: RateLimits;
	/** The key tokens are hashed under (`apiTokenKey`). */
	keyHash: CryptoKey;
}): ApiTokens {
	const { db } = database;

	const hashed = async (secret: string) => {
		const signature = await crypto.subtle.sign("HMAC", keyHash, new TextEncoder().encode(secret));
		return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
	};

	const statusOf = (row: TokenRow, now: Date): ApiTokenView["status"] =>
		row.revokedAt ? "revoked" : row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? "expired" : "active";

	const views = async (executor: Executor, rows: readonly (TokenRow & { workspaceName: string })[]) => {
		const listed = await listedSites(
			executor,
			rows.filter((row) => !row.allSites).map((row) => row.id),
		);
		const now = clock.now();
		return rows.map(
			(row): ApiTokenView => ({
				id: row.id,
				name: row.name,
				workspace: { id: row.workspaceId, name: row.workspaceName },
				sites: row.allSites ? "all" : (listed.get(row.id) ?? []),
				readOnly: row.readOnly,
				hint: row.hint,
				createdAt: row.createdAt,
				expiresAt: row.expiresAt,
				lastUsedAt: row.lastUsedAt,
				status: statusOf(row, now),
				revokedAt: row.revokedAt,
				revokedReason: row.revokedReason === "person" || row.revokedReason === "access" ? row.revokedReason : null,
			}),
		);
	};

	const selectTokens = (executor: Executor) =>
		executor
			.select({ token: apiTokens, workspaceName: workspaces.name })
			.from(apiTokens)
			.innerJoin(workspaces, eq(workspaces.id, apiTokens.workspaceId));

	const viewOf = async (executor: Executor, tokenId: string) => {
		const [row] = await selectTokens(executor).where(eq(apiTokens.id, tokenId));
		if (!row) throw new ApiTokenNotFoundError();
		const [view] = await views(executor, [{ ...row.token, workspaceName: row.workspaceName }]);
		if (!view) throw new ApiTokenNotFoundError();
		return view;
	};

	return {
		async list(personId) {
			if (!isUuid(personId)) return [];
			const rows = await selectTokens(db)
				.where(eq(apiTokens.personId, personId))
				.orderBy(desc(apiTokens.createdAt), asc(apiTokens.name));
			return views(
				db,
				rows.map((row) => ({ ...row.token, workspaceName: row.workspaceName })),
			);
		},

		async offer(actor) {
			const reached = workspacesReached(actor);
			if (reached !== "all" && reached.length === 0) return [];
			const workspaceRows = await db
				.select({ id: workspaces.id, name: workspaces.name })
				.from(workspaces)
				.where(reached === "all" ? undefined : inArray(workspaces.id, [...reached]))
				.orderBy(asc(workspaces.name), asc(workspaces.createdAt));
			const visible = workspaceRows.filter((row) =>
				can(actor, "workspace.view", { level: "workspace", workspaceId: row.id }),
			);
			if (visible.length === 0) return [];
			const siteRows = await db
				.select({ id: sites.id, name: sites.name, workspaceId: sites.workspaceId })
				.from(sites)
				.where(
					inArray(
						sites.workspaceId,
						visible.map((row) => row.id),
					),
				)
				.orderBy(asc(sites.name), asc(sites.createdAt));
			return visible.map((workspace) => ({
				...workspace,
				sites: siteRows
					.filter(
						(site) =>
							site.workspaceId === workspace.id &&
							can(actor, "site.view", { level: "site", workspaceId: workspace.id, siteId: site.id }),
					)
					.map(({ id, name }) => ({ id, name })),
			}));
		},

		async create(scope, input) {
			const { actor } = scope.access;
			if (actor.kind !== "person") throw new TypeError("Only a person creates API tokens.");
			const name = input.name.trim();
			if (name.length === 0 || name.length > 100) throw new TypeError("An API token's name has 1 to 100 characters.");
			const listed = input.sites === "all" ? null : [...new Set(input.sites)];
			if (listed !== null) {
				if (listed.length === 0) throw new SiteNotFoundError();
				for (const siteId of listed) {
					const seen =
						isUuid(siteId) &&
						can(actor, "site.view", { level: "site", workspaceId: scope.workspace.id, siteId }) &&
						(await db
							.select({ id: sites.id })
							.from(sites)
							.where(and(eq(sites.id, siteId), eq(sites.workspaceId, scope.workspace.id)))
							.then((rows) => rows.length > 0));
					if (!seen) throw new SiteNotFoundError();
				}
			}
			const secret = `${API_TOKEN_PREFIX}${newToken()}`;
			const now = scope.now();
			const expiresAt = input.lifetimeDays === null ? null : new Date(now.getTime() + input.lifetimeDays * DAY_MS);
			const tokenId = await scope.transaction(async (tx) => {
				const [row] = await tx.db
					.insert(apiTokens)
					.values({
						personId: actor.personId,
						workspaceId: tx.workspace.id,
						name,
						secretHash: await hashed(secret),
						hint: secret.slice(-4),
						allSites: listed === null,
						readOnly: input.readOnly,
						createdAt: now,
						expiresAt,
					})
					.returning({ id: apiTokens.id });
				if (!row) throw new Error("The new API token was not saved.");
				for (const siteId of listed ?? []) {
					await tx.db.insert(apiTokenSites).values({ tokenId: row.id, workspaceId: tx.workspace.id, siteId });
				}
				await tx.audit("apiToken.create", {
					tokenId: row.id,
					name,
					sites: listed ?? "all",
					readOnly: input.readOnly,
					expiresAt: expiresAt?.toISOString() ?? null,
				});
				return row.id;
			});
			return { token: await viewOf(db, tokenId), secret };
		},

		async revoke(access, tokenId) {
			const personId = access.actor.kind === "person" ? access.actor.personId : null;
			if (personId === null) throw new TypeError("Only a person revokes their API tokens.");
			if (!isUuid(tokenId)) throw new ApiTokenNotFoundError();
			await db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(apiTokens)
					.where(and(eq(apiTokens.id, tokenId), eq(apiTokens.personId, personId)))
					.for("update");
				if (!row) throw new ApiTokenNotFoundError();
				if (row.revokedAt) return;
				const now = clock.now();
				await tx.update(apiTokens).set({ revokedAt: now, revokedReason: "person" }).where(eq(apiTokens.id, row.id));
				await recordAudit(tx, now, {
					personId,
					via: access.via,
					workspaceId: row.workspaceId,
					siteId: null,
					action: "apiToken.revoke",
					details: { tokenId: row.id, name: row.name, owner: personId, reason: "person" },
				});
			});
			return viewOf(db, tokenId);
		},

		async use(secret) {
			if (!secret) throw new ApiTokenInvalidError("missing");
			if (!secret.startsWith(API_TOKEN_PREFIX) || secret.length > 200) throw new ApiTokenInvalidError("unknown");
			const [found] = await db
				.select({ token: apiTokens, lockedUntil: people.lockedUntil })
				.from(apiTokens)
				.innerJoin(people, eq(people.id, apiTokens.personId))
				.where(eq(apiTokens.secretHash, await hashed(secret)));
			if (!found) throw new ApiTokenInvalidError("unknown");
			const { token, lockedUntil } = found;
			const now = clock.now();
			if (token.revokedAt) throw new ApiTokenInvalidError("revoked");
			if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) throw new ApiTokenInvalidError("expired");
			if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
				throw new ApiTokenInvalidError(
					"locked",
					Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
				);
			}
			const [person, personActor, listed] = await Promise.all([
				peopleService.get(token.personId),
				loadPersonActor(db, token.personId),
				token.allSites
					? Promise.resolve<string[]>([])
					: db
							.select({ siteId: apiTokenSites.siteId })
							.from(apiTokenSites)
							.where(eq(apiTokenSites.tokenId, token.id))
							.then((rows) => rows.map((row) => row.siteId)),
			]);
			if (!person) throw new ApiTokenInvalidError("unknown");
			const via: AuditVia = { kind: "token", name: token.name };
			if (!reaches(personActor, token, listed)) {
				// Access ended some way that didn't revoke it at once: it ends now, for good.
				await db.transaction((tx) => revokeForAccess(tx, token, now, { personId: null, via }));
				throw new ApiTokenInvalidError("revoked");
			}
			if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
				await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, token.id));
			}
			const actor: TokenActor = {
				kind: "token",
				tokenId: token.id,
				person: personActor,
				workspaceId: token.workspaceId,
				sites: token.allSites ? "all" : (listed satisfies Reach),
			};
			return { token: { id: token.id, name: token.name, readOnly: token.readOnly }, person, access: { actor, via } };
		},

		async count(tokenId, access) {
			const requests = await rateLimits.tally(`api-token:${tokenId}:requests`, API_TOKEN_LIMITS.requests);
			const writes =
				access === "write" && requests.within
					? await rateLimits.tally(`api-token:${tokenId}:writes`, API_TOKEN_LIMITS.writes)
					: null;
			return { requests, writes };
		},

		revokeUnreachable: (executor, personId, by) => revokeTokensOutOfReach(executor, personId, clock.now(), by),
	};
}

type TokenRow = typeof apiTokens.$inferSelect;

/**
 * Revokes the person's working tokens whose Workspace (or every listed Site) they no longer reach,
 * logging `apiToken.revoke` with `reason: "access"` as `by` did it. Call it inside the transaction
 * of the change that took their access, so the token ends with it.
 */
export async function revokeTokensOutOfReach(
	executor: Executor,
	personId: string,
	now: Date,
	by: { personId: string | null; via: AuditVia },
): Promise<number> {
	const active = await executor
		.select()
		.from(apiTokens)
		.where(
			and(
				eq(apiTokens.personId, personId),
				isNull(apiTokens.revokedAt),
				or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
			),
		);
	if (active.length === 0) return 0;
	const actor = await loadPersonActor(executor, personId);
	const listed = await listedSites(
		executor,
		active.filter((token) => !token.allSites).map((token) => token.id),
	);
	let revoked = 0;
	for (const token of active) {
		const siteIds = (listed.get(token.id) ?? []).map((site) => site.id);
		if (reaches(actor, token, siteIds)) continue;
		if (await revokeForAccess(executor, token, now, by)) revoked++;
	}
	return revoked;
}

/** The Sites listed by each token that doesn't reach them all, with their names. */
async function listedSites(executor: Executor, tokenIds: readonly string[]) {
	const byToken = new Map<string, { id: string; name: string }[]>();
	if (tokenIds.length === 0) return byToken;
	const rows = await executor
		.select({ tokenId: apiTokenSites.tokenId, id: sites.id, name: sites.name })
		.from(apiTokenSites)
		.innerJoin(sites, eq(sites.id, apiTokenSites.siteId))
		.where(inArray(apiTokenSites.tokenId, [...tokenIds]))
		.orderBy(asc(sites.name));
	for (const row of rows)
		byToken.set(row.tokenId, [...(byToken.get(row.tokenId) ?? []), { id: row.id, name: row.name }]);
	return byToken;
}

/** Whether `actor` (the person, as they are now) still reaches what the token was made for. */
function reaches(actor: PersonActor, token: Pick<TokenRow, "workspaceId" | "allSites">, listed: readonly string[]) {
	if (!can(actor, "workspace.view", { level: "workspace", workspaceId: token.workspaceId })) return false;
	if (token.allSites) return true;
	return listed.some((siteId) => can(actor, "site.view", { level: "site", workspaceId: token.workspaceId, siteId }));
}

async function revokeForAccess(
	executor: Executor,
	token: Pick<TokenRow, "id" | "name" | "personId" | "workspaceId">,
	now: Date,
	by: { personId: string | null; via: AuditVia },
): Promise<boolean> {
	const revoked = await executor
		.update(apiTokens)
		.set({ revokedAt: now, revokedReason: "access" })
		.where(and(eq(apiTokens.id, token.id), isNull(apiTokens.revokedAt)))
		.returning({ id: apiTokens.id });
	if (revoked.length === 0) return false;
	await recordAudit(executor, now, {
		personId: by.personId,
		via: by.via,
		workspaceId: token.workspaceId,
		siteId: null,
		action: "apiToken.revoke",
		details: { tokenId: token.id, name: token.name, owner: token.personId, reason: "access" },
	});
	return true;
}
