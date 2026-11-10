import type { Database } from "@webcraft/db";
import { emailOptOuts } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import {
	canTurnOff,
	categoryOf,
	type EmailCategory,
	SYSTEM_EMAIL_TYPE_IDS,
	type SystemEmailType,
} from "./catalogue.ts";

/** One System email type as a person's profile shows it: whether they get it, and whether they may turn it off. */
export type EmailSwitch = {
	type: SystemEmailType;
	category: EmailCategory;
	on: boolean;
	canTurnOff: boolean;
};

/** Each person's switches for work and alert emails. Security emails always go. */
export type EmailPreferences = {
	/** Every System email type, in catalogue order, with the person's switch. */
	read(personId: string): Promise<EmailSwitch[]>;
	/**
	 * Sets which types the person gets no email for: exactly `turnedOff`, every other type on.
	 * Refuses security emails with `EmailAlwaysSentError`.
	 */
	update(personId: string, turnedOff: readonly SystemEmailType[]): Promise<EmailSwitch[]>;
};

/** Security emails and Health alerts can't be turned off. */
export class EmailAlwaysSentError extends Error {
	override name = "EmailAlwaysSentError";
	readonly types: readonly SystemEmailType[];
	constructor(types: readonly SystemEmailType[]) {
		super(`Security emails and Health alerts can't be turned off: ${types.join(", ")}.`);
		this.types = types;
	}
}

export function createEmailPreferences({ database, clock }: { database: Database; clock: Clock }): EmailPreferences {
	const { db } = database;
	const read = async (personId: string): Promise<EmailSwitch[]> => {
		const rows = await db
			.select({ type: emailOptOuts.type })
			.from(emailOptOuts)
			.where(eq(emailOptOuts.personId, personId));
		const off = new Set(rows.map((row) => row.type));
		return SYSTEM_EMAIL_TYPE_IDS.map((type) => ({
			type,
			category: categoryOf(type),
			on: !(canTurnOff(type) && off.has(type)),
			canTurnOff: canTurnOff(type),
		}));
	};
	return {
		read,
		async update(personId, turnedOff) {
			const refused = turnedOff.filter((type) => !canTurnOff(type));
			if (refused.length > 0) throw new EmailAlwaysSentError(refused);
			const types = [...new Set(turnedOff)];
			const now = clock.now();
			await db.transaction(async (tx) => {
				await tx.delete(emailOptOuts).where(eq(emailOptOuts.personId, personId));
				if (types.length > 0) {
					await tx.insert(emailOptOuts).values(types.map((type) => ({ personId, type, createdAt: now })));
				}
			});
			return read(personId);
		},
	};
}
