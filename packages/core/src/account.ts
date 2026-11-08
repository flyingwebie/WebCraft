import type { AccountLock, Auth, Session } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";

import { type AuditDetails, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { Email } from "./email/index.ts";
import { actingPerson } from "./permissions/can.ts";
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

/** A person's own account: their sessions and their password. */
export type Account = {
	/** The person's sessions that haven't ended, most recently used first; `current` is this one. */
	sessions(current: Session): Promise<SessionView[]>;
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
	changePassword(access: Access, current: Session, newPassword: string): Promise<{ signedOutSessions: number }>;
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
		async sessions(current) {
			const sessions = await auth.listSessions(current.personId);
			return sessions.map((session) => ({
				id: session.id,
				current: session.id === current.id,
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

		changePassword(access, current, newPassword) {
			return auth.changePassword(current, newPassword, (tx, { signedOutSessions }) =>
				audit(tx, access, "password.change", { signedOutSessions }),
			);
		},
	};
}

/**
 * What happens when wrong passwords lock an account: the person gets the `account-locked` security
 * email, and the lock goes in the Audit log. Nobody acted (the attempts may not be the person's), so
 * the entry names the locked person in its details, with where the last attempt came from.
 */
export function reportAccountLock({ database, clock, email }: { database: Database; clock: Clock; email: Email }) {
	return async (lock: AccountLock): Promise<void> => {
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

/**
 * The network an address belongs to, with the end hidden: the first three parts of an IPv4
 * address, or the first three groups of an IPv6 address (its site prefix). Null for no address.
 */
export function networkOf(address: string | null): string | null {
	if (!address) return null;
	const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
	if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.*`;
	if (!address.includes(":")) return null;
	const [head = "", tail] = address.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups =
		tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
	return `${groups
		.slice(0, 3)
		.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
		.join(":")}:*`;
}
