import { type Auth, hashPassword, verifyPassword } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { sites, stagingLinks, stagingSessions } from "@webcraft/db/schema";
import { and, eq, gt, isNull, lte, type SQL } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import { EditPathInvalidError } from "../edit-mode/errors.ts";
import { isEditPath } from "../edit-mode/paths.ts";
import { type PersonActor, personIdOf } from "../permissions/can.ts";
import type { RateLimitRule } from "../rate-limits.ts";
import { stagingUrl } from "../site-pages/addresses.ts";
import type { SiteHost } from "../site-pages/index.ts";
import type { Access, DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { hashToken, newToken } from "../tokens.ts";

export { STAGING_PAGE_POLICY, STAGING_PATH, STAGING_STYLESHEET, type StagingPageOptions, stagingPage } from "./page.ts";
export { type StagingWords, stagingWords } from "./words.ts";

/** How long a link opening the Staging address works after the admin makes it. */
export const STAGING_LINK_LIFETIME_MS = 60 * 1000;

/** How long a Staging session (its cookie on the Staging address) lasts at most. */
export const STAGING_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

/**
 * How long the staging password lets a browser in once given: a week, or until the password changes
 * or is removed. Long enough for a client to come back to a review; short enough that a forwarded
 * link stops working by itself.
 */
export const STAGING_PASSWORD_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;

/** How many passwords one client address may try on one Site's Staging address a minute, as many as signing in. */
export const STAGING_PASSWORD_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60_000 };

/** The shortest and longest staging password. It guards Drafts, not an account, but is still guessed from outside. */
export const STAGING_PASSWORD_MIN_LENGTH = 8;
export const STAGING_PASSWORD_MAX_LENGTH = 200;

/** A Site with no Staging address (the Install has no sites domain) can't be opened there. */
export class StagingUnavailableError extends Error {
	override name = "StagingUnavailableError";
	constructor() {
		super("This Site has no Staging address: the Install has no sites domain (WEBCRAFT_SITES_DOMAIN).");
	}
}

/** A staging password that is too short or too long. */
export class StagingPasswordInvalidError extends Error {
	override name = "StagingPasswordInvalidError";
	constructor() {
		super(
			`A staging password has ${STAGING_PASSWORD_MIN_LENGTH} to ${STAGING_PASSWORD_MAX_LENGTH} characters, not only spaces.`,
		);
	}
}

/** A link that opens a Site's Staging address, made from the admin. */
export type StagingLink = { url: string; expiresAt: Date };

/** What following a link started: the Staging cookie's value, until when it lasts, and the page to open. */
export type EnteredStaging = { cookie: string; expiresAt: Date; path: string };

/** What letting someone in with the staging password gives their browser: the cookie's value, and until when. */
export type PasswordAccess = { cookie: string; expiresAt: Date };

/** The Site's Staging address as Site settings shows it. */
export type StagingSettings = {
	/** The Staging address, such as `https://bakery.sites.example.com`; null without a sites domain. */
	url: string | null;
	/** Whether the Site has a staging password, and when it was last set or removed. */
	password: { set: boolean; changedAt: Date | null };
};

/**
 * The Staging address (ADR 0014): the Site with all its Drafts, for the agency and its client to
 * review before anything is published. Only the people reviewing it may open it: someone signed in to
 * the admin who sees the Site (they open it from the admin, which hands their browser a single-use
 * link, as Edit mode does), or, when the Site has a staging password, anyone who gives it.
 */
