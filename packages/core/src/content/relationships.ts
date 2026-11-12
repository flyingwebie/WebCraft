import { entries, entryLinks, media, postTypes } from "@webcraft/db/schema";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { checkBodyComponents } from "./body-components.ts";
import type { ContentProblem } from "./errors.ts";
import type { Reference } from "./field-types.ts";
import type { Link } from "./field-values.ts";
import { fieldAt } from "./fields.ts";
import type { PostType } from "./post-types.ts";
import { readValue, storedVersion } from "./values.ts";

/**
 * Relationships: a Relationship value is a list of Entry ids inside a version of an Entry. The links
 * they make are also kept in `entry_links`, per Entry and version, so WebCraft finds what points at
 * an Entry at once: the link back a two-way Relationship shows on the Entries it points at, and what
 * deleting an Entry would unlink or is blocked by.
 */

/** The two versions an Entry's links are kept for. */
export type LinkVersion = "draft" | "published";

/** Replaces the links one version of an Entry makes. Links to Entries that no longer exist are left out. */
export async function saveLinks(scope: SiteScope, entryId: string, version: LinkVersion, links: readonly Link[]) {
	await scope.delete(entryLinks, and(eq(entryLinks.entryId, entryId), eq(entryLinks.version, version)));
	if (links.length === 0) return;
	const existing = new Set(
		(
			await scope.db
				.select({ id: entries.id })
				.from(entries)
				.where(scope.where(entries, inArray(entries.id, [...new Set(links.map((link) => link.targetId))])))
		).map((row) => row.id),
	);
	const rows = links
		.filter((link) => existing.has(link.targetId))
		.map((link) => ({
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
			entryId,
			version,
			field: link.field,
			targetId: link.targetId,
		}));
	if (rows.length > 0) await scope.db.insert(entryLinks).values(rows);
}

/** A Relationship value's Entries, to check, with where its problems go. */
export type ReferenceCheck = Reference & { at: string; problems: ContentProblem[] };

/**
 * Checks that the Entries Relationship values point at are Entries of the Site, of the Post Types
 * their Field allows, and that media values are files of the Site's Media library. `refuse` (saving)
 * reports a value that points elsewhere as a value of the wrong kind and holds those Entries until
 * the save ends, so they can't be deleted under it; `rule` (checking a stored version) reports it as
 * a broken rule.
 */
export async function checkReferences(
	scope: Pick<SiteScope, "db" | "where" | "site" | "componentSources">,
	checks: readonly ReferenceCheck[],
	mode: "refuse" | "rule",
): Promise<void> {
	const nested = await checkBodyComponents(
		scope,
		checks.filter((check): check is Extract<ReferenceCheck, { kind: "components" }> => check.kind === "components"),
		mode,
	);
	const all = [...checks, ...nested];
	await checkMedia(
		scope,
		all.filter((check) => check.kind === "media"),
		mode,
	);
	const entryChecks = all.filter(
		(check): check is Extract<ReferenceCheck, { kind: "entries" }> => check.kind === "entries",
	);
	const ids = [...new Set(entryChecks.flatMap((check) => check.ids))];
	if (ids.length === 0) return;
	const query = scope.db
		.select({ id: entries.id, postTypeKey: postTypes.key })
		.from(entries)
		.innerJoin(postTypes, and(eq(postTypes.id, entries.postTypeId), eq(postTypes.siteId, entries.siteId)))
		.where(scope.where(entries, inArray(entries.id, ids)));
	const rows = mode === "refuse" ? await query.for("key share", { of: entries }) : await query;
	const keys = new Map(rows.map((row) => [row.id, row.postTypeKey]));
	for (const check of entryChecks) {
		const wrong = check.ids.find((id) => !check.postTypes.includes(keys.get(id) ?? ""));
		if (wrong === undefined) continue;
		const message = `${wrong} isn't an Entry of ${check.postTypes.join(", ")} on this Site.`;
		check.problems.push(mode === "refuse" ? { at: check.at, message } : { at: check.at, rule: "postTypes", message });
	}
}

/** Media values: each must be a file of the Site's Media library. */
async function checkMedia(
	scope: Pick<SiteScope, "db" | "where">,
	checks: readonly ReferenceCheck[],
	mode: "refuse" | "rule",
): Promise<void> {
	const ids = [...new Set(checks.flatMap((check) => check.ids))];
	if (ids.length === 0) return;
	// A file in the Trash is no longer in the library: it can't be chosen.
	const rows = await scope.db
		.select({ id: media.id })
		.from(media)
		.where(scope.where(media, and(inArray(media.id, ids), isNull(media.trashedAt))));
	const found = new Set(rows.map((row) => row.id));
	for (const check of checks) {
		const wrong = check.ids.find((id) => !found.has(id));
		if (wrong === undefined) continue;
		const message = `There is no file ${wrong} in this Site's Media library.`;
		check.problems.push(mode === "refuse" ? { at: check.at, message } : { at: check.at, rule: "media", message });
	}
}

