import type { Auth } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { editLinks, editSessions } from "@webcraft/db/schema";
import { and, eq, gt, isNull, lte, type SQL } from "drizzle-orm";

import type { AuditVia } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import { domainOrigin, verifiedDomains } from "../domains/addresses.ts";
import { type PersonActor, personIdOf } from "../permissions/can.ts";
import { stagingUrl } from "../site-pages/addresses.ts";
import type { PageContent, SiteHost } from "../site-pages/index.ts";
import type { Access, DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { hashToken, newToken } from "../tokens.ts";
import { EditModeUnavailableError, EditPathInvalidError } from "./errors.ts";
import { discardChanges, type PageDeps, type PageState, pageState, publishPage, undoChange } from "./page.ts";
import { EDIT_MODE_PATH, isEditPath } from "./paths.ts";
import { type RegionChange, type SavedRegion, saveRegion } from "./regions.ts";

export { EditFieldInvalidError, EditModeUnavailableError, EditPathInvalidError } from "./errors.ts";
export type { PageChange, PageState } from "./page.ts";
export { CODE_MODE_SCRIPT_PATH, CODE_MODE_STYLESHEET_PATH, EDIT_MODE_PATH, isEditPath } from "./paths.ts";
export type { EditItem, RegionChange, SavedRegion } from "./regions.ts";

/** How long an "Edit on site" link works after it is made. */
export const EDIT_LINK_LIFETIME_MS = 60 * 1000;

/** How long an Edit mode session (its cookie on the Site's domain) lasts at most. */
export const EDIT_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** How actions taken in Edit mode come in, for the Audit log. */
export const EDIT_MODE_VIA: AuditVia = { kind: "editMode" };

/** A link that opens a Site in Edit mode, made by "Edit on site". */
export type EditLink = { url: string; expiresAt: Date };

/** What following a link started: the edit cookie's value, until when it lasts, and the page to open. */
export type EnteredEditMode = { cookie: string; expiresAt: Date; path: string };

/**
 * One browser in Edit mode on one Site: whose it is, the Site opened for them with `entry.edit`
 * (checked again for this request), and the header token every edit request must carry.
 */
export type EditSession = {
	id: string;
	personId: string;
	/** The admin session it belongs to: signing out of the admin ends Edit mode with it. */
	adminSessionId: string;
	expiresAt: Date;
	access: Access;
	/** The Site, opened for the person with `entry.edit`. */
	scope: SiteScope;
	/** The token edit requests send in a header, so no other site can make them with the cookie. */
	headerToken: string;
};

/**
 * Edit mode (ADR 0022): a person signed in to the admin opens a Site on its own domain, sees its
 * Drafts and changes Content in place. The admin's session cookie never reaches the Site's domain,
 * so the admin hands over a single-use link instead, and every request in Edit mode checks the
 * admin session it came from, and the person's access, again.
 */
export type EditMode = {
	/**
	 * Makes an "Edit on site" link for the person, from their admin session (open the Site with
	 * `entry.edit`): it opens `path` on the Site's own address, works once, within 60 seconds, and
	 * only on that Site. With `safeMode`, the link opens Safe mode (ADR 0022): pages run none of the
	 * Site's own scripts. Refuses a path that isn't one on the Site (`EditPathInvalidError`), and a Site
	 * with no address yet (`EditModeUnavailableError`).
	 */
	openLink(scope: SiteScope, input: { adminSessionId: string; path: string; safeMode?: boolean }): Promise<EditLink>;
	/**
	 * Follows a link on the Site it was made for: uses it up and starts an Edit mode session, for at
	 * most 8 hours. Null when the link isn't one (unknown, used, expired or another Site's), the admin
	 * session it was made in has ended, or the person no longer reaches the Site.
	 */
	enter(host: SiteHost, token: string): Promise<EnteredEditMode | null>;
	/**
	 * The Edit mode session an edit cookie holds on this Site, checked again: it hasn't run out, the
	 * admin session it came from is still signed in, and the person still reaches the Site with
	 * `entry.edit`. Null otherwise, and a session that failed a check is ended.
	 */
	session(host: SiteHost, cookie: string): Promise<EditSession | null>;
	/** Whether `token` is the session's header token. */
	checkHeaderToken(session: EditSession, token: string): Promise<boolean>;
	/** Ends an Edit mode session: its cookie opens nothing any more. */
	end(session: Pick<EditSession, "id">): Promise<void>;
	/**
	 * Saves a value typed in place to the Draft, through the same path as the admin. Refuses what
	 * can't be changed in place (`EditFieldInvalidError`), and an Entry that isn't the Site's.
	 */
	save(session: EditSession, change: RegionChange): Promise<SavedRegion>;
	/** What the editing bar shows for the page at `path`: its changes, the Site's pages, who is editing. */
	pageState(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
	/** Undoes one of the page's changes (`key` of `item`), answering the page's state afterwards. */
	undo(session: EditSession, host: SiteHost, input: { path: string; item: string; key: string }): Promise<PageState>;
	/** Discards every change of the page, answering the page's state afterwards. */
	discard(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
	/** Publishes the page's changes, all or none (needs `entry.publish`), answering the page's state afterwards. */
	publish(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
};

export function createEditMode(options: {
	database: Database;
	clock: Clock;
	config: InstallConfig;
	auth: Pick<Auth, "activeSession">;
	data: DataLayer;
	actors: { person(personId: string): Promise<PersonActor> };
	/**
	 * Whether the person must set up two-factor authentication before anything else: their admin
	 * session then reaches nothing here either.
	 */
	mustSetUpTwoFactor(personId: string): Promise<boolean>;
	/** Signs header tokens (HMAC-SHA256), derived from the Master key. */
	signingKey: CryptoKey;
	/** What a page shows from the content store (`SitePages.pageContent`). */
	pageContent(host: SiteHost, pathname: string): Promise<PageContent>;
}): EditMode {
	const { database, clock, config, auth, data, actors, signingKey } = options;
	const deps: PageDeps = { config, data, pageContent: options.pageContent };
	const { db } = database;

	/**
	 * Opens the Site for the person in Edit mode with `entry.edit`, or null when they no longer
	 * reach it (or no longer may edit there).
	 */
	const openSite = async (personId: string, site: Site): Promise<{ access: Access; scope: SiteScope } | null> => {
		const access: Access = { actor: await actors.person(personId), via: EDIT_MODE_VIA };
		try {
			return { access, scope: await data.site(access, site.id, "entry.edit") };
		} catch (error) {
			if (error instanceof SiteNotFoundError || error instanceof PermissionDeniedError) return null;
			throw error;
		}
	};

	const sign = async (sessionId: string) => {
		const signature = await crypto.subtle.sign(
			"HMAC",
			signingKey,
			new TextEncoder().encode(`edit-session:${sessionId}`),
		);
		return Buffer.from(signature).toString("base64url");
	};

	return {
		async openLink(scope, input) {
			if (!isEditPath(input.path)) throw new EditPathInvalidError();
			// The Site's Primary domain once verified (the edit cookie then lives there), else its Staging address.
			const { primary } = await verifiedDomains(scope.db, scope.site);
			const address = primary ? domainOrigin(config, primary) : stagingUrl(config, scope.site.slug);
			if (!address) throw new EditModeUnavailableError();
			const personId = personIdOf(scope.access.actor);
			if (!personId) throw new PermissionDeniedError("entry.edit");
			const token = newToken();
			const now = scope.now();
			const expiresAt = new Date(now.getTime() + EDIT_LINK_LIFETIME_MS);
			await scope.insert(editLinks, {
				personId,
				adminSessionId: input.adminSessionId,
				tokenHash: await hashToken(token),
				path: input.path,
				expiresAt,
				createdAt: now,
			});
			const url = new URL(`${EDIT_MODE_PATH}enter`, address);
			url.searchParams.set("token", token);
			// Safe mode only takes scripts away, so the link may say it openly.
			if (input.safeMode) url.searchParams.set("safe", "1");
			return { url: url.toString(), expiresAt };
		},

		async enter(host, token) {
			const now = clock.now();
			// Using the link up first: two requests racing with it can't both get in.
			const [link] = await db
				.update(editLinks)
				.set({ usedAt: now })
				.where(
					onSite(
						editLinks,
						host.site,
						and(
							eq(editLinks.tokenHash, await hashToken(token)),
							isNull(editLinks.usedAt),
							gt(editLinks.expiresAt, now),
						),
					),
				)
				.returning();
			if (!link) return null;
			const adminSession = await auth.activeSession(link.adminSessionId);
			if (adminSession?.personId !== link.personId) return null;
			if (await options.mustSetUpTwoFactor(link.personId)) return null;
			const opened = await openSite(link.personId, host.site);
			if (!opened) return null;
			const cookie = newToken();
			const expiresAt = new Date(now.getTime() + EDIT_SESSION_LIFETIME_MS);
			await opened.scope.transaction(async (tx) => {
				await tx.insert(editSessions, {
					personId: link.personId,
					adminSessionId: link.adminSessionId,
					tokenHash: await hashToken(cookie),
					expiresAt,
					createdAt: now,
				});
				await tx.audit("editMode.start", { path: link.path });
			});
			// Links and sessions that ran out are kept no longer than needed (on every Site: no person
			// reads them any more).
			await db.delete(editLinks).where(lte(editLinks.expiresAt, now));
			await db.delete(editSessions).where(lte(editSessions.expiresAt, now));
			return { cookie, expiresAt, path: link.path };
		},

		async session(host, cookie) {
			const [row] = await db
				.select()
				.from(editSessions)
				.where(onSite(editSessions, host.site, eq(editSessions.tokenHash, await hashToken(cookie))));
			if (!row) return null;
			const ended = async () => {
				await db.delete(editSessions).where(eq(editSessions.id, row.id));
				return null;
			};
			if (row.expiresAt.getTime() <= clock.now().getTime()) return ended();
			const adminSession = await auth.activeSession(row.adminSessionId);
			if (adminSession?.personId !== row.personId) return ended();
			if (await options.mustSetUpTwoFactor(row.personId)) return ended();
			const opened = await openSite(row.personId, host.site);
			if (!opened) return ended();
			return {
				id: row.id,
				personId: row.personId,
				adminSessionId: row.adminSessionId,
				expiresAt: row.expiresAt,
				access: opened.access,
				scope: opened.scope,
				headerToken: await sign(row.id),
			};
		},

		async checkHeaderToken(session, token) {
			// Buffer reads base64url leniently, so a token is first required to be exactly that form.
			if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
			const signature = new Uint8Array(Buffer.from(token, "base64url"));
			return crypto.subtle.verify(
				"HMAC",
				signingKey,
				signature,
				new TextEncoder().encode(`edit-session:${session.id}`),
			);
		},

		async end(session) {
			await db.delete(editSessions).where(eq(editSessions.id, session.id));
		},

		save: (session, change) => saveRegion(session.scope, change),
		pageState: (session, host, path) => pageState(deps, session, host, path),
		undo: (session, host, input) => undoChange(deps, session, host, input),
		discard: (session, host, path) => discardChanges(deps, session, host, path),
		publish: (session, host, path) => publishPage(deps, session, host, path),
	};
}

/**
 * Limits a query on an Edit mode table to one Site (and its Workspace). These tables are read by
 * token before anyone is known to act, as sessions are, so they can't go through a person's scope.
 */
function onSite(table: typeof editLinks | typeof editSessions, site: Site, where: SQL | undefined): SQL {
	return and(eq(table.workspaceId, site.workspaceId), eq(table.siteId, site.id), where) as SQL;
}
