import { hashPassword, verifyPassword } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { shareLinks } from "@webcraft/db/schema";
import { and, eq, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { type InstallConfig, isDevelopmentHostname } from "../config.ts";
import type { Dashboards } from "../dashboards/index.ts";
import { type DashboardRange, resolveRange } from "../dashboards/model.ts";
import type { DashboardPlace } from "../dashboards/views.ts";
import { personIdOf } from "../permissions/can.ts";
import type { Access, BackgroundScope, DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { hashToken, newToken } from "../tokens.ts";
import { resolveBrand } from "./branding.ts";
import { ShareLinkInvalidError, ShareLinkNotFoundError, ShareLinksUnavailableError } from "./errors.ts";
import { isReportLanguage, previousOf, rangeOf, SHARE_LINK_LABEL } from "./model.ts";
import { type ReportExplore, reportPage } from "./page.ts";
import { inPlace, type OpenedDashboardPlace, openPlace, requireDashboard, scoped } from "./service.ts";

/**
 * Share links (GLOSSARY.md, #104): someone without an account explores a Dashboard through a link, on
 * the Install's own Share link address under the sites domain (`share.<sites domain>`, never a Site's
 * own domains), changing its days and filters and nothing else. A link may have a password (its
 * scrypt hash kept) and an expiry, and is revoked at once. Only the token's SHA-256 hash is kept, so
 * the link is shown once, when it is made. Opens are counted (how many, and the last one), with
 * nothing about who opened it. Dashboards' own rules for people with accounts are untouched.
 */

/** A Share link's password: as long as a staging password. */
export const SHARE_LINK_PASSWORD = { min: 8, max: 200 } as const;

/** How long the right password lets a browser in: a week, or until the password changes or the link ends. */
export const SHARE_LINK_PASSWORD_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;

/** How many Share links one Dashboard has at most (revoked ones included). */
export const MAX_SHARE_LINKS = 20;

/** The latest expiry, from now. */
const LONGEST_EXPIRY_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/** A Share link, as the admin lists it. */
export type ShareLinkView = {
	id: string;
	dashboardId: string;
	name: string;
	language: string;
	/** The token's last 4 characters, to tell links apart. */
	hint: string;
	password: boolean;
	expiresAt: Date | null;
	revokedAt: Date | null;
	state: "active" | "expired" | "revoked";
	opens: number;
	lastOpenedAt: Date | null;
	createdAt: Date;
};

/** A Share link found by its token, still working: what its address needs. */
export type OpenShareLink = {
	id: string;
	place: DashboardPlace;
	workspaceId: string;
	siteId: string | null;
	dashboardId: string;
	name: string;
	language: string;
	passwordHash: string | null;
	expiresAt: Date | null;
};

export type ShareLinkInput = {
	name: string;
	language: string;
	password: string | null;
	expiresAt: Date | null;
};

export type ShareLinks = {
	list(access: Access, place: DashboardPlace, dashboardId: string): Promise<ShareLinkView[]>;
	/**
	 * A new link: answered once with its address, never again. Takes the place already opened for
	 * `shareLink.manage` (the procedure opens it once, before the Sensitive action's gate, and keeps
	 * it on the context), rather than opening it again here.
	 */
	create(
		opened: OpenedDashboardPlace,
		dashboardId: string,
		input: ShareLinkInput,
	): Promise<{ link: ShareLinkView; url: string }>;
	/**
	 * Changes a link's name, language, password (null removes it) or expiry (null: none). Takes the
	 * place already opened for `shareLink.manage`, as `create` does.
	 */
	update(opened: OpenedDashboardPlace, shareLinkId: string, input: Partial<ShareLinkInput>): Promise<ShareLinkView>;
	revoke(access: Access, place: DashboardPlace, shareLinkId: string): Promise<ShareLinkView>;
	/** The Share link address's hostname, or null when the Install has no sites domain. */
	hostname(): string | null;
	/** A link that still works, by its token; null for one unknown, revoked or expired, alike. */
	find(token: string): Promise<OpenShareLink | null>;
	/** Lets a browser in with the link's password; null when that isn't it. */
	tryPassword(link: OpenShareLink, password: string): Promise<{ cookie: string; expiresAt: Date } | null>;
	/** Whether the cookie the password let in with still holds: this link, its password unchanged, not run out. */
	passwordAccess(link: OpenShareLink, cookie: string): Promise<boolean>;
	/** The link's page: its Dashboard explored, compared with the days before. Null when the Dashboard is gone. */
	page(link: OpenShareLink, explore: ReportExplore): Promise<string | null>;
	/** Counts an open of the link (how many, and when last; nothing about who). */
	opened(link: OpenShareLink): Promise<void>;
};

type Row = typeof shareLinks.$inferSelect;

export function createShareLinks(deps: {
	database: Database;
	data: DataLayer;
	dashboards: Dashboards;
	clock: Clock;
	config: InstallConfig;
	/** The key a password's access is signed with (`shareLinkPasswordKey`). */
	passwordKey: CryptoKey;
}): ShareLinks {
	const { database, data, clock, config, passwordKey } = deps;

	const hostname = () => (config.sitesDomain ? `${SHARE_LINK_LABEL}.${config.sitesDomain}` : null);

	const urlOf = (token: string): string => {
		const host = hostname();
		if (!host) throw new ShareLinksUnavailableError();
		if (!isDevelopmentHostname(host)) return `https://${host}/${token}`;
		const port = isDevelopmentHostname(config.adminHost) ? new URL(config.adminOrigin).port : "";
		return `http://${host}:${port || "3000"}/${token}`;
	};

	const viewOf = (row: Row): ShareLinkView => {
		const now = clock.now().getTime();
		return {
			id: row.id,
			dashboardId: (row.dashboardId ?? row.workspaceDashboardId) as string,
			name: row.name,
			language: row.language,
			hint: row.tokenHint,
			password: row.passwordHash !== null,
			expiresAt: row.expiresAt,
			revokedAt: row.revokedAt,
			state: row.revokedAt ? "revoked" : row.expiresAt && row.expiresAt.getTime() <= now ? "expired" : "active",
			opens: row.opens,
			lastOpenedAt: row.lastOpenedAt,
			createdAt: row.createdAt,
		};
	};

	const checkedName = (name: string) => {
		const trimmed = name.trim();
		if (trimmed === "" || trimmed.length > 100) {
			throw new ShareLinkInvalidError("name", "A Share link's name has 1 to 100 characters.");
		}
		return trimmed;
	};

	const checkedLanguage = (language: string) => {
		if (!isReportLanguage(language)) throw new ShareLinkInvalidError("language", "A Share link's page is in en or it.");
		return language;
	};

	const checkedPassword = async (password: string | null) => {
		if (password === null) return null;
		const length = [...password].length;
		if (password.trim() === "" || length < SHARE_LINK_PASSWORD.min || length > SHARE_LINK_PASSWORD.max) {
			throw new ShareLinkInvalidError(
				"password",
				`A Share link's password has ${SHARE_LINK_PASSWORD.min} to ${SHARE_LINK_PASSWORD.max} characters.`,
			);
		}
		return hashPassword(password);
	};

	const checkedExpiry = (expiresAt: Date | null) => {
		if (expiresAt === null) return null;
		const at = expiresAt.getTime();
		const now = clock.now().getTime();
		if (!Number.isFinite(at) || at <= now || at > now + LONGEST_EXPIRY_MS) {
			throw new ShareLinkInvalidError("expiresAt", "A Share link expires in the future, within five years.");
		}
		return expiresAt;
	};

	const linkOf = async (opened: Awaited<ReturnType<typeof openPlace>>, shareLinkId: string): Promise<Row> => {
		const row = await scoped(opened).first(
			shareLinks,
			inPlace(opened.level, shareLinks, eq(shareLinks.id, shareLinkId)),
		);
		if (!row) throw new ShareLinkNotFoundError();
		return row;
	};

	const accessMessage = (link: OpenShareLink, expiresAt: number) =>
		new TextEncoder().encode(`${link.id}\n${link.passwordHash ?? ""}\n${expiresAt}`);

	return {
		hostname,

		async list(access, place, dashboardId) {
			const opened = await openPlace(data, access, place, "shareLink.view");
			await requireDashboard(opened, dashboardId);
			const column = opened.level === "site" ? shareLinks.dashboardId : shareLinks.workspaceDashboardId;
			const rows = await scoped(opened).select(shareLinks, inPlace(opened.level, shareLinks, eq(column, dashboardId)), {
				orderBy: [shareLinks.createdAt],
			});
			return rows.map(viewOf);
		},

		async create(opened, dashboardId, input) {
			await requireDashboard(opened, dashboardId);
			if (!hostname()) throw new ShareLinksUnavailableError();
			const column = opened.level === "site" ? shareLinks.dashboardId : shareLinks.workspaceDashboardId;
			if (
				(await scoped(opened).count(shareLinks, inPlace(opened.level, shareLinks, eq(column, dashboardId)))) >=
				MAX_SHARE_LINKS
			) {
				throw new ShareLinkInvalidError("links", `A Dashboard has at most ${MAX_SHARE_LINKS} Share links.`);
			}
			const name = checkedName(input.name);
			const language = checkedLanguage(input.language);
			const passwordHash = await checkedPassword(input.password);
			const expiresAt = checkedExpiry(input.expiresAt);
			const token = newToken();
			const now = clock.now();
			const scope: SiteScope = scoped(opened);
			const row = await scope.transaction(async (tx) => {
				const made = await tx.insert(shareLinks, {
					...(opened.level === "site" ? { dashboardId } : { workspaceDashboardId: dashboardId }),
					name,
					language,
					tokenHash: await hashToken(token),
					tokenHint: token.slice(-4),
					passwordHash,
					passwordChangedAt: passwordHash ? now : null,
					expiresAt,
					createdAt: now,
					createdBy: personIdOf(opened.scope.access.actor),
				} as never);
				await tx.audit("shareLink.create", {
					shareLinkId: made.id,
					dashboardId,
					name,
					password: passwordHash !== null,
					expiresAt: expiresAt?.toISOString() ?? null,
				});
				return made;
			});
			return { link: viewOf(row), url: urlOf(token) };
		},

		async update(opened, shareLinkId, input) {
			const current = await linkOf(opened, shareLinkId);
			if (current.revokedAt) throw new ShareLinkNotFoundError();
			const now = clock.now();
			const set = {
				...(input.name !== undefined ? { name: checkedName(input.name) } : {}),
				...(input.language !== undefined ? { language: checkedLanguage(input.language) } : {}),
				...(input.password !== undefined
					? { passwordHash: await checkedPassword(input.password), passwordChangedAt: now }
					: {}),
				...(input.expiresAt !== undefined ? { expiresAt: checkedExpiry(input.expiresAt) } : {}),
			};
			const scope: SiteScope = scoped(opened);
			const [row] = await scope.transaction(async (tx) => {
				const updated = await tx.update(
					shareLinks,
					set as never,
					inPlace(opened.level, shareLinks, eq(shareLinks.id, shareLinkId)),
				);
				await tx.audit("shareLink.update", {
					shareLinkId,
					name: updated[0]?.name ?? current.name,
					changed: Object.keys(set).filter((key) => key !== "passwordChangedAt"),
					...(input.password !== undefined ? { password: input.password !== null } : {}),
				});
				return updated;
			});
			return viewOf(row as Row);
		},

		async revoke(access, place, shareLinkId) {
			const opened = await openPlace(data, access, place, "shareLink.manage");
			const current = await linkOf(opened, shareLinkId);
			if (current.revokedAt) return viewOf(current);
			const scope: SiteScope = scoped(opened);
			const [row] = await scope.transaction(async (tx) => {
				const updated = await tx.update(
					shareLinks,
					{ revokedAt: clock.now() } as never,
					inPlace(opened.level, shareLinks, eq(shareLinks.id, shareLinkId)),
				);
				await tx.audit("shareLink.revoke", { shareLinkId, name: current.name });
				return updated;
			});
			return viewOf(row as Row);
		},

		async find(token) {
			if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
			// Found by its token before anyone is known to act: the token is what lets them in.
			const [row] = await database.db
				.select()
				.from(shareLinks)
				.where(eq(shareLinks.tokenHash, await hashToken(token)));
			if (!row || row.revokedAt) return null;
			if (row.expiresAt && row.expiresAt.getTime() <= clock.now().getTime()) return null;
			const dashboardId = (row.dashboardId ?? row.workspaceDashboardId) as string;
			return {
				id: row.id,
				place: row.siteId ? { siteId: row.siteId } : { workspaceId: row.workspaceId },
				workspaceId: row.workspaceId,
				siteId: row.siteId,
				dashboardId,
				name: row.name,
				language: row.language,
				passwordHash: row.passwordHash,
				expiresAt: row.expiresAt,
			};
		},

		async tryPassword(link, password) {
			if (!link.passwordHash || password === "" || [...password].length > SHARE_LINK_PASSWORD.max) return null;
			if (!(await verifyPassword(link.passwordHash, password))) return null;
			const until = Math.min(
				clock.now().getTime() + SHARE_LINK_PASSWORD_ACCESS_MS,
				link.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
			);
			const signature = await crypto.subtle.sign("HMAC", passwordKey, accessMessage(link, until));
			return {
				cookie: `${until.toString(36)}.${Buffer.from(signature).toString("base64url")}`,
				expiresAt: new Date(until),
			};
		},

		async passwordAccess(link, cookie) {
			if (!link.passwordHash) return true;
			const parts = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
			if (!parts) return false;
			const until = Number.parseInt(parts[1] ?? "", 36);
			if (!Number.isSafeInteger(until) || until <= clock.now().getTime()) return false;
			return crypto.subtle.verify(
				"HMAC",
				passwordKey,
				new Uint8Array(Buffer.from(parts[2] ?? "", "base64url")),
				accessMessage(link, until),
			);
		},

		async page(link, explore) {
			const range: DashboardRange | undefined = explore.range ? { preset: explore.range } : undefined;
			const filters = explore.filters;
			const shown = await deps.dashboards.shown(link.place, link.dashboardId, {
				range,
				filters,
				language: link.language,
			});
			if (!shown) return null;
			// The days before, as long: each Widget showing the Dashboard's days compares with them.
			const days = resolveRange(range ?? shown.range, clock.now());
			const before = previousOf(days);
			const previous = await deps.dashboards.shown(link.place, link.dashboardId, {
				range: rangeOf(before.from, before.to),
				filters,
				language: link.language,
			});
			const scope = link.siteId ? await data.background(link.siteId) : await data.backgroundWorkspace(link.workspaceId);
			if (!scope) return null;
			const site = scope.level === "background" ? (scope as BackgroundScope).site : null;
			return reportPage({
				language: link.language,
				title: shown.name,
				placeName: site?.name ?? scope.workspace.name,
				brand: await resolveBrand(scope, site),
				period: null,
				compared: null,
				widgets: shown.answers.map((answer) => ({
					answer,
					previous: previous?.answers.find((each) => each.widgetId === answer.widgetId) ?? null,
					text: null,
				})),
				ai: null,
				explore: { range: explore.range ?? (shown.range.preset === "custom" ? null : shown.range.preset), filters },
			});
		},

		async opened(link) {
			await database.db
				.update(shareLinks)
				.set({ opens: sql`${shareLinks.opens} + 1`, lastOpenedAt: clock.now() })
				.where(and(eq(shareLinks.id, link.id), eq(shareLinks.workspaceId, link.workspaceId)));
		},
	};
}