export type Staging = {
	/**
	 * Makes a link that opens `path` on the Site's Staging address for the person, from their admin
	 * session (open the Site with `site.view`). It works once, within 60 seconds, and only on that
	 * Site. Refuses a path that isn't one on the Site (`EditPathInvalidError`) and a Site with no
	 * Staging address (`StagingUnavailableError`).
	 */
	openLink(scope: SiteScope, input: { adminSessionId: string; path: string }): Promise<StagingLink>;
	/**
	 * Follows a link on the Staging address it was made for: uses it up and starts a Staging session,
	 * for at most 8 hours. Null when the link isn't one (unknown, used, expired or another Site's), the
	 * admin session it was made in has ended, or the person no longer sees the Site.
	 */
	enter(host: SiteHost, token: string): Promise<EnteredStaging | null>;
	/**
	 * Whether a Staging cookie holds on this Site, checked again: it hasn't run out, the admin session
	 * it came from is still signed in, and the person still sees the Site. A session that failed a
	 * check is ended.
	 */
	session(host: SiteHost, cookie: string): Promise<boolean>;
	/** The Site's Staging address and whether it has a staging password. */
	settings(scope: SiteScope): Promise<StagingSettings>;
	/**
	 * Sets the Site's staging password, or removes it (null). Only its hash is kept; what the old one
	 * let in stops working. Logged as `stagingPassword.change`, without the password.
	 */
	setPassword(scope: SiteScope, password: string | null): Promise<StagingSettings>;
	/** Whether a Site has a staging password: its Staging address then offers the password form. */
	hasPassword(site: Site): Promise<boolean>;
	/** Lets a browser in with the staging password given; null when the Site has none, or that isn't it. */
	tryPassword(host: SiteHost, password: string): Promise<PasswordAccess | null>;
	/** Whether the cookie the password let in with still holds: for this Site, its password unchanged, not run out. */
	passwordAccess(host: SiteHost, cookie: string): Promise<boolean>;
};

