import type { Auth } from "@webcraft/auth";
import { installRoles, people } from "@webcraft/db/schema";
import { and, eq, isNull, ne } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import { PersonNotFoundError } from "../impersonation.ts";
import { personIdOf } from "../permissions/can.ts";
import { SUPERADMIN_ROLE } from "../permissions/roles.ts";
import type { InstallScope } from "./data-layer.ts";
import { type AccessEnded, endAccess } from "./staff.ts";

/** Why an account can't be deactivated. */
export type DeactivationRefusal = "lastSuperadmin" | "self";

/** The account can't be deactivated: it is the last Superadmin's, or the person's own. */
export class AccountDeactivationRefusedError extends Error {
	override name = "AccountDeactivationRefusedError";
	readonly reason: DeactivationRefusal;
	constructor(reason: DeactivationRefusal) {
		super(
			reason === "lastSuperadmin"
				? "The Install needs a Superadmin who can sign in: the last one can't be deactivated."
				: "You can't deactivate your own account.",
		);
		this.reason = reason;
	}
}

/**
 * Deactivating accounts: how the Superadmin ends the sign-in of someone who left, Staff or Member.
 * Open the Install with `account.deactivate` first.
 *
 * A deactivated person can't sign in (`Auth.setDeactivated`) and holds no role anywhere
 * (`loadPersonActor`), so nothing acts as them; no System email goes to them. Their row, roles and
 * Memberships stay: what they made and did stays theirs, lists show them as deactivated, and
 * reactivating gives back exactly what they had.
 */
export type AccountsService = {
	/**
	 * Deactivates a person's account: their sessions, API tokens, AI clients and CLI sign-ins end and
	 * the invites they sent are withdrawn, in the same transaction. Refuses the last Superadmin and
	 * the person themselves (`AccountDeactivationRefusedError`).
	 */
	deactivate(scope: InstallScope, personId: string): Promise<AccessEnded>;
	/** Reactivates an account: the person signs in again, with the password, second factors and roles they had. */
	reactivate(scope: InstallScope, personId: string): Promise<void>;
};

export function createAccounts({ auth }: { auth: Auth }): AccountsService {
	const personOf = async (scope: InstallScope, personId: string) => {
		if (!isUuid(personId)) throw new PersonNotFoundError();
		const [person] = await scope.db
			.select({ email: people.email, deactivatedAt: people.deactivatedAt, role: installRoles.role })
			.from(people)
			.leftJoin(installRoles, eq(installRoles.personId, people.id))
			.where(eq(people.id, personId))
			.for("update", { of: people });
		if (!person) throw new PersonNotFoundError();
		return person;
	};

	return {
		deactivate(scope, personId) {
			return scope.transaction(async (tx) => {
				const person = await personOf(tx, personId);
				if (person.role === SUPERADMIN_ROLE) {
					const others = await tx.db
						.select({ personId: installRoles.personId })
						.from(installRoles)
						.innerJoin(people, eq(people.id, installRoles.personId))
						.where(
							and(
								eq(installRoles.role, SUPERADMIN_ROLE),
								ne(installRoles.personId, personId),
								isNull(people.deactivatedAt),
							),
						);
					if (others.length === 0) throw new AccountDeactivationRefusedError("lastSuperadmin");
				}
				if (personId === personIdOf(tx.access.actor)) throw new AccountDeactivationRefusedError("self");
				// First the flag, so that everything they hold is now out of their reach.
				await auth.setDeactivated(tx.db, personId, tx.now());
				const ended = await endAccess(tx, auth, personId);
				if (!person.deactivatedAt) await tx.audit("account.deactivate", { personId, email: person.email, ...ended });
				return ended;
			});
		},

		async reactivate(scope, personId) {
			await scope.transaction(async (tx) => {
				const person = await personOf(tx, personId);
				if (!person.deactivatedAt) return;
				await auth.setDeactivated(tx.db, personId, null);
				await tx.audit("account.reactivate", { personId, email: person.email });
			});
		},
	};
}
