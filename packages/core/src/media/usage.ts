import {
	components,
	designSystems,
	entries,
	globals,
	loops,
	mediaFiles,
	postTypes,
	templates,
} from "@webcraft/db/schema";
import { and, asc, eq, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { languagesFor, siteLanguages } from "../content/languages.ts";
import { readValue, storedVersion } from "../content/values.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/** Which version of an item uses a file: its Draft, its published version, or both. */
export type UseVersion = "draft" | "published";

/**
 * One place a Media item is used. Each says which versions use it, so people know whether visitors
 * see it now (`published`) or will once a Draft is published (`draft`):
 * - an Entry (a media Field, a Body image Block, a Component's Prop on it, in any language), with
 *   the Fields by key;
 * - the Globals, with the Fields by key;
 * - a Template (`media:<id>` written in it), a Component, a Loop (its Loop items);
 * - the Design system (its CSS names the file's address).
 */
export type MediaUse =
	| {
			kind: "entry";
			id: string;
			title: string;
			postType: { id: string; name: string };
			versions: UseVersion[];
			fields: string[];
	  }
	| { kind: "globals"; versions: UseVersion[]; fields: string[] }
	| {
			kind: "template";
			id: string;
			templateKind: "site" | "entry" | "archive";
			postType: { id: string; name: string } | null;
			versions: UseVersion[];
	  }
	| { kind: "component"; id: string; name: string; versions: UseVersion[] }
	| { kind: "loop"; id: string; name: string; versions: UseVersion[] }
	| { kind: "designSystem"; versions: UseVersion[] };

/**
 * Where a feature keeps references to Media, searched for one item: WebCraft's own content below.
 * A feature that keeps them elsewhere adds its source here (Social images, with SEO), so Used in,
 * and the warning before a file is deleted, name its places too.
 */
export type MediaUseSource = (scope: SiteScope, file: MediaReferences) => Promise<MediaUse[]>;

/** What a Media item is referred to by: its id (`media:<id>` and stored values), and its served names. */
export type MediaReferences = { id: string; names: readonly string[] };

const SOURCES: readonly MediaUseSource[] = [
	entryUses,
	globalsUses,
	templateUses,
	componentUses,
	loopUses,
	designSystemUses,
];

/** Every place a Media item is used on its Site, in the order of `SOURCES`, each kind sorted by name. */
export async function mediaUses(scope: SiteScope, mediaId: string): Promise<MediaUse[]> {
	const names = await scope.select(mediaFiles, eq(mediaFiles.mediaId, mediaId));
	const file: MediaReferences = {
		id: mediaId,
		names: names.filter((row) => row.role === "original" || row.role === "variant").map((row) => row.name),
	};
	const found: MediaUse[] = [];
	for (const source of SOURCES) found.push(...(await source(scope, file)));
	return found;
}

/** Whether a stored JSON version (or text) holds `needle` anywhere. */
const holds = (column: AnyPgColumn, needle: string): SQL =>
	sql`position(${needle} in coalesce(${column}::text, '')) > 0`;

/** The versions of a row that hold `needle`. */
function versionsHolding(row: { draft: unknown; published: unknown }, needle: string): UseVersion[] {
	const versions: UseVersion[] = [];
	if (JSON.stringify(row.draft ?? null).includes(needle)) versions.push("draft");
	if (JSON.stringify(row.published ?? null).includes(needle)) versions.push("published");
	return versions;
}

/** The keys of a version's values (its Fields) that hold `needle`, in any language. */
function fieldsHolding(versions: readonly unknown[], needle: string): string[] {
	const keys = new Set<string>();
	for (const version of versions) {
		for (const [key, value] of Object.entries(storedVersion(version).values)) {
			if (JSON.stringify(value).includes(needle)) keys.add(key);
		}
	}
	return [...keys].sort();
}

async function entryUses(scope: SiteScope, file: MediaReferences): Promise<MediaUse[]> {
	const rows = await scope.db
		.select({
			id: entries.id,
			draft: entries.draft,
			published: entries.published,
			postTypeId: postTypes.id,
			postTypeName: postTypes.name,
		})
		.from(entries)
		.innerJoin(postTypes, and(eq(postTypes.id, entries.postTypeId), eq(postTypes.siteId, entries.siteId)))
		.where(scope.where(entries, or(holds(entries.draft, file.id), holds(entries.published, file.id))));
	if (rows.length === 0) return [];
	const languages = languagesFor(await siteLanguages(scope));
	const place = { key: "title" as const, ...(languages ?? { language: "en", defaultLanguage: "en" }) };
	return rows
		.map((row) => ({
			kind: "entry" as const,
			id: row.id,
			title: readValue(storedVersion(row.draft), place) ?? readValue(storedVersion(row.published), place) ?? "",
			postType: { id: row.postTypeId, name: row.postTypeName },
			versions: versionsHolding(row, file.id),
			fields: fieldsHolding([row.draft, row.published], file.id),
		}))
		.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

async function globalsUses(scope: SiteScope, file: MediaReferences): Promise<MediaUse[]> {
	const row = await scope.first(globals, or(holds(globals.draft, file.id), holds(globals.published, file.id)));
	if (!row) return [];
	return [
		{
			kind: "globals",
			versions: versionsHolding(row, file.id),
			fields: fieldsHolding([row.draft, row.published], file.id),
		},
	];
}

async function templateUses(scope: SiteScope, file: MediaReferences): Promise<MediaUse[]> {
	const rows = await scope.db
		.select({
			id: templates.id,
			kind: templates.kind,
			draft: templates.draft,
			published: templates.published,
			postTypeId: postTypes.id,
			postTypeName: postTypes.name,
		})
		.from(templates)
		.leftJoin(postTypes, and(eq(postTypes.id, templates.postTypeId), eq(postTypes.siteId, templates.siteId)))
		.where(scope.where(templates, or(holds(templates.draft, file.id), holds(templates.published, file.id))))
		.orderBy(asc(templates.kind), asc(postTypes.name));
	return rows.map((row) => ({
		kind: "template",
		id: row.id,
		templateKind: row.kind as "site" | "entry" | "archive",
		postType: row.postTypeId && row.postTypeName !== null ? { id: row.postTypeId, name: row.postTypeName } : null,
		versions: versionsHolding(row, file.id),
	}));
}

async function componentUses(scope: SiteScope, file: MediaReferences): Promise<MediaUse[]> {
	const rows = await scope.select(
		components,
		or(holds(components.draft, file.id), holds(components.published, file.id)),
		{ orderBy: [asc(components.name)] },
	);
	return rows.map((row) => ({
		kind: "component",
		id: row.id,
		name: row.name,
		versions: versionsHolding(row, file.id),
	}));
}

async function loopUses(scope: SiteScope, file: MediaReferences): Promise<MediaUse[]> {
	const rows = await scope.select(loops, or(holds(loops.draft, file.id), holds(loops.published, file.id)), {
		orderBy: [asc(loops.name)],
	});
	return rows.map((row) => ({ kind: "loop", id: row.id, name: row.name, versions: versionsHolding(row, file.id) }));
}

/** The Design system's CSS names files by their address (`url(/_media/<name>)`), not by id. */
async function designSystemUses(scope: SiteScope, file: MediaReferences): Promise<MediaUse[]> {
	if (file.names.length === 0) return [];
	const row = await scope.first(
		designSystems,
		or(...file.names.flatMap((name) => [holds(designSystems.draft, name), holds(designSystems.published, name)])),
	);
	if (!row) return [];
	const versions = new Set<UseVersion>();
	for (const name of file.names) for (const version of versionsHolding(row, name)) versions.add(version);
	return [{ kind: "designSystem", versions: (["draft", "published"] as const).filter((each) => versions.has(each)) }];
}