/** An Entry that links to another through a two-way Relationship: the link back. */
export type LinkBack = {
	entryId: string;
	postTypeId: string;
	/** The Relationship Field's path in the linking Entry's Post Type, such as `categories`. */
	field: string;
	/** The linking Entry's title, in the language asked for. */
	title: string;
};

/**
 * The links back to each of `entryIds`: the Entries whose Drafts point at it through a two-way
 * Relationship (one-way Relationships show nothing on the Entries they point at), by title.
 */
export async function linksBack(
	scope: Pick<SiteScope, "db" | "where">,
	entryIds: readonly string[],
	allPostTypes: readonly PostType[],
	languages: { language: string; defaultLanguage: string },
): Promise<Map<string, LinkBack[]>> {
	const back = new Map<string, LinkBack[]>(entryIds.map((id) => [id, []]));
	if (entryIds.length === 0) return back;
	const rows = await scope.db
		.select({
			targetId: entryLinks.targetId,
			field: entryLinks.field,
			entryId: entries.id,
			postTypeId: entries.postTypeId,
			draft: entries.draft,
		})
		.from(entryLinks)
		.innerJoin(entries, and(eq(entries.id, entryLinks.entryId), eq(entries.siteId, entryLinks.siteId)))
		.where(
			scope.where(
				entryLinks,
				and(
					inArray(entryLinks.targetId, [...entryIds]),
					eq(entryLinks.version, "draft"),
					ne(entryLinks.entryId, entryLinks.targetId),
				),
			),
		);
	const byId = new Map(allPostTypes.map((postType) => [postType.id, postType]));
	for (const row of rows) {
		const layout = /^layout\.([^.]*)\.(.*)$/.exec(row.field);
		const placement = layout && storedVersion(row.draft).layout?.placements.find((p) => p.id === layout[1]);
		const field =
			placement && layout
				? fieldAt(placement.props, layout[2] ?? "")
				: fieldAt(byId.get(row.postTypeId)?.fields ?? [], row.field);
		if (field?.type !== "relationship" || !field.twoWay) continue;
		const title = readValue(storedVersion(row.draft), { key: "title", ...languages }) ?? "";
		back.get(row.targetId)?.push({ entryId: row.entryId, postTypeId: row.postTypeId, field: row.field, title });
	}
	for (const list of back.values()) {
		list.sort(
			(a, b) => a.title.localeCompare(b.title) || a.entryId.localeCompare(b.entryId) || a.field.localeCompare(b.field),
		);
	}
	return back;
}

/** One Entry that links to the Entry being deleted. */
export type LinkingEntry = {
	entryId: string;
	postTypeId: string;
	title: string;
	/** The Relationship Fields the links are in. */
	fields: string[];
	/** Whether one of them is required, which blocks the delete. */
	required: boolean;
};

/** The other Entries that link to `entryId`, in their Draft or their published version. */
export async function linkingEntries(
	scope: SiteScope,
	entryId: string,
	allPostTypes: readonly PostType[],
	defaultLanguage: string,
): Promise<LinkingEntry[]> {
	const rows = await scope.db
		.select({
			field: entryLinks.field,
			entryId: entries.id,
			postTypeId: entries.postTypeId,
			draft: entries.draft,
		})
		.from(entryLinks)
		.innerJoin(entries, and(eq(entries.id, entryLinks.entryId), eq(entries.siteId, entryLinks.siteId)))
		.where(scope.where(entryLinks, and(eq(entryLinks.targetId, entryId), ne(entryLinks.entryId, entryId))));
	const byId = new Map(allPostTypes.map((postType) => [postType.id, postType]));
	const linking = new Map<string, LinkingEntry>();
	for (const row of rows) {
		// A link left in a Field that is no longer a Relationship shows nowhere and is ignored.
		const layout = /^layout\.([^.]*)\.(.*)$/.exec(row.field);
		const placement = layout && storedVersion(row.draft).layout?.placements.find((p) => p.id === layout[1]);
		const field =
			placement && layout
				? fieldAt(placement.props, layout[2] ?? "")
				: fieldAt(byId.get(row.postTypeId)?.fields ?? [], row.field);
		if (field?.type !== "relationship") continue;
		const entry = linking.get(row.entryId) ?? {
			entryId: row.entryId,
			postTypeId: row.postTypeId,
			title: readValue(storedVersion(row.draft), { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
			fields: [],
			required: false,
		};
		if (!entry.fields.includes(row.field)) entry.fields.push(row.field);
		if (field.required) entry.required = true;
		linking.set(row.entryId, entry);
	}
	return [...linking.values()].sort((a, b) => a.title.localeCompare(b.title) || a.entryId.localeCompare(b.entryId));
}

/** The published Entries with these ids, for rendering what Relationships point at. */
export async function publishedEntries(scope: Pick<VisitorScope, "select">, ids: readonly string[]) {
	if (ids.length === 0) return [];
	return scope.select(entries, and(inArray(entries.id, [...ids]), isNotNull(entries.published)));
}
