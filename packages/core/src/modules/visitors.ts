/**
 * What a Module's Site route learns of the visitor behind a request (SDK 1.4, `SiteVisitor`).
 * WebCraft never hands a Module the visitor's address or its own cookies: it answers questions about
 * them. The address is used to work out the country, to compare with address ranges, to make the
 * day's id and to count requests against a route's limit, and is never kept or logged; the limit's
 * counter is kept under a keyed hash of it, never the address.
 */
import type { Database } from "@webcraft/db";
import { consentBanners, sessions, visitorSalts } from "@webcraft/db/schema";
import { addressInRanges, type SiteVisitor, type VisitorConsent } from "@webcraft/module-sdk";
import { CHOSEN_CATEGORIES } from "@webcraft/renderer";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { settingsOf } from "../consent/banner.ts";
import type { Countries } from "../countries.ts";
import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/** A request on a Site, as the Site pipeline hands it to a Module's Site route. */
export type SiteRouteRequest = {
	site: { id: string; workspaceId: string };
	/** How the hostname reaches the Site: its Staging address, or one of its domains. */
	via: "staging" | "domain";
	/** The client's address (`clientAddress`), or null when the web process can't tell. */
	clientAddress: string | null;
	/** Whether the request carries an Edit mode session that still holds. */
	editing: boolean;
};

export type Visitors = {
	/** What a Site route learns of the visitor behind `request`. */
	visitorOf(route: SiteRouteRequest, request: Request): SiteVisitor;
	/** A keyed hash of the client's address, for counters kept under it (changes every day). */
	addressKey(clientAddress: string | null): Promise<string>;
	/** Deletes the salts of earlier days; answers how many. */
	purgeSalts(): Promise<number>;
};

/** The consent cookie the Site sets (`apps/server` › site/consent.ts), with or without `__Host-`. */
const CONSENT_COOKIE = /^(?:__Host-)?webcraft\.consent$/;
const CONSENT_VALUE = /^[0-9a-f-]{36}\.\d+\.([01]{3})$/;

export function createVisitors(deps: {
	database: Database;
	clock: Clock;
	countries: Countries;
	idKey: CryptoKey;
}): Visitors {
	const { database, clock, countries, idKey } = deps;
	const { db } = database;
	let cached: { day: string; salt: string } | undefined;

	/** Today's salt (UTC), made by whichever process needs it first; earlier days' go then. */
	const saltOfToday = async (): Promise<{ day: string; salt: string }> => {
		const now = clock.now();
		const day = now.toISOString().slice(0, 10);
		if (cached?.day === day) return cached;
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const made = await db
			.insert(visitorSalts)
			.values({ day, salt: hex(bytes), createdAt: now })
			.onConflictDoNothing()
			.returning({ day: visitorSalts.day });
		if (made.length > 0) await db.delete(visitorSalts).where(lt(visitorSalts.day, day));
		const [row] = await db.select({ salt: visitorSalts.salt }).from(visitorSalts).where(eq(visitorSalts.day, day));
		if (!row) throw new Error("The day's salt could not be made.");
		cached = { day, salt: row.salt };
		return cached;
	};

	const sign = async (parts: readonly string[]) => {
		const signature = await crypto.subtle.sign("HMAC", idKey, new TextEncoder().encode(parts.join("\n")));
		return hex(new Uint8Array(signature));
	};

	return {
		visitorOf(route, request) {
			const { site, clientAddress } = route;
			let consent: Promise<VisitorConsent> | undefined;
			const readConsent = async (): Promise<VisitorConsent> => {
				const [row] = await db
					.select({ mode: consentBanners.mode, version: consentBanners.version, layout: consentBanners.layout })
					.from(consentBanners)
					.where(eq(consentBanners.siteId, site.id));
				const { mode } = settingsOf(row as never);
				if (mode === "none") return { asks: "none", has: () => true };
				if (mode === "outside") return { asks: "outside", has: (category) => category === "necessary" };
				const bits = consentBits(request);
				return {
					asks: "banner",
					has: (category) => {
						if (category === "necessary") return true;
						const index = (CHOSEN_CATEGORIES as readonly string[]).indexOf(category);
						if (index < 0) return false;
						// No answer yet: Opt-in accepts nothing, Opt-out everything.
						return bits === null ? mode === "optOut" : bits[index] === "1";
					},
				};
			};
			return {
				via: route.via,
				async signedIn() {
					if (route.editing) return true;
					if (clientAddress === null) return false;
					const [row] = await db
						.select({ id: sessions.id })
						.from(sessions)
						.where(and(eq(sessions.ipAddress, clientAddress), gt(sessions.expiresAt, clock.now())))
						.limit(1);
					return row !== undefined;
				},
				country: () => countries.country(clientAddress),
				consent: () => {
					consent ??= readConsent();
					return consent;
				},
				inRanges: (ranges) => clientAddress !== null && addressInRanges(clientAddress, ranges),
				async dailyId(category, options = {}) {
					consent ??= readConsent();
					const given = await consent;
					const accepted = given.has(category) || (given.asks === "outside" && options.acceptedInPage === true);
					if (!accepted) return null;
					const { day, salt } = await saltOfToday();
					const userAgent = request.headers.get("user-agent") ?? "";
					return (await sign(["visitor", day, salt, site.id, clientAddress ?? "", userAgent])).slice(0, 32);
				},
			};
		},

		async addressKey(clientAddress) {
			const { day, salt } = await saltOfToday();
			return (await sign(["address", day, salt, clientAddress ?? "unknown"])).slice(0, 32);
		},

		async purgeSalts() {
			const day = clock.now().toISOString().slice(0, 10);
			const deleted = await db.delete(visitorSalts).where(lt(visitorSalts.day, day)).returning();
			if (cached && cached.day < day) cached = undefined;
			return deleted.length;
		},
	};
}

/** The visitor's answer on the Consent banner, as the `webcraft.consent` cookie holds it, or null without one. */
function consentBits(request: Request): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || !CONSENT_COOKIE.test(part.slice(0, separator).trim())) continue;
		const match = CONSENT_VALUE.exec(part.slice(separator + 1).trim());
		return match?.[1] ?? null;
	}
	return null;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deletes the salts of days that ended, so nobody can tell whose those days' ids were. */
export const visitorSaltsPurge = defineJob({
	name: "visitors.purge-salts",
	payload: z.object({}),
	async run(_payload, { modules, log }) {
		const deleted = await modules.purgeSalts();
		if (deleted > 0) log.debug("Deleted the salts of visitors' ids of days that ended", { deleted });
	},
});

/** Earlier days' salts go every day at 00:04 UTC. */
export const visitorSaltsPurgeSchedule = defineSchedule({ job: visitorSaltsPurge, cron: "4 0 * * *", payload: {} });
