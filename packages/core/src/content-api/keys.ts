import type { Database } from "@webcraft/db";
import { contentKeys, contentKeyUsage, people } from "@webcraft/db/schema";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import type { ContentProblem } from "../content/errors.ts";
import { isUuid } from "../ids.ts";
import { actingPerson } from "../permissions/can.ts";
import type { RateLimitRule } from "../rate-limits.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { newToken } from "../tokens.ts";

/**
 * Content keys (GLOSSARY.md › Content key, ADR 0029): what a frontend built elsewhere sends to read
 * one Site's published content through its Content API, in the `Authorization` header. A key grants
 * nothing else, so it may sit in browser code; browsers on other sites may use it only from the
 * origins it lists.
 *
 * Like API tokens, a key is shown once and only a keyed hash of it is kept (HMAC-SHA256 under a key
 * derived from the Master key), with its last 4 characters as a hint; a revoked key stays listed, so
 * a frontend still sending it is told it was revoked. Each key counts its requests per day (UTC).
 */

/** What every Content key starts with, so people (and secret scanners) recognise one. */
export const CONTENT_KEY_PREFIX = "webcraft-ck_";

/** How many working keys a Site may have, how many origins one may list, and its name's length. */
export const CONTENT_KEY_LIMITS = { keys: 50, origins: 20, name: 100 } as const;

/**
 * The Content API's rate limits: 600 requests a minute per Content key and 120 per client address
 * (and Site), counted in Postgres like every limit, so every web process shares them.
 */
export const CONTENT_API_LIMITS = {
	key: { limit: 600, windowMs: 60_000 },
	address: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/** How many days of a key's use are kept, and how many the admin shows. */
export const CONTENT_KEY_USAGE_KEPT_DAYS = 90;
export const CONTENT_KEY_USAGE_SHOWN_DAYS = 30;

/** `lastUsedAt` is written at most this often. */
const LAST_USED_EVERY_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A Content key as Staff see it; never the key itself. */
export type ContentKeyView = {
	id: string;
	name: string;
	/** The key's last 4 characters. */
	hint: string;
	/** The origins browsers on other sites may send it from, such as `https://shop.example.com`. */
	origins: string[];
	status: "active" | "revoked";
	createdAt: Date;
	/** Who made it; null once that person is deleted (or for a key made without one). */
	createdBy: { id: string; name: string } | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
	/** Requests it made: today (UTC), the last 7 and 30 days, and each of the last 30 days, oldest first. */
	usage: { today: number; last7Days: number; last30Days: number; days: { day: string; requests: number }[] };
};

export type NewContentKey = { name: string; origins?: readonly string[] };
export type ContentKeyChange = { name?: string; origins?: readonly string[] };

/** A change to the Content API's settings or keys that can't be saved: each problem at its place. */
export class ContentApiInvalidError extends Error {
	override name = "ContentApiInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(
			`The Content API settings can't be saved: ${problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ")}`,
		);
		this.problems = problems;
	}
}

/** The Site has no Content key with that id. */
export class ContentKeyNotFoundError extends Error {
	override name = "ContentKeyNotFoundError";
	constructor() {
		super("The Site has no such Content key.");
	}
}

/**
 * An origin as a browser sends it, in its normal form (`https://shop.example.com`, a port only when it
 * isn't the scheme's own), or null when the text isn't exactly one: http or https, a host, nothing
 * after it, and no wildcard (an allow-list names each origin it trusts).
 */
