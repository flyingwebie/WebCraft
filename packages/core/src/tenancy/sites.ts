import { sites } from "@webcraft/db/schema";
import { asc } from "drizzle-orm";

import { addDefaultLanguage } from "../content/languages.ts";
import { addPagePostType } from "../content/pages.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { can } from "../permissions/can.ts";
import type { Site, WorkspaceScope } from "./data-layer.ts";

/** The Default language a new Site starts with; Staff can change it (see `content/languages.ts`). */
export const DEFAULT_SITE_LANGUAGE = "en";

/** The longest Site name, in characters. */
export const SITE_NAME_MAX_LENGTH = 100;

/**
 * A Site slug is one DNS label, because the Site's Staging address is `<slug>.<sites domain>`:
 * 1 to 63 lower-case letters, digits and dashes, starting and ending with a letter or a digit.
 */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Slugs the Install keeps for itself: their Staging addresses could be mistaken for its own, and
 * `share` is the Share link address (`share.<sites domain>`, see `reports/share-links.ts`). This
 * only stops a slug being chosen from here on (by `checkSlug`, below): a Site that already had
 * `share` from before it was reserved is moved to `share-<n>` by the migration
 * `move-existing-share-slug`, once, on upgrade.
 */
export const RESERVED_SITE_SLUGS: readonly string[] = ["admin", "www", "share"];

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

/**
 * Refuses a slug no Site may have, with `SlugInvalidError`; answers it normalised. `reserved` lists
 * the slugs the Install keeps (`RESERVED_SITE_SLUGS` unless given).
 */
export function checkSlug(slug: string, reserved: readonly string[] = RESERVED_SITE_SLUGS): string {
	const normalised = normaliseSlug(slug);
	if (!SLUG_SHAPE.test(normalised)) throw new SlugInvalidError("shape");
	if (reserved.includes(normalised)) throw new SlugInvalidError("reserved");
	return normalised;
}

/**
 * Creates a Site in the scope's Workspace (open it with `site.create`), with the built-in Page Post
 * Type every Site has, and records it in the Audit log. Refuses a slug another Site has (`SlugTakenError`) or no Site may have (`SlugInvalidError`):
 * `reserved` lists the slugs the Install keeps.
 */
export async function createSite(
	scope: WorkspaceScope,
	input: { name: string; slug: string },
	reserved: readonly string[] = RESERVED_SITE_SLUGS,
): Promise<Site> {
	const name = input.name.trim();
	if (!name || name.length > SITE_NAME_MAX_LENGTH) {
		throw new TypeError(`A Site's name needs 1 to ${SITE_NAME_MAX_LENGTH} characters.`);
	}
	const slug = checkSlug(input.slug, reserved);
	try {
		return await scope.transaction(async (tx) => {
			const site = toSite(await tx.insert(sites, { name, slug, createdAt: tx.now() }));
			await addPagePostType(tx, site.id);
			await addDefaultLanguage(tx, site.id, DEFAULT_SITE_LANGUAGE);
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
