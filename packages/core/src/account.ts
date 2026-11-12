import type { AccountLock, Auth, Session } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import { z } from "zod";

import { countActiveTokens } from "./api-tokens.ts";
import { type AuditDetails, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { Email } from "./email/index.ts";
import { networkOf } from "./ip-ranges.ts";
import { defineJob } from "./jobs/define.ts";
import { defineSchedule } from "./jobs/schedules.ts";
import { countActiveGrants } from "./oauth.ts";
import { actingPerson } from "./permissions/can.ts";
import { addressSubject, type RateLimitRule, type RateLimits } from "./rate-limits.ts";
import type { Access } from "./tenancy/data-layer.ts";

/** A session as the person sees it in Your account › Sessions. */
export type SessionView = {
	id: string;
	/** The session this very request came with. */
	current: boolean;
	/** The browser that signed in, such as `Firefox`, or null when it can't be told. */
	browser: string | null;
	/** Its operating system, such as `macOS`, or null when it can't be told. */
	os: string | null;
	/**
	 * Roughly where it was last used from: the network of its client address, with the end hidden
	 * (`203.0.113.*`, `2001:db8:85a3:*`), or null when the address is unknown.
	 */
	network: string | null;
	startedAt: Date;
	lastUsedAt: Date;
};

/** The person has no such session (or it is another person's). */
export class SessionNotFoundError extends Error {
	override name = "SessionNotFoundError";
	constructor() {
		super("There is no such session.");
	}
}

/**
 * What changing a password did and didn't end: other sessions are signed out; API tokens and AI
 * clients (CLI sign-ins too) go on working, so the person is told how many there are and can revoke
 * the ones they don't recognise.
 */
export type PasswordChanged = { signedOutSessions: number; activeApiTokens: number; activeAiClients: number };

/** A person's own account: their sessions and their password. */
export type Account = {
	/**
	 * The person's sessions that haven't ended, most recently used first; `current` is the one with
	 * `currentSessionId` (none while someone impersonates them: their session isn't the person's).
	 */
	sessions(personId: string, currentSessionId: string | null): Promise<SessionView[]>;
	/**
	 * Ends one of the person's sessions at once, and records it. Answers whether it was the current
	 * one (its cookie must then be cleared). Throws `SessionNotFoundError` for any other session.
	 */
	revokeSession(access: Access, current: Session, sessionId: string): Promise<{ wasCurrent: boolean }>;
	/** Ends every session of the person but the current one, and records it. */
	revokeOtherSessions(access: Access, current: Session): Promise<{ revoked: number }>;
	/**
	 * Changes the person's password, ends their other sessions, and records it (never the password).
	 * A Sensitive action: the procedure checks the recent identity check first.
	 */
	changePassword(access: Access, current: Session, newPassword: string): Promise<PasswordChanged>;
};

export function createAccount({ database, auth, clock }: { database: Database; auth: Auth; clock: Clock }): Account {
	const audit = (executor: Database["db"] | Transaction, access: Access, action: string, details: AuditDetails) =>
		recordAudit(executor, clock.now(), {
			personId: actingPerson(access.actor),
			via: access.via,
			workspaceId: null,
			siteId: null,
			action,
			details,
		});

	return {
		async sessions(personId, currentSessionId) {
			const sessions = await auth.listSessions(personId);
			return sessions.map((session) => ({
				id: session.id,
				current: session.id === currentSessionId,
				...describeUserAgent(session.userAgent),
				network: networkOf(session.clientAddress),
				startedAt: session.startedAt,
				lastUsedAt: session.lastActiveAt,
			}));
		},

		async revokeSession(access, current, sessionId) {
			if (!(await auth.revokeSession(current.personId, sessionId))) throw new SessionNotFoundError();
			await audit(database.db, access, "session.revoke", { sessionId });
			return { wasCurrent: sessionId === current.id };
		},

		async revokeOtherSessions(access, current) {
			const revoked = await auth.revokeOtherSessions(current);
			await audit(database.db, access, "session.revokeOthers", { revoked });
			return { revoked };
		},

		async changePassword(access, current, newPassword) {
			let left = { activeApiTokens: 0, activeAiClients: 0 };
			const { signedOutSessions } = await auth.changePassword(current, newPassword, async (tx, changed) => {
				left = {
					activeApiTokens: await countActiveTokens(tx, current.personId, clock.now()),
					activeAiClients: await countActiveGrants(tx, current.personId),
				};
				await audit(tx, access, "password.change", { ...changed, ...left });
			});
			return { signedOutSessions, ...left };
		},
	};
}

/** A person is told that tries on their account were stopped, and it is recorded, at most once a day. */
export const ACCOUNT_LOCK_REPORTS: RateLimitRule = { limit: 1, windowMs: 24 * 60 * 60 * 1000 };

/**
 * What happens when wrong passwords or codes stop further tries on an account (`Lockout` in
 * `@webcraft/auth`): the person gets the `account-locked` security email, and it goes in the Audit
 * log. Nobody acted (the attempts may not be the person's), so the entry names the person in its
 * details, with what was stopped and where the last attempt came from. Anyone who knows an email
 * address can cause it as often as they like, so both happen at most once a day for a person; every
 * time is in the log (`createAuth`).
 */
export function reportAccountLock({
	database,
	clock,
	email,
	rateLimits,
}: {
	database: Database;
	clock: Clock;
	email: Email;
	rateLimits: RateLimits;
}) {
	return async (lock: AccountLock): Promise<void> => {
		if (!(await rateLimits.count(`account-lock-report:${lock.personId}`, ACCOUNT_LOCK_REPORTS))) return;
		const lockedMinutes = Math.round((lock.lockedUntil.getTime() - clock.now().getTime()) / 60_000);
		await recordAudit(database.db, clock.now(), {
			personId: null,
			via: { kind: "admin" },
			workspaceId: null,
			siteId: null,
			action: "account.lock",
			details: {
				personId: lock.personId,
				email: lock.email,
				scope: lock.scope,
				failedAttempts: lock.failedAttempts,
				lockedUntil: lock.lockedUntil.toISOString(),
				clientAddress: lock.clientAddress,
			},
		});
		await email.send({
			type: "account-locked",
			to: [{ personId: lock.personId }],
			data: { failedAttempts: lock.failedAttempts, lockedMinutes },
			related: { kind: "person", id: lock.personId },
		});
	};
}

/**
 * The network a client address belongs to, as `@webcraft/auth` keeps it to count wrong passwords
 * per network: a keyed hash of who the address counts as for any limit (`addressSubject`: an IPv4
 * address, an IPv6 /64), so the address itself is never stored.
 */
export function signInNetworkOf(key: CryptoKey) {
	return async (clientAddress: string | null): Promise<string> => {
		const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(addressSubject(clientAddress)));
		return Buffer.from(signature).toString("base64url");
	};
}