export function createStaging(options: {
	database: Database;
	clock: Clock;
	config: InstallConfig;
	auth: Pick<Auth, "activeSession">;
	data: DataLayer;
	actors: { person(personId: string): Promise<PersonActor> };
	/** Signs what the staging password lets in (HMAC-SHA256), derived from the Master key. */
	passwordKey: CryptoKey;
}): Staging {
	const { database, clock, config, auth, data, actors, passwordKey } = options;
	const { db } = database;

	/** Whether the person still sees the Site, with the Permission every way into it needs. */
	const seesSite = async (personId: string, site: Site): Promise<boolean> => {
		const access: Access = { actor: await actors.person(personId), via: { kind: "admin" } };
		try {
			await data.site(access, site.id, "site.view");
			return true;
		} catch (error) {
			if (error instanceof SiteNotFoundError || error instanceof PermissionDeniedError) return false;
			throw error;
		}
	};

	/** The Site's staging password as stored: its hash, and when it was last set or removed. */
	const passwordOf = async (site: Site) => {
		const [row] = await db
			.select({ hash: sites.stagingPasswordHash, changedAt: sites.stagingPasswordChangedAt })
			.from(sites)
			.where(and(eq(sites.id, site.id), eq(sites.workspaceId, site.workspaceId)));
		return { hash: row?.hash ?? null, changedAt: row?.changedAt ?? null };
	};

	/**
	 * What a password cookie signs: the Site, the password's hash (salted afresh each time it is set,
	 * so setting it again, even to the same password, shuts out every cookie made before) and until
	 * when it holds.
	 */
	const accessMessage = (site: Site, hash: string, expiresAt: number) =>
		new TextEncoder().encode(`staging-password:${site.id}:${hash}:${expiresAt}`);

	const settingsOf = async (scope: SiteScope): Promise<StagingSettings> => {
		const password = await passwordOf(scope.site);
		return {
			url: stagingUrl(config, scope.site.slug),
			password: { set: password.hash !== null, changedAt: password.changedAt },
		};
	};

	return {
		async openLink(scope, input) {
			if (!isEditPath(input.path)) throw new EditPathInvalidError();
			const address = stagingUrl(config, scope.site.slug);
			if (!address) throw new StagingUnavailableError();
			const personId = personIdOf(scope.access.actor);
			if (!personId) throw new PermissionDeniedError("site.view");
			const token = newToken();
			const now = scope.now();
			const expiresAt = new Date(now.getTime() + STAGING_LINK_LIFETIME_MS);
			await scope.insert(stagingLinks, {
				personId,
				adminSessionId: input.adminSessionId,
				tokenHash: await hashToken(token),
				path: input.path,
				expiresAt,
				createdAt: now,
			});
			const url = new URL(`${STAGING_ENTER_PATH}`, address);
			url.searchParams.set("token", token);
			return { url: url.toString(), expiresAt };
		},

		async enter(host, token) {
			const now = clock.now();
			// Using the link up first: two requests racing with it can't both get in.
			const [link] = await db
				.update(stagingLinks)
				.set({ usedAt: now })
				.where(
					onSite(
						stagingLinks,
						host.site,
						and(
							eq(stagingLinks.tokenHash, await hashToken(token)),
							isNull(stagingLinks.usedAt),
							gt(stagingLinks.expiresAt, now),
						),
					),
				)
				.returning();
			if (!link) return null;
			const adminSession = await auth.activeSession(link.adminSessionId);
			if (adminSession?.personId !== link.personId) return null;
			if (!(await seesSite(link.personId, host.site))) return null;
			const cookie = newToken();
			const expiresAt = new Date(now.getTime() + STAGING_SESSION_LIFETIME_MS);
			await db.insert(stagingSessions).values({
				workspaceId: host.site.workspaceId,
				siteId: host.site.id,
				personId: link.personId,
				adminSessionId: link.adminSessionId,
				tokenHash: await hashToken(cookie),
				expiresAt,
				createdAt: now,
			});
			// Links and sessions that ran out are kept no longer than needed.
			await db.delete(stagingLinks).where(lte(stagingLinks.expiresAt, now));
			await db.delete(stagingSessions).where(lte(stagingSessions.expiresAt, now));
			return { cookie, expiresAt, path: link.path };
		},

		async session(host, cookie) {
			const [row] = await db
				.select()
				.from(stagingSessions)
				.where(onSite(stagingSessions, host.site, eq(stagingSessions.tokenHash, await hashToken(cookie))));
			if (!row) return false;
			const ended = async () => {
				await db.delete(stagingSessions).where(eq(stagingSessions.id, row.id));
				return false;
			};
			if (row.expiresAt.getTime() <= clock.now().getTime()) return ended();
			const adminSession = await auth.activeSession(row.adminSessionId);
			if (adminSession?.personId !== row.personId) return ended();
			if (!(await seesSite(row.personId, host.site))) return ended();
			return true;
		},

		settings: settingsOf,

		async setPassword(scope, password) {
			if (password !== null) {
				const length = [...password].length;
				if (password.trim() === "" || length < STAGING_PASSWORD_MIN_LENGTH || length > STAGING_PASSWORD_MAX_LENGTH) {
					throw new StagingPasswordInvalidError();
				}
			}
			const hash = password === null ? null : await hashPassword(password);
			await scope.transaction(async (tx) => {
				await tx.db
					.update(sites)
					.set({ stagingPasswordHash: hash, stagingPasswordChangedAt: tx.now() })
					.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)));
				await tx.audit("stagingPassword.change", { set: hash !== null });
			});
			return settingsOf(scope);
		},

		async hasPassword(site) {
			return (await passwordOf(site)).hash !== null;
		},

		async tryPassword(host, password) {
			const stored = await passwordOf(host.site);
			if (!stored.hash || password === "" || [...password].length > STAGING_PASSWORD_MAX_LENGTH) return null;
			if (!(await verifyPassword(stored.hash, password))) return null;
			const expiresAt = clock.now().getTime() + STAGING_PASSWORD_ACCESS_MS;
			const signature = await crypto.subtle.sign("HMAC", passwordKey, accessMessage(host.site, stored.hash, expiresAt));
			return {
				cookie: `${expiresAt.toString(36)}.${Buffer.from(signature).toString("base64url")}`,
				expiresAt: new Date(expiresAt),
			};
		},

		async passwordAccess(host, cookie) {
			const parts = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
			if (!parts) return false;
			const expiresAt = Number.parseInt(parts[1] ?? "", 36);
			if (!Number.isSafeInteger(expiresAt) || expiresAt <= clock.now().getTime()) return false;
			const stored = await passwordOf(host.site);
			if (!stored.hash) return false;
			return crypto.subtle.verify(
				"HMAC",
				passwordKey,
				new Uint8Array(Buffer.from(parts[2] ?? "", "base64url")),
				accessMessage(host.site, stored.hash, expiresAt),
			);
		},
	};
}

/** Where a link from the admin is followed on the Staging address. */
export const STAGING_ENTER_PATH = "/_webcraft/staging/enter";

/** Where the password form posts on the Staging address. */
export const STAGING_PASSWORD_PATH = "/_webcraft/staging/password";

/**
 * Limits a query on a Staging table to one Site (and its Workspace). These tables are read by token
 * before anyone is known to act, so they can't go through a person's scope.
 */
function onSite(table: typeof stagingLinks | typeof stagingSessions, site: Site, where: SQL | undefined): SQL {
	return and(eq(table.workspaceId, site.workspaceId), eq(table.siteId, site.id), where) as SQL;
}
