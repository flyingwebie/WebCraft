/**
 * Goals (Structure, built by Staff): something a visitor does on a Site that counts as a result. A
 * Goal counts the events Site analytics already keeps, only those after Analytics consent (ADR 0020):
 *
 * - `form`: a Form Submission of one Form (kept as an event only after consent, see `index.ts`);
 * - `page`: a page view of a path, exactly or it and every path under it (`prefix`), by a visitor
 *   who accepted Analytics (page views before consent count towards totals, never towards a Goal);
 * - `link`: a click on an outbound, download, phone or email link, optionally only where its target
 *   matches a pattern (`*` stands for any characters, upper and lower case alike);
 * - `event`: a custom event, by its name.
 *
 * Each Goal is counted twice over: as SQL for the counts (`goalWhere`), and here in memory for
 * Funnels, which walk each visitor's events in order (`goalMatches`). The two must agree.
 */
import {
	and,
	asc,
	eq,
	ilike,
	isNotNull,
	like,
	type ModuleContext,
	ModuleError,
	or,
	type SQL,
	z,
} from "@webcraft/module-sdk";

import { events, goals } from "./tables.ts";

/** How many Goals a Site may have. */
export const MAX_GOALS = 100;

/** The kinds of link a Goal can count a click on, as the collection script names them. */
export const LINK_KINDS = ["outbound", "download", "tel", "mailto"] as const;

/** A Goal's or Funnel's name: Widgets, Dashboard templates and Workspace Dashboards find it by it. */
export const nameSchema = z.string().trim().min(1).max(100);

/** A page path a Goal or a Funnel step matches: exactly, or it and every path under it. */
export const pathMatchSchema = z.object({
	path: z.string().trim().min(1).max(1000).startsWith("/"),
	match: z.enum(["exact", "prefix"]).default("exact"),
});

export type PathMatch = z.infer<typeof pathMatchSchema>;

/** What a Goal counts. */
export const goalDefinitionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("form"), formId: z.uuid() }),
	z.object({ kind: z.literal("page"), ...pathMatchSchema.shape }),
	z.object({
		kind: z.literal("link"),
		link: z.enum(LINK_KINDS),
		/** Only clicks whose target matches it (`*` for any characters); empty for every click of the kind. */
		target: z.string().trim().max(1000).default(""),
	}),
	z.object({ kind: z.literal("event"), event: z.string().trim().min(1).max(100) }),
]);

export type GoalDefinition = z.infer<typeof goalDefinitionSchema>;

/** A Goal as procedures answer it. */
export type Goal = { id: string; name: string; definition: GoalDefinition; createdAt: Date; updatedAt: Date };

/** An event as Funnels look at it, one by one. */
export type EventFacts = { type: string; name: string | null; target: string | null; path: string };

/** A row of the table, as a Goal. */
export function goalOf(row: typeof goals.$inferSelect): Goal {
	return {
		id: row.id,
		name: row.name,
		definition: goalDefinitionSchema.parse({ kind: row.kind, ...(row.definition as object) }),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The Site's Goals, by name. */
export async function listGoals(context: ModuleContext): Promise<Goal[]> {
	const rows = await context.data.select(goals, undefined, { orderBy: [asc(goals.name), asc(goals.id)] });
	return rows.map(goalOf).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** The Site's Goal with this name (upper and lower case alike), or undefined. */
export async function goalNamed(context: ModuleContext, name: string): Promise<Goal | undefined> {
	const wanted = name.trim().toLowerCase();
	return (await listGoals(context)).find((goal) => goal.name.toLowerCase() === wanted);
}

/** The Site's Goal with this name, or a refusal saying the Site has none. */
export async function requireGoal(context: ModuleContext, name: string): Promise<Goal> {
	const goal = await goalNamed(context, name);
	if (!goal) throw new ModuleError("GOAL_NOT_FOUND", `This Site has no Goal named "${name}".`, 404);
	return goal;
}

/** Refuses a name one of `taken` (the Site's other Goals, or Funnels) has, whatever its case. */
export function assertNameFree(
	taken: readonly { id: string; name: string }[],
	name: string,
	except: string | null,
	code: string,
	what: string,
): void {
	if (taken.some((row) => row.id !== except && row.name.toLowerCase() === name.toLowerCase())) {
		throw new ModuleError(code, `This Site already has a ${what} named "${name}".`, 409);
	}
}

/** `text` for a LIKE pattern: its `\`, `%` and `_` taken literally. */
function literal(text: string): string {
	return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** A path match's base: the path without trailing slashes (empty for `/`, which every path is under). */
function baseOf(path: string): string {
	return path.replace(/\/+$/, "");
}

/** The events on a matching page. */
export function pathWhere({ path, match }: PathMatch): SQL | undefined {
	if (match === "exact") return eq(events.path, path);
	const base = baseOf(path);
	if (base === "") return undefined;
	return or(eq(events.path, base), like(events.path, `${literal(base)}/%`));
}

/** Whether a path matches, as `pathWhere` does. */
export function pathMatches({ path, match }: PathMatch, candidate: string): boolean {
	if (match === "exact") return candidate === path;
	const base = baseOf(path);
	return base === "" || candidate === base || candidate.startsWith(`${base}/`);
}

/** A link target pattern as an ILIKE pattern: `*` for any characters, the rest taken literally. */
function targetPattern(pattern: string): string {
	return pattern.split("*").map(literal).join("%");
}

/** Whether a link's target matches a pattern, as `goalWhere` does (upper and lower case alike). */
function targetMatches(pattern: string, target: string | null): boolean {
	if (pattern === "") return true;
	if (target === null) return false;
	const expression = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s\\S]*");
	return new RegExp(`^${expression}$`, "i").test(target);
}

/** The events that reach a Goal. */
export function goalWhere(definition: GoalDefinition): SQL | undefined {
	switch (definition.kind) {
		case "form":
			return and(eq(events.type, "form"), eq(events.target, definition.formId));
		case "page":
			return and(eq(events.type, "pageview"), isNotNull(events.visitor), pathWhere(definition));
		case "link":
			return and(
				eq(events.type, "link"),
				eq(events.name, definition.link),
				definition.target === "" ? undefined : ilike(events.target, targetPattern(definition.target)),
			);
		case "event":
			return and(eq(events.type, "event"), eq(events.name, definition.event));
	}
}

/** Whether one event (of a visitor who accepted Analytics) reaches a Goal, as `goalWhere` counts it. */
export function goalMatches(definition: GoalDefinition, event: EventFacts): boolean {
	switch (definition.kind) {
		case "form":
			return event.type === "form" && event.target === definition.formId;
		case "page":
			return event.type === "pageview" && pathMatches(definition, event.path);
		case "link":
			return event.type === "link" && event.name === definition.link && targetMatches(definition.target, event.target);
		case "event":
			return event.type === "event" && event.name === definition.event;
	}
}

/** What a Goal's definition says, to Staff and in exports: `/thanks`, `/shop/*`, `outbound *shop.example*`. */
export function describePath({ path, match }: PathMatch): string {
	return match === "exact" ? path : `${baseOf(path)}/*`;
}