/** Deletes the counters of wrong passwords nobody touched for a day (`Lockout.purge`). */
export const signInCountersPurge = defineJob({
	name: "sign-in-counters.purge",
	payload: z.object({}),
	async run(_payload, { auth, log }) {
		const deleted = await auth.purgeSignInCounters();
		if (deleted > 0) log.debug("Deleted ended counters of wrong passwords", { deleted });
	},
});

/** The purge of wrong-password counters runs every day at 04:29 UTC. */
export const signInCountersPurgeSchedule = defineSchedule({
	job: signInCountersPurge,
	cron: "29 4 * * *",
	payload: {},
});

/** The browser and operating system a `User-Agent` names, as far as the common ones go. */
export function describeUserAgent(userAgent: string | null): { browser: string | null; os: string | null } {
	if (!userAgent) return { browser: null, os: null };
	return { browser: firstMatch(userAgent, BROWSERS), os: firstMatch(userAgent, SYSTEMS) };
}

/** Checked in order: several browsers also name the ones they are built on. */
const BROWSERS: readonly [RegExp, string][] = [
	[/\bEdgA?\//, "Edge"],
	[/\bOPR\/|\bOpera\b/, "Opera"],
	[/\bSamsungBrowser\//, "Samsung Internet"],
	[/\bFirefox\/|\bFxiOS\//, "Firefox"],
	[/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
	[/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

/** Checked in order: iPhones say "like Mac OS X", and Android says "Linux". */
const SYSTEMS: readonly [RegExp, string][] = [
	[/\biPhone\b|\biPod\b/, "iOS"],
	[/\biPad\b/, "iPadOS"],
	[/\bAndroid\b/, "Android"],
	[/\bWindows\b/, "Windows"],
	[/\bCrOS\b/, "ChromeOS"],
	[/\bMacintosh\b|\bMac OS X\b/, "macOS"],
	[/\bLinux\b/, "Linux"],
];

function firstMatch(text: string, table: readonly [RegExp, string][]): string | null {
	return table.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
