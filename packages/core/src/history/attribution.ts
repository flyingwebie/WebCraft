import { people } from "@webcraft/db/schema";
import { inArray } from "drizzle-orm";

import type { AuditVia } from "../audit.ts";
import type { Executor } from "../tenancy/data-layer.ts";

/**
 * Who made a change, as history shows it: the person (null when nobody did, such as a Module by
 * itself, or they are gone), how they came in, as the Audit log records it, and the client they came
 * in through, which the admin shows as "<person> via <client>": an API token's name, an AI client's.
 */
export type Attribution = {
	person: { id: string; name: string } | null;
	via: AuditVia;
	client: string | null;
};

/**
 * The client a change came in through, named for "<person> via <client>": every way in that carries
 * a name of its own (an API token's, an AI client's) except a server command and a Module acting by
 * itself, which are no client of a person's. The one place history reads it, so a new way in that
 * names its client shows without more work.
 */
export function clientOf(via: AuditVia): string | null {
	if (via.kind === "command" || via.kind === "module") return null;
	const name = (via as { name?: unknown }).name;
	return typeof name === "string" && name !== "" ? name : null;
}

/** A stored `via`, read back; an unreadable one counts as the admin. */
export function storedVia(value: unknown): AuditVia {
	if (value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string") {
		return value as AuditVia;
	}
	return { kind: "admin" };
}

/** People's names by id, in one query. */
export async function peopleNames(executor: Executor, ids: readonly (string | null)[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((id): id is string => id !== null))];
	if (unique.length === 0) return new Map();
	const rows = await executor
		.select({ id: people.id, name: people.name })
		.from(people)
		.where(inArray(people.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}

/** An attribution from a person's id and how they came in, with names looked up in `names`. */
export function attribution(personId: string | null, via: AuditVia, names: ReadonlyMap<string, string>): Attribution {
	const name = personId ? names.get(personId) : undefined;
	return {
		person: personId && name !== undefined ? { id: personId, name } : null,
		via,
		client: clientOf(via),
	};
}
