import { reportServices } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { personIdOf } from "../permissions/can.ts";
import type { Executor, InstallScope } from "../tenancy/data-layer.ts";
import { ServicesListInvalidError } from "./errors.ts";

/**
 * The Services list (GLOSSARY.md): the services the agency offers, written by Staff once for the
 * whole Install. Reports' suggestions may point to one of them; the AI is given their names and
 * descriptions only.
 */

/** A service on the list. */
export type Service = { id: string; name: string; description: string };

/** The most services on the list. */
export const MAX_SERVICES = 30;

const serviceSchema = z.object({ id: z.string(), name: z.string(), description: z.string() });

/** The Services list, in the order Staff gave it. */
export async function servicesList(db: Executor): Promise<Service[]> {
	const [row] = await db.select().from(reportServices).where(eq(reportServices.id, 1));
	if (!Array.isArray(row?.services)) return [];
	return row.services.flatMap((each) => {
		const parsed = serviceSchema.safeParse(each);
		return parsed.success ? [parsed.data] : [];
	});
}

/**
 * Writes the whole list: a service keeps its id when given one already on the list, and gets a new
 * one otherwise. Logged as `servicesList.change`.
 */
export async function saveServicesList(
	scope: InstallScope,
	services: readonly { id?: string; name: string; description?: string }[],
): Promise<Service[]> {
	if (services.length > MAX_SERVICES) {
		throw new ServicesListInvalidError(`The Services list holds at most ${MAX_SERVICES} services.`);
	}
	const known = new Set((await servicesList(scope.db)).map((service) => service.id));
	const list: Service[] = services.map((service) => {
		const name = service.name.trim();
		if (name === "" || name.length > 100) {
			throw new ServicesListInvalidError("Every service needs a name of at most 100 characters.");
		}
		const description = (service.description ?? "").trim();
		if (description.length > 500) {
			throw new ServicesListInvalidError("A service's description has at most 500 characters.");
		}
		return { id: service.id && known.has(service.id) ? service.id : crypto.randomUUID(), name, description };
	});
	const set = { services: list, updatedAt: scope.now(), updatedBy: personIdOf(scope.access.actor) };
	await scope.transaction(async (tx) => {
		await tx.db
			.insert(reportServices)
			.values({ id: 1, ...set })
			.onConflictDoUpdate({ target: reportServices.id, set });
		await tx.audit("servicesList.change", { services: list.map((service) => service.name) });
	});
	return list;
}
