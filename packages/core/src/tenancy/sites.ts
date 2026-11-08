import { sites } from "@webcraft/db/schema";
import { asc } from "drizzle-orm";

import { can } from "../permissions/can.ts";
import type { Site, WorkspaceScope } from "./data-layer.ts";

/** The longest Site name, in characters. */
export const SITE_NAME_MAX_LENGTH = 100;

/**
 * A Site slug is one DNS label, because the Site's Staging address is `<slug>.<sites domain>`:
 * 1 to 63 lower-case letters, digits and dashes, starting and ending with a letter or a digit.
 */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Slugs the Install keeps for itself: their Staging addresses could be mistaken for its own. */
export const RESERVED_SITE_SLUGS: readonly string[] = ["admin", "www"];

/** Why a slug was refused. */
export type SlugProblem = "shape" | "reserved";

/** The slug can't be a Site's slug. */
export class SlugInvalidError extends Error {
	override name = "SlugInvalidError";
	readonly problem: SlugProblem;
	constructor(problem: SlugProblem) {
		super(
			problem === "reserved"
				? "That slug is kept for the Install itself. Choose another one."
				: "A slug has 1 to 63 lower-case letters, digits and dashes, and starts and ends with a letter or a digit.",
		);
		this.problem = problem;
	}
}

/** Another Site on the Install already has the slug. */
export class SlugTakenError extends Error {
	override name = "SlugTakenError";
	constructor(slug: string) {
		super(`Another Site already has the slug ${slug}.`);
	}
}

/** Slugs are compared and stored in this form. */
export function normaliseSlug(slug: string): string {
	return slug.trim().toLowerCase();
}

/** Refuses a slug no Site may have, with `SlugInvalidError`; answers it normalised. */
export function checkSlug(slug: string): string {
	const normalised = normaliseSlug(slug);
	if (!SLUG_SHAPE.test(normalised)) throw new SlugInvalidError("shape");
	if (RESERVED_SITE_SLUGS.includes(normalised)) throw new SlugInvalidError("reserved");
	return normalised;
}

/**
 * Creates a Site in the scope's Workspace (open it with `site.create`) and records it in the Audit
 * log. Refuses a slug another Site has (`SlugTakenError`) or no Site may have (`SlugInvalidError`).
 */
export async function createSite(scope: WorkspaceScope, input: { name: string; slug: string }): Promise<Site> {
	const name = input.name.trim();
	if (!name || name.length > SITE_NAME_MAX_LENGTH) {
		throw new TypeError(`A Site's name needs 1 to ${SITE_NAME_MAX_LENGTH} characters.`);
	}
	const slug = checkSlug(input.slug);
	try {
		return await scope.transaction(async (tx) => {
			const site = toSite(await tx.insert(sites, { name, slug, createdAt: tx.now() }));
			await tx.audit("site.create", { name, slug }, { siteId: site.id });
			return site;
		});
	} catch (error) {
		if (isUniqueViolation(error, "sites_slug_key") || isUniqueViolation(error, "sites_slug_unique")) {
			throw new SlugTakenError(slug);
		}
		throw error;
	}
}

/** The Sites of the scope's Workspace the actor can see, by name. */
export async function listSites(scope: WorkspaceScope): Promise<Site[]> {
	const rows = await scope.select(sites, undefined, { orderBy: [asc(sites.name), asc(sites.slug)] });
	return rows
		.map(toSite)
		.filter((site) =>
			can(scope.access.actor, "site.view", { level: "site", workspaceId: site.workspaceId, siteId: site.id }),
		);
}

function toSite(row: typeof sites.$inferSelect): Site {
	return { id: row.id, workspaceId: row.workspaceId, name: row.name, slug: row.slug, createdAt: row.createdAt };
}

/** Whether `error` is Postgres refusing a duplicate in the unique constraint `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
	const cause = (error as { cause?: unknown })?.cause ?? error;
	const { code, constraint: name } = (cause ?? {}) as { code?: unknown; constraint?: unknown };
	return code === "23505" && name === constraint;
}
