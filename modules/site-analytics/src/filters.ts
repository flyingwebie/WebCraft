/**
 * Filters (#103): what a Widget, or a call to the query interface, may narrow its counts to. Each is
 * a condition on the raw events, so a filtered count reads the raw events only and reaches back as
 * far as they are kept (`stats.coverage`); the rollups hold each dimension on its own.
 *
 * - `page`: events on a page (exactly, or it and every page under it);
 * - `source`: events of visits that arrived from a source (empty for direct); before consent a page
 *   view stands alone, so only an arrival matches;
 * - `country` (empty for unknown) and `device`: events from there, or on such a device;
 * - `goal`: events of the visitors who reached one of the Site's Goals (by its name) in the range,
 *   which only visitors who accepted Analytics can.
 */
import { and, eq, inArray, isNull, type ModuleContext, type SQL, z } from "@webcraft/module-sdk";

import { goalWhere, nameSchema, pathMatchSchema, pathWhere, requireGoal } from "./goals.ts";
import { within } from "./rollups.ts";
import { events } from "./tables.ts";

export const DEVICES = ["desktop", "mobile", "tablet"] as const;

export const filtersSchema = z.object({
	page: pathMatchSchema.optional(),
	source: z.string().trim().max(200).optional(),
	country: z
		.string()
		.trim()
		.regex(/^(?:[A-Za-z]{2})?$/)
		.optional(),
	device: z.enum(DEVICES).optional(),
	goal: nameSchema.optional(),
});

export type Filters = z.infer<typeof filtersSchema>;

/** Whether any filter is set. */
export function isFiltered(filters: Filters | undefined): filters is Filters {
	return (
		filters !== undefined &&
		(filters.page !== undefined ||
			filters.source !== undefined ||
			filters.country !== undefined ||
			filters.device !== undefined ||
			filters.goal !== undefined)
	);
}

/** The condition the filters put on the raw events of a range (a Goal named that the Site lacks is refused). */
export async function filtersWhere(
	context: ModuleContext,
	range: { from: Date; to: Date },
	filters: Filters | undefined,
): Promise<SQL | undefined> {
	if (!isFiltered(filters)) return undefined;
	const conditions: (SQL | undefined)[] = [];
	if (filters.page) conditions.push(pathWhere(filters.page));
	if (filters.source !== undefined) conditions.push(eq(events.visitSource, filters.source.toLowerCase()));
	if (filters.country !== undefined) {
		conditions.push(
			filters.country === "" ? isNull(events.country) : eq(events.country, filters.country.toUpperCase()),
		);
	}
	if (filters.device) conditions.push(eq(events.device, filters.device));
	if (filters.goal !== undefined) {
		const goal = await requireGoal(context, filters.goal);
		const reached = context.data.values(
			events,
			events.visitor,
			and(within(range.from, range.to), goalWhere(goal.definition)),
		);
		conditions.push(inArray(events.visitor, reached));
	}
	return and(...conditions);
}
