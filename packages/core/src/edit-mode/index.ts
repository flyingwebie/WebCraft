import type { Auth } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { editLinks, editSessions } from "@webcraft/db/schema";
import type { Block } from "@webcraft/renderer";
import { and, eq, gt, isNull, lte, type SQL } from "drizzle-orm";

import type { AuditVia } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { Pasted } from "../content/body-paste.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { domainOrigin, verifiedDomains } from "../domains/addresses.ts";
import type { FocalPoint, MediaLibrary } from "../media/library.ts";
import { type PersonActor, personIdOf } from "../permissions/can.ts";
import { stagingUrl } from "../site-pages/addresses.ts";
import type { PageContent, SiteHost } from "../site-pages/index.ts";
import type { Access, DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { hashToken, newToken } from "../tokens.ts";
import { type BodyEditing, type BodyRegion, bodyEditing, pasteIntoBody } from "./body.ts";
import { EditModeUnavailableError, EditPathInvalidError, LoopItemRestoreRefusedError } from "./errors.ts";
import {
	addLoopItem,
	duplicateLoopItem,
	type EntryLink,
	entryLinks,
	type ItemOrder,
	itemIndex,
	type LoopItemValues,
	moveLoopItem,
	ownItemsLoop,
	removeLoopItem,
	restoreLoopItem,
	type SavedLoopItem,
	saveLoopItemValues,
} from "./loop-items.ts";
import {
	changeImage,
	type EditMediaItem,
	type EditMediaQuery,
	libraryImage,
	libraryImages,
	suggestImageAlt,
	uploadImage,
} from "./media.ts";
import {
	discardChanges,
	type PageDeps,
	type PageState,
	pageState,
	publishPage,
	submitPage,
	undoChange,
	withdrawPage,
} from "./page.ts";
import { type PageDetails, type PageDetailsChange, pageDetails, savePageDetails } from "./page-details.ts";
import { EDIT_MODE_PATH, isEditPath } from "./paths.ts";
import {
	type ImageChange,
	type RegionChange,
	type SavedImage,
	type SavedRegion,
	saveImage,
	saveRegion,
} from "./regions.ts";

export type { BodyEditing, BodyRegion } from "./body.ts";
export {
	EditFieldInvalidError,
	EditModeUnavailableError,
	EditPathInvalidError,
	LoopItemRestoreRefusedError,
} from "./errors.ts";
export { EDIT_MEDIA_PAGE, type EditMediaItem, type EditMediaQuery } from "./media.ts";
export type { PageChange, PageState } from "./page.ts";
export type { PageDetails, PageDetailsChange } from "./page-details.ts";
export {
	CODE_MODE_SCRIPT_PATH,
	CODE_MODE_STYLESHEET_PATH,
	EDIT_MODE_PATH,
	isCodeSelection,
	isEditPageAddress,
	isEditPath,
} from "./paths.ts";
export type { EditItem, ImageChange, RegionChange, SavedImage, SavedRegion } from "./regions.ts";

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
	openLink(
		scope: SiteScope,
		input: { adminSessionId: string; path: string; safeMode?: boolean; code?: boolean; selection?: string },
	): Promise<EditLink>;
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
	/**
	 * Puts a new image (or none) in an image region's media Field, in the Draft. Refuses a region that
	 * isn't an image's (`EditFieldInvalidError`), and anything but an image of the Site's own Media
	 * library out of the Trash.
	 */
	saveImage(session: EditSession, change: ImageChange): Promise<SavedImage>;
	/** The block editor (#79): a body region's Blocks in the page's language, and what may be added to it. */
	body(session: EditSession, region: BodyRegion): Promise<BodyEditing>;
	/** What was pasted into a body region (HTML, Markdown or plain text), as Blocks; nothing is saved. */
	pasteBody(session: EditSession, region: BodyRegion & Pasted): Promise<{ blocks: Block[] }>;
	/** What the editing bar shows for the page at `path`: its changes, the Site's pages, who is editing. */
	pageState(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
	/** Undoes one of the page's changes (`key` of `item`), answering the page's state afterwards. */
	undo(session: EditSession, host: SiteHost, input: { path: string; item: string; key: string }): Promise<PageState>;
	/** Discards every change of the page, answering the page's state afterwards. */
	discard(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
	/** Publishes the page's changes, all or none (needs `entry.publish`), answering the page's state afterwards. */
	publish(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
	/** Submits the page's changes for Review together, with an optional note, answering the page's state afterwards. */
	submitForReview(
		session: EditSession,
		host: SiteHost,
		input: { path: string; note: string | null },
	): Promise<PageState>;
	/** Withdraws the page's Reviews the person submitted, answering the page's state afterwards. */
	withdrawReview(session: EditSession, host: SiteHost, path: string): Promise<PageState>;
	/**
	 * Page details: the values of the page's Entry that don't show on the page (title, address, SEO
	 * fields, Summary, social image, noindex) in a language, with what each falls back to.
	 */
	details(session: EditSession, input: { item: string; language?: string }): Promise<PageDetails>;
	/** Saves a change from Page details to the Draft, as the admin's Entry editor does (`ENTRY_SLUG_TAKEN` and all). */
	saveDetails(
		session: EditSession,
		change: PageDetailsChange,
	): Promise<{ details: PageDetails; problems: ContentProblem[] }>;
	/** A Loop's own items, edited in place (GLOSSARY.md › Loop item): Content, in the Loop's Draft. */
	loops: {
		/**
		 * The item form of one of a Loop's own items: the Loop, its items' Fields and the item's values in a
		 * language. Refuses a query Loop and an item the Loop doesn't have (`EditFieldInvalidError`).
		 */
		item(
			session: EditSession,
			input: { loop: string; item: string; language?: string },
		): Promise<{ loop: { id: string; name: string }; fields: FieldDefinition[]; item: LoopItemValues }>;
		/** Saves some of an item's values (by key) in a language, as the item form sends them. */
		save(
			session: EditSession,
			input: { loop: string; item: string; language?: string; values: Record<string, unknown> },
		): Promise<SavedLoopItem>;
		/** Moves an item to another place (`to`, from 0), in every language. */
		move(session: EditSession, input: { loop: string; item: string; to: number }): Promise<ItemOrder>;
		/** Copies an item, with its values in every language, right after it. */
		duplicate(session: EditSession, input: { loop: string; item: string }): Promise<ItemOrder & { item: string }>;
		/**
		 * Removes an item in every language. `restore` puts it back, as it was, where it was: it holds the
		 * item signed for this session, so nothing else can be put in its place.
		 */
		remove(session: EditSession, input: { loop: string; item: string }): Promise<ItemOrder & { restore: string }>;
		/** Puts back an item `remove` removed in this session (`LoopItemRestoreRefusedError` for anything else), once. */
		restore(session: EditSession, restore: string): Promise<ItemOrder & { item: string }>;
		/** Adds an item with its Fields' defaults after one (`after`), or first. */
		add(session: EditSession, input: { loop: string; after: string | null }): Promise<ItemOrder & { item: string }>;
		/**
		 * Where a query Loop's items (Entries of the Site) are changed, in a language: each one's own page,
		 * or its editor in the admin when it has none.
		 */
		entries(session: EditSession, input: { entries: string[]; language?: string }): Promise<{ entries: EntryLink[] }>;
	};
	/** The image popover's Media library: the Site's images and folders, as the admin's Media screen has them. */
	media: {
		/** The Site's images out of the Trash, newest first, `EDIT_MEDIA_PAGE` at a time, and the library's folders. */
		list(
			session: EditSession,
			query: EditMediaQuery,
		): Promise<{ items: EditMediaItem[]; total: number; folders: { id: string; name: string; count: number }[] }>;
		/** One image, its alt text in a language, and whether alt text can be suggested (the Workspace has an AI key). */
		get(
			session: EditSession,
			mediaId: string,
			language?: string,
		): Promise<{ media: EditMediaItem; altTextSuggestions: boolean }>;
		/** Changes an image's alt text in a language, or its Focal point: live at once, as in the library. */
		update(
			session: EditSession,
			mediaId: string,
			change: { language?: string; alt?: string | null; focalPoint?: FocalPoint | null },
		): Promise<{ media: EditMediaItem }>;
		/** An AI provider's alt text for an image in a language; nothing is saved. */
		suggestAlt(session: EditSession, mediaId: string, language?: string): Promise<{ alt: string }>;
		/** Uploads a file to the library as the Media screen does (check the Install's largest file first). */
		upload(
			session: EditSession,
			upload: { fileName: string; data: Uint8Array; folderId?: string | null },
		): Promise<{ media: EditMediaItem }>;
	};
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
	/** The Sites' Media libraries. */
	media: MediaLibrary;
}): EditMode {
	const { database, clock, config, auth, data, actors, signingKey } = options;
	const deps: PageDeps = { config, data, pageContent: options.pageContent };
	const mediaDeps = { data, media: options.media };
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

	/** An HMAC of `text` under the Edit mode signing key, as base64url. */
	const sign = async (text: string) => {
		const signature = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(text));
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
			if (input.code) {
				url.searchParams.set("code", "1");
				if (input.selection) url.searchParams.set("selection", input.selection);
			}
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
				headerToken: await sign(`edit-session:${row.id}`),
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
		saveImage: (session, change) => saveImage(session.scope, change),
		body: (session, region) => bodyEditing(session.scope, region),
		pasteBody: (session, region) => pasteIntoBody(session.scope, region),
		pageState: (session, host, path) => pageState(deps, session, host, path),
		undo: (session, host, input) => undoChange(deps, session, host, input),
		discard: (session, host, path) => discardChanges(deps, session, host, path),
		publish: (session, host, path) => publishPage(deps, session, host, path),
		submitForReview: (session, host, input) => submitPage(deps, session, host, input),
		withdrawReview: (session, host, path) => withdrawPage(deps, session, host, path),
		details: (session, input) => pageDetails(session.scope, options.media, input.item, input.language),
		saveDetails: (session, change) => savePageDetails(session.scope, options.media, change),
		loops: {
			async item(session, input) {
				const loop = await ownItemsLoop(session.scope, input.loop, input.language);
				const index = itemIndex(loop, input.item);
				return {
					loop: { id: loop.id, name: loop.name },
					fields: loop.draft.fields,
					item: loop.draft.items[index] ?? { id: input.item },
				};
			},
			save: (session, input) =>
				saveLoopItemValues(session.scope, { loopId: input.loop, itemId: input.item }, input.values, input.language),
			move: (session, input) => moveLoopItem(session.scope, input.loop, input.item, input.to),
			duplicate: (session, input) => duplicateLoopItem(session.scope, input.loop, input.item),
			async remove(session, input) {
				const { items, removed } = await removeLoopItem(session.scope, input.loop, input.item);
				const payload = Buffer.from(
					JSON.stringify({ session: session.id, loop: input.loop, row: removed.row, index: removed.index }),
				).toString("base64url");
				return { items, restore: `${payload}.${await sign(`loop-restore:${payload}`)}` };
			},
			async restore(session, restore) {
				const [payload = "", signature = ""] = restore.split(".");
				const expected = await sign(`loop-restore:${payload}`);
				if (!payload || signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
					throw new LoopItemRestoreRefusedError();
				}
				const removed = readRemoved(payload);
				if (!removed || removed.session !== session.id) throw new LoopItemRestoreRefusedError();
				return restoreLoopItem(session.scope, removed.loop, { row: removed.row, index: removed.index });
			},
			add: (session, input) => addLoopItem(session.scope, input.loop, input.after),
			entries: async (session, input) => ({
				entries: await entryLinks(session.scope, config.adminOrigin, input.entries, input.language),
			}),
		},
		media: {
			list: (session, query) => libraryImages(mediaDeps, session, query),
			get: (session, mediaId, language) => libraryImage(mediaDeps, session, mediaId, language),
			update: (session, mediaId, change) => changeImage(mediaDeps, session, mediaId, change),
			suggestAlt: (session, mediaId, language) => suggestImageAlt(mediaDeps, session, mediaId, language),
			upload: (session, upload) => uploadImage(mediaDeps, session, upload),
		},
	};
}

/**
 * Limits a query on an Edit mode table to one Site (and its Workspace). These tables are read by
 * token before anyone is known to act, as sessions are, so they can't go through a person's scope.
 */
function onSite(table: typeof editLinks | typeof editSessions, site: Site, where: SQL | undefined): SQL {
	return and(eq(table.workspaceId, site.workspaceId), eq(table.siteId, site.id), where) as SQL;
}

/** Compares two strings of the same length in time that doesn't depend on where they differ. */
function timingSafeEqual(a: string, b: string): boolean {
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** What a Loop item's restore token holds, once its signature was checked; null when it isn't that shape. */
function readRemoved(
	payload: string,
): { session: string; loop: string; row: { id: string; values: Record<string, unknown> }; index: number } | null {
	try {
		const read = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
		const row = read.row as { id?: unknown; values?: unknown } | undefined;
		if (
			typeof read.session !== "string" ||
			typeof read.loop !== "string" ||
			typeof read.index !== "number" ||
			!Number.isInteger(read.index) ||
			read.index < 0 ||
			typeof row?.id !== "string" ||
			!row.values ||
			typeof row.values !== "object" ||
			Array.isArray(row.values)
		) {
			return null;
		}
		return {
			session: read.session,
			loop: read.loop,
			row: { id: row.id, values: row.values as Record<string, unknown> },
			index: read.index,
		};
	} catch {
		return null;
	}
}
