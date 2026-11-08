import { globals } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { siteLanguages } from "./entries.ts";
import { type ContentProblem, GlobalsIncompleteError, GlobalsInvalidError } from "./errors.ts";
import type { FieldDefinition, FieldInput, Json } from "./field-types.ts";
import { checkFields, defaultValues, type Findings, randomRowId, readFields, writeFields } from "./field-values.ts";
import { parseFields, RESERVED_FIELD_KEYS, storedFields } from "./fields.ts";
import { sameJson } from "./json.ts";
import { clearPageCache } from "./page-cache.ts";
import type { Published } from "./publishing.ts";
import { type EntryVersion, emptyVersion, storedVersion, type Writer } from "./values.ts";

/**
 * Globals: one set of Fields per Site, such as its phone number, address or footer text, that every
 * Template reads as `site.x`. Staff define the Fields (Structure: `structure.edit`, applied at once);
 * Members edit the values in a Draft (`entry.edit`) and publish them (`entry.publish`), like an
 * Entry's. Globals hold every Field type but Relationships.
 */
export type Globals = {
	siteId: string;
	/** The Fields, in order. */
	fields: FieldDefinition[];
	/** `draft` until first published, then `published` or `changed`, as for Entries. */
	status: "draft" | "published" | "changed";
	/** The language the values are in. */
	language: string;
	/** The Draft values, by key. */
	draft: Record<string, Json>;
	/** What visitors see; null until first published. */
	published: Record<string, Json> | null;
	/** What keeps the Draft from being published, by path (`fields.phone`), with the rule. */
	problems: ContentProblem[];
	/** When the Fields or the Draft last changed; null while the Site has no Globals. */
	updatedAt: Date | null;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

/** A change to the Globals' Draft, in one language (the Site's Default language unless given). */
export type GlobalsChange = { language?: string; fields: Record<string, unknown> };

/** Names a Global can't take: `site.x` may come to read the Site's own name, address and language. */
const RESERVED_GLOBAL_KEYS: ReadonlySet<string> = new Set([
	"name",
	"url",
	"language",
	"languages",
	"id",
	"type",
	"fields",
]);

type GlobalsRow = typeof globals.$inferSelect;

/** The Site's Globals, in a language (the Default language unless given). */
export async function getGlobals(scope: SiteScope, language?: string): Promise<Globals> {
	const { defaultLanguage } = await siteLanguages(scope);
	const chosen = checkLanguage(language, defaultLanguage);
	const row = await scope.first(globals);
	return toGlobals(scope, row, chosen, defaultLanguage);
}

/**
 * Sets the Globals' Fields (open the Site with `structure.edit`): the full list, in order. Like a
 * Post Type's, a change applies at once, keeps each Field's type, and clears the Site's page cache.
 * A Field added with a default starts the Draft with it.
 */
export async function setGlobalFields(scope: SiteScope, inputs: readonly FieldInput[]): Promise<Globals> {
	return scope.transaction(async (tx) => {
		const row = await lockGlobals(tx);
		const existing = storedFields(row.fields);
		const problems: ContentProblem[] = [];
		const fields = parseFields(
			inputs,
			problems,
			{
				postTypeKeys: new Set(),
				owner: "globals",
				reservedKeys: new Set([...RESERVED_FIELD_KEYS, ...RESERVED_GLOBAL_KEYS]),
			},
			existing,
		);
		if (problems.length > 0) throw new GlobalsInvalidError(problems);
		const { defaultLanguage } = await siteLanguages(tx);
		const added = fields.filter((field) => !existing.some((before) => before.key === field.key));
		const draft = storedVersion(row.draft);
		const defaults = defaultValues(added, {
			language: defaultLanguage,
			defaultLanguage,
			by: writerOf(tx),
			newRowId: randomRowId,
		});
		const [saved] = await tx.update(
			globals,
			{ fields, draft: { values: { ...draft.values, ...defaults } }, updatedAt: tx.now() },
			eq(globals.id, row.id),
		);
		await clearPageCache(tx);
		await tx.audit("globals.update", { keys: fields.map((field) => field.key) });
		return toGlobals(tx, saved ?? row, defaultLanguage, defaultLanguage);
	});
}

/**
 * Saves a change to the Globals' Draft (open the Site with `entry.edit`): the one place it is
 * written. Values of the wrong kind are refused (`GlobalsInvalidError`); values breaking a rule are
 * saved and listed in `problems`. Visitors see nothing of it until the Globals are published.
 */
export async function saveGlobalsDraft(scope: SiteScope, change: GlobalsChange): Promise<Globals> {
	return scope.transaction(async (tx) => {
		const row = await lockGlobals(tx);
		const fields = storedFields(row.fields);
		const { defaultLanguage } = await siteLanguages(tx);
		const language = change.language ?? defaultLanguage;
		const problems: ContentProblem[] = [];
		if (language !== defaultLanguage)
			problems.push({ at: "language", message: `The Site has no language ${language}.` });
		const values = writeFields(
			storedVersion(row.draft).values,
			fields,
			change.fields,
			{ language, defaultLanguage, by: writerOf(tx), problems, references: [], newRowId: randomRowId },
			"fields.",
			"The Globals",
		);
		if (problems.length > 0) throw new GlobalsInvalidError(problems);
		const [saved] = await tx.update(globals, { draft: { values }, updatedAt: tx.now() }, eq(globals.id, row.id));
		return toGlobals(tx, saved ?? row, language, defaultLanguage);
	});
}

/**
 * Publishes the Globals' Draft, inside `publish`'s transaction: refuses broken rules
 * (`GlobalsInvalidError`) and empty required values (`GlobalsIncompleteError`).
 */
export async function publishGlobals(scope: SiteScope): Promise<Published> {
	const row = await lockGlobals(scope);
	const { defaultLanguage } = await siteLanguages(scope);
	const draft = storedVersion(row.draft);
	const findings = globalsFindings(draft, storedFields(row.fields), defaultLanguage);
	if (findings.problems.some((problem) => problem.rule !== "required"))
		throw new GlobalsInvalidError(findings.problems);
	if (findings.missing.length > 0) throw new GlobalsIncompleteError(findings.missing);
	const now = scope.now();
	await scope.update(
		globals,
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(globals.id, row.id),
	);
	await scope.audit("globals.publish", { globalsId: row.id });
	return { kind: "globals", id: row.id, publishedAt: now };
}

/** The Site's published Globals: their Fields and published values (empty while never published). */
export function publishedGlobals(
	row: GlobalsRow | undefined,
	languages: { language: string; defaultLanguage: string },
) {
	const fields = storedFields(row?.fields);
	const values = row?.published ? readFields(storedVersion(row.published).values, fields, languages) : {};
	return { fields, values };
}

/** Reads the Site's Globals for a change, making them the first time, and holds them until the transaction ends. */
async function lockGlobals(scope: SiteScope): Promise<GlobalsRow> {
	const now = scope.now();
	await scope.db
		.insert(globals)
		.values({
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
			draft: emptyVersion(),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	const [row] = await scope.db.select().from(globals).where(scope.where(globals)).for("update");
	if (!row) throw new Error("The Site's Globals could not be made.");
	return row;
}

function globalsFindings(version: EntryVersion, fields: readonly FieldDefinition[], language: string): Findings {
	const findings: Findings = { problems: [], missing: [], references: [] };
	checkFields(version.values, fields, { language, defaultLanguage: language }, findings);
	return findings;
}

function toGlobals(
	scope: Pick<SiteScope, "site">,
	row: GlobalsRow | undefined,
	language: string,
	defaultLanguage: string,
): Globals {
	const fields = storedFields(row?.fields);
	const languages = { language, defaultLanguage };
	const draft = storedVersion(row?.draft);
	return {
		siteId: scope.site.id,
		fields,
		status: !row?.published ? "draft" : sameJson(row.draft, row.published) ? "published" : "changed",
		language,
		draft: readFields(draft.values, fields, languages),
		published: row?.published ? readFields(storedVersion(row.published).values, fields, languages) : null,
		problems: globalsFindings(draft, fields, defaultLanguage).problems,
		updatedAt: row?.updatedAt ?? null,
		publishedAt: row?.publishedAt ?? null,
		lastPublishedAt: row?.lastPublishedAt ?? null,
	};
}

function checkLanguage(language: string | undefined, defaultLanguage: string): string {
	if (language !== undefined && language !== defaultLanguage) {
		throw new GlobalsInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	}
	return defaultLanguage;
}

function writerOf(scope: Pick<SiteScope, "access">): Writer {
	return { kind: "person", personId: scope.access.actor.personId };
}