export function normaliseOrigin(text: string): string | null {
	const trimmed = text.trim();
	// A scheme, a host (with a port) and at most a closing slash: no path, query, fragment or wildcard.
	if (!/^https?:\/\/[^/?#\s*\\]+\/?$/i.test(trimmed)) return null;
	try {
		const url = new URL(trimmed);
		return url.username === "" && url.password === "" ? url.origin : null;
	} catch {
		return null;
	}
}

/** Hashes keys under the Master key's Content key key (`contentKeyKey`). */
export function contentKeyHasher(keyHash: CryptoKey): (secret: string) => Promise<string> {
	return async (secret) => {
		const signature = await crypto.subtle.sign("HMAC", keyHash, new TextEncoder().encode(secret));
		return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
	};
}

/** Reads a key's name, adding a problem when it can't be one. */
function keyName(value: string, problems: ContentProblem[]): string {
	const name = value.trim();
	if (name.length === 0 || name.length > CONTENT_KEY_LIMITS.name) {
		problems.push({
			at: "name",
			message: `A Content key's name has 1 to ${CONTENT_KEY_LIMITS.name} characters.`,
			rule: "contentKeyName",
			params: { max: CONTENT_KEY_LIMITS.name },
		});
	}
	return name;
}

/** Reads a key's origins in their normal form, each once, adding a problem for each that isn't one. */
function keyOrigins(values: readonly string[], problems: ContentProblem[]): string[] {
	if (values.length > CONTENT_KEY_LIMITS.origins) {
		problems.push({
			at: "origins",
			message: `A Content key lists up to ${CONTENT_KEY_LIMITS.origins} origins.`,
			rule: "contentKeyOrigins",
			params: { max: CONTENT_KEY_LIMITS.origins },
		});
		return [];
	}
	const origins: string[] = [];
	values.forEach((value, index) => {
		const origin = normaliseOrigin(value);
		if (origin === null) {
			problems.push({
				at: `origins[${index}]`,
				message:
					"An origin is a scheme and a host, with a port when it isn't the usual one, such as https://shop.example.com: no path and no wildcard.",
				rule: "contentKeyOrigin",
			});
		} else if (!origins.includes(origin)) origins.push(origin);
	});
	return origins;
}

type KeyRow = typeof contentKeys.$inferSelect;

/** The day (UTC) of a time, as `2026-03-02`. */
export function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

/** The Site's Content keys, newest first (revoked ones too), with their use. */
export async function listContentKeys(scope: SiteScope): Promise<ContentKeyView[]> {
	const rows = await scope.select(contentKeys, undefined, {
		orderBy: [desc(contentKeys.createdAt), asc(contentKeys.name)],
	});
	return keyViews(scope, rows);
}

async function keyViews(scope: SiteScope, rows: readonly KeyRow[]): Promise<ContentKeyView[]> {
	if (rows.length === 0) return [];
	const now = scope.now();
	const today = utcDay(now);
	const firstShown = utcDay(new Date(now.getTime() - (CONTENT_KEY_USAGE_SHOWN_DAYS - 1) * DAY_MS));
	const days = await scope.select(
		contentKeyUsage,
		and(
			inArray(
				contentKeyUsage.keyId,
				rows.map((row) => row.id),
			),
			gte(contentKeyUsage.day, firstShown),
		),
	);
	const creators = rows.flatMap((row) => (row.createdBy ? [row.createdBy] : []));
	const names = new Map(
		creators.length === 0
			? []
			: (
					await scope.db
						.select({ id: people.id, name: people.name })
						.from(people)
						.where(inArray(people.id, [...new Set(creators)]))
				).map((person) => [person.id, person.name]),
	);
	const shownDays = Array.from({ length: CONTENT_KEY_USAGE_SHOWN_DAYS }, (_, index) =>
		utcDay(new Date(now.getTime() - (CONTENT_KEY_USAGE_SHOWN_DAYS - 1 - index) * DAY_MS)),
	);
	const weekStart = shownDays[CONTENT_KEY_USAGE_SHOWN_DAYS - 7] ?? today;
	return rows.map((row) => {
		const own = new Map(days.filter((day) => day.keyId === row.id).map((day) => [day.day, day.requests]));
		const perDay = shownDays.map((day) => ({ day, requests: own.get(day) ?? 0 }));
		const sum = (from: string) =>
			perDay.filter((day) => day.day >= from).reduce((total, day) => total + day.requests, 0);
		return {
			id: row.id,
			name: row.name,
			hint: row.hint,
			origins: row.origins,
			status: row.revokedAt ? "revoked" : "active",
			createdAt: row.createdAt,
			createdBy: row.createdBy ? { id: row.createdBy, name: names.get(row.createdBy) ?? "" } : null,
			lastUsedAt: row.lastUsedAt,
			revokedAt: row.revokedAt,
			usage: { today: own.get(today) ?? 0, last7Days: sum(weekStart), last30Days: sum(firstShown), days: perDay },
		};
	});
}

async function keyView(scope: SiteScope, keyId: string): Promise<ContentKeyView> {
	const row = isUuid(keyId) ? await scope.first(contentKeys, eq(contentKeys.id, keyId)) : undefined;
	if (!row) throw new ContentKeyNotFoundError();
	const [view] = await keyViews(scope, [row]);
	if (!view) throw new ContentKeyNotFoundError();
	return view;
}

/**
 * Makes a Content key for the Site (open it with `structure.edit`) and answers it with the key itself,
 * the only time it is shown. Logged as `contentKey.create`, with its name and origins.
 */
export async function createContentKey(
	scope: SiteScope,
	input: NewContentKey,
	hash: (secret: string) => Promise<string>,
): Promise<{ key: ContentKeyView; secret: string }> {
	const problems: ContentProblem[] = [];
	const name = keyName(input.name, problems);
	const origins = keyOrigins(input.origins ?? [], problems);
	if (problems.length > 0) throw new ContentApiInvalidError(problems);
	const secret = `${CONTENT_KEY_PREFIX}${newToken()}`;
	const keyId = await scope.transaction(async (tx) => {
		const working = await tx.count(contentKeys, sql`${contentKeys.revokedAt} is null`);
		if (working >= CONTENT_KEY_LIMITS.keys) {
			throw new ContentApiInvalidError([
				{
					at: "keys",
					message: `A Site has up to ${CONTENT_KEY_LIMITS.keys} working Content keys: revoke one first.`,
					rule: "contentKeys",
					params: { max: CONTENT_KEY_LIMITS.keys },
				},
			]);
		}
		const row = await tx.insert(contentKeys, {
			name,
			secretHash: await hash(secret),
			hint: secret.slice(-4),
			origins,
			createdAt: tx.now(),
			createdBy: actingPerson(tx.access.actor),
		});
		await tx.audit("contentKey.create", { keyId: row.id, name, origins });
		return row.id;
	});
	return { key: await keyView(scope, keyId), secret };
}

/** Renames a key or changes its origins, at once. Logged as `contentKey.update`, with what changed. */
export async function updateContentKey(
	scope: SiteScope,
	keyId: string,
	change: ContentKeyChange,
): Promise<ContentKeyView> {
	const problems: ContentProblem[] = [];
	const name = change.name === undefined ? undefined : keyName(change.name, problems);
	const origins = change.origins === undefined ? undefined : keyOrigins(change.origins, problems);
	if (problems.length > 0) throw new ContentApiInvalidError(problems);
	await scope.transaction(async (tx) => {
		const row = isUuid(keyId)
			? (
					await tx.db
						.select()
						.from(contentKeys)
						.where(tx.where(contentKeys, eq(contentKeys.id, keyId)))
						.for("update")
				)[0]
			: undefined;
		if (!row) throw new ContentKeyNotFoundError();
		const changed: Record<string, { from: unknown; to: unknown }> = {};
		if (name !== undefined && name !== row.name) changed.name = { from: row.name, to: name };
		if (origins !== undefined && origins.join(" ") !== row.origins.join(" ")) {
			changed.origins = { from: row.origins, to: origins };
		}
		if (Object.keys(changed).length === 0) return;
		await tx.update(
			contentKeys,
			{ ...(name === undefined ? {} : { name }), ...(origins === undefined ? {} : { origins }) },
			eq(contentKeys.id, row.id),
		);
		await tx.audit("contentKey.update", { keyId: row.id, name: name ?? row.name, changed });
	});
	return keyView(scope, keyId);
}

/** Revokes a key at once: every request sending it is refused from now on. Logged as `contentKey.revoke`. */
export async function revokeContentKey(scope: SiteScope, keyId: string): Promise<ContentKeyView> {
	await scope.transaction(async (tx) => {
		const row = isUuid(keyId) ? await tx.first(contentKeys, eq(contentKeys.id, keyId)) : undefined;
		if (!row) throw new ContentKeyNotFoundError();
		if (row.revokedAt) return;
		await tx.update(contentKeys, { revokedAt: tx.now() }, eq(contentKeys.id, row.id));
		await tx.audit("contentKey.revoke", { keyId: row.id, name: row.name });
	});
	return keyView(scope, keyId);
}

/** A request's Content key, found among the Site's: working, with its origins, or why it doesn't work. */
export type FoundContentKey =
	| { ok: true; id: string; origins: readonly string[]; lastUsedAt: Date | null }
	| { ok: false; problem: "missing" | "unknown" | "revoked" };

/** The Site's key a request carries (`Authorization: Bearer <key>`), looked up by its keyed hash among the Site's keys only. */
export async function findContentKey(
	scope: Pick<VisitorScope, "first">,
	secret: string | null,
	hash: (secret: string) => Promise<string>,
): Promise<FoundContentKey> {
	if (!secret) return { ok: false, problem: "missing" };
	if (!secret.startsWith(CONTENT_KEY_PREFIX) || secret.length > 200) return { ok: false, problem: "unknown" };
	const row = await scope.first(contentKeys, eq(contentKeys.secretHash, await hash(secret)));
	if (!row) return { ok: false, problem: "unknown" };
	if (row.revokedAt) return { ok: false, problem: "revoked" };
	return { ok: true, id: row.id, origins: row.origins, lastUsedAt: row.lastUsedAt };
}

/** Whether any working key of the Site lists `origin`: what a CORS preflight, which carries no key, is answered by. */
export async function anyKeyAllows(scope: Pick<VisitorScope, "count">, origin: string): Promise<boolean> {
	return (
		(await scope.count(
			contentKeys,
			and(sql`${contentKeys.revokedAt} is null`, sql`${origin}::text = any(${contentKeys.origins})`),
		)) > 0
	);
}

/**
 * Counts one request of a key in its day (UTC), and notes when it was last used (at most once a
 * minute). The first request of a new day also deletes the key's days older than the ones kept.
 */
export async function noteContentKeyUse(
	database: Database,
	site: { id: string; workspaceId: string },
	key: { id: string; lastUsedAt: Date | null },
	now: Date,
): Promise<void> {
	const { db } = database;
	const day = utcDay(now);
	const [counted] = await db
		.insert(contentKeyUsage)
		.values({ workspaceId: site.workspaceId, siteId: site.id, keyId: key.id, day, requests: 1 })
		.onConflictDoUpdate({
			target: [contentKeyUsage.keyId, contentKeyUsage.day],
			set: { requests: sql`${contentKeyUsage.requests} + 1` },
		})
		.returning({ requests: contentKeyUsage.requests });
	if (counted?.requests === 1) {
		const oldest = utcDay(new Date(now.getTime() - (CONTENT_KEY_USAGE_KEPT_DAYS - 1) * DAY_MS));
		await db.delete(contentKeyUsage).where(and(eq(contentKeyUsage.keyId, key.id), lt(contentKeyUsage.day, oldest)));
	}
	if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
		await db
			.update(contentKeys)
			.set({ lastUsedAt: now })
			.where(and(eq(contentKeys.id, key.id), eq(contentKeys.siteId, site.id)));
	}
}
