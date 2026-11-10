import { type Auth, normaliseEmail } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import { installRoles, setupTokens } from "@webcraft/db/schema";
import { desc, eq, notInArray, sql } from "drizzle-orm";

import type { AdminLanguageCode } from "./admin-languages.ts";
import { type AuditVia, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { InstallConfig } from "./config.ts";
import { readSettingsRow, writeSettingsRow } from "./install-settings.ts";
import type { Logger } from "./log.ts";
import { SUPERADMIN_ROLE } from "./permissions/roles.ts";
import { printedOnPurpose } from "./redaction.ts";
import { hashToken, newToken } from "./tokens.ts";

/**
 * Where an Install is in its setup:
 * - `claim`: no Superadmin yet. The setup wizard is open to whoever holds a setup token.
 * - `continue`: the Superadmin exists and is going through the wizard's remaining steps.
 * - `done`: setup is finished. The wizard never opens again.
 */
export type SetupStage = "claim" | "continue" | "done";

/** The Superadmin's account, as the wizard or `webcraft admin create-superadmin` takes it. */
export type SuperadminAccount = {
	name: string;
	email: string;
	password: string;
	/** The Superadmin's Admin language; it becomes the Install's default Admin language too. */
	adminLanguage: AdminLanguageCode;
};

export type InstallSetup = {
	stage(): Promise<SetupStage>;
	/**
	 * Run by the web process when it starts. On an Install with no Superadmin it makes a new setup
	 * token and prints it in the log; otherwise it does nothing.
	 */
	announce(): Promise<void>;
	/** Refuses a setup token that can't claim the Install: `SetupClosedError` or `SetupTokenInvalidError`. */
	checkToken(token: string): Promise<void>;
	/**
	 * Claims the Install with a setup token: creates the Superadmin. Every setup token stops working.
	 * Refuses with `SetupClosedError` once a Superadmin exists and `SetupTokenInvalidError` for a token
	 * the web process never printed; a bad account refuses as `Auth.createPerson` does. Recorded in
	 * the Audit log as `install.claim`, done by the new Superadmin through `via`.
	 */
	claim(token: string, account: SuperadminAccount, via: AuditVia): Promise<{ personId: string }>;
	/**
	 * Creates the Superadmin without the wizard (`webcraft admin create-superadmin`): setup is then
	 * finished, and every setup token stops working. Refuses with `SetupClosedError` once a
	 * Superadmin exists. Recorded in the Audit log as `superadmin.create`, through the command.
	 */
	createSuperadmin(account: SuperadminAccount): Promise<{ personId: string }>;
	/** The Superadmin finished the wizard's remaining steps; it never opens again. */
	finish(personId: string): Promise<void>;
};

/** The Install already has a Superadmin, so it can't be claimed again. */
export class SetupClosedError extends Error {
	override name = "SetupClosedError";
	constructor() {
		super("This Install already has a Superadmin, so the setup wizard is closed.");
	}
}

/** The setup token isn't one the web process printed for this Install. */
export class SetupTokenInvalidError extends Error {
	override name = "SetupTokenInvalidError";
	constructor() {
		super("That setup token doesn't open this Install. Copy it again from the web process's log.");
	}
}

/** Setup is in another stage than the action needs. */
export class SetupStageError extends Error {
	override name = "SetupStageError";
}

/** How many printed setup tokens stay valid; restarts beyond that retire the oldest. */
const KEPT_TOKENS = 10;

/** Serialises everything that can create the Superadmin, across processes (web and CLI). */
const SETUP_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('webcraft:install-setup', 0))`;

type SetupOptions = {
	database: Database;
	auth: Auth;
	config: InstallConfig;
	clock: Clock;
	log: Logger;
};

export function createInstallSetup({ database, auth, config, clock, log }: SetupOptions): InstallSetup {
	const { db } = database;

	const superadminExists = async (executor: Database["db"] | Transaction) => {
		const [row] = await executor
			.select({ personId: installRoles.personId })
			.from(installRoles)
			.where(eq(installRoles.role, SUPERADMIN_ROLE))
			.limit(1);
		return row !== undefined;
	};

	const tokenExists = async (executor: Database["db"] | Transaction, token: string) => {
		const [row] = await executor
			.select({ tokenHash: setupTokens.tokenHash })
			.from(setupTokens)
			.where(eq(setupTokens.tokenHash, await hashToken(token)));
		return row !== undefined;
	};

	/**
	 * Creates the Superadmin in one transaction, after `check` passes, holding the setup lock, and
	 * records it in the Audit log as `action`.
	 */
	const createInLock = (
		account: SuperadminAccount,
		check: (tx: Transaction) => Promise<void>,
		finished: boolean,
		audit: { action: string; via: AuditVia },
	) =>
		db.transaction(async (tx) => {
			await tx.execute(SETUP_LOCK);
			if (await superadminExists(tx)) throw new SetupClosedError();
			await check(tx);
			const now = clock.now();
			const { personId } = await auth.createPerson(tx, account);
			await tx.insert(installRoles).values({ personId, role: SUPERADMIN_ROLE, createdAt: now });
			await tx.delete(setupTokens);
			await writeSettingsRow(tx, {
				defaultAdminLanguage: account.adminLanguage,
				...(finished ? { setupFinishedAt: now } : {}),
			});
			await recordAudit(tx, now, {
				personId,
				via: audit.via,
				workspaceId: null,
				siteId: null,
				action: audit.action,
				details: { email: normaliseEmail(account.email) },
			});
			return { personId };
		});

	return {
		async stage() {
			if (!(await superadminExists(db))) return "claim";
			const settings = await readSettingsRow(db);
			return settings?.setupFinishedAt ? "done" : "continue";
		},

		async announce() {
			if (await superadminExists(db)) return;
			const token = newToken();
			await db.insert(setupTokens).values({ tokenHash: await hashToken(token), createdAt: clock.now() });
			const newest = db
				.select({ tokenHash: setupTokens.tokenHash })
				.from(setupTokens)
				.orderBy(desc(setupTokens.createdAt))
				.limit(KEPT_TOKENS);
			await db.delete(setupTokens).where(notInArray(setupTokens.tokenHash, newest));
			const setupUrl = new URL("/setup", config.adminOrigin);
			setupUrl.searchParams.set("token", token);
			log.warn(
				"This Install has no Superadmin yet. Open the setup wizard and enter the setup token to claim it; it works once.",
				// Printed as it is: the person with access to the server claims the Install with it (spec story 5).
				{ setupToken: printedOnPurpose(token), setupUrl: printedOnPurpose(setupUrl.toString()) },
			);
		},

		async checkToken(token) {
			if (await superadminExists(db)) throw new SetupClosedError();
			if (!(await tokenExists(db, token))) throw new SetupTokenInvalidError();
		},

		async claim(token, account, via) {
			const result = await createInLock(
				account,
				async (tx) => {
					if (!(await tokenExists(tx, token))) throw new SetupTokenInvalidError();
				},
				false,
				{ action: "install.claim", via },
			);
			log.info("The setup wizard created the Superadmin; setup tokens no longer work", { personId: result.personId });
			return result;
		},

		async createSuperadmin(account) {
			const result = await createInLock(account, async () => {}, true, {
				action: "superadmin.create",
				via: { kind: "command", name: "create-superadmin" },
			});
			log.info("The Superadmin was created without the setup wizard; setup tokens no longer work", {
				personId: result.personId,
			});
			return result;
		},

		async finish(personId) {
			const stage = await this.stage();
			if (stage !== "continue") throw new SetupStageError(`Setup can't be finished at the ${stage} stage.`);
			await writeSettingsRow(db, { setupFinishedAt: clock.now() });
			log.info("The Superadmin finished the setup wizard", { personId });
		},
	};
}
