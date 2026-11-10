/**
 * The Site script and page scripts (ADR 0016): JavaScript Staff write in Code mode. They are
 * Structure (`structure.edit`, Staff only), with a Draft and a published version, published through
 * `publish` with `{ kind: "script", id }`. The Site script runs on every page; a page script runs on
 * its Entry's page only, after the Site script.
 *
 * Pages never carry them inline (ADR 0023): each version is a file named by the hash of its text, the
 * published ones at `/_wc/js/<hash>.js` on the Site's domain for visitors (and in Edit mode, where the
 * Site's own scripts run, ADR 0022), the Drafts at `/_webcraft/edit/js/<hash>.js` for Staff in Code
 * mode only. A file a publish replaces is still served for 30 days, for pages loaded before it.
 */

import { entries, scripts } from "@webcraft/db/schema";
import { contentHash, type PageScript, SCRIPT_PATH } from "@webcraft/renderer";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";

import { isUniqueViolation } from "../db-errors.ts";
import { CODE_MODE_SCRIPT_PATH } from "../edit-mode/paths.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { isUuid } from "../ids.ts";
import { personIdOf } from "../permissions/can.ts";
import { retireScriptFiles } from "../site-scripts/retired.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { DraftChangedError, EntryNotFoundError, ScriptNotFoundError } from "./errors.ts";
import type { SaveBase } from "./json.ts";

/** The longest script, in characters. */
export const SCRIPT_MAX_LENGTH = 200_000;

/** The Site script (every page) or a page script (one Entry's page). */
export type ScriptKind = "site" | "page";

/** A script, as the content store hands it out. */
export type Script = {
	id: string;
	siteId: string;
	kind: ScriptKind;
	/** The Entry whose page a page script runs on; null for the Site script. */
	entryId: string | null;
	/** Never published, published as it is, or changed since, as for Templates. */
	status: "draft" | "published" | "changed";
	draft: string;
	published: string | null;
	/** The Draft's version, which a save names as `basedOn`: the hash its file is named by. */
	version: string;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

type ScriptRow = typeof scripts.$inferSelect;

/** Which script a page shows: the Site script, or an Entry's page script. */
function whereFor(entryId: string | null): SQL {
	return (
		entryId === null
			? and(eq(scripts.kind, "site"), isNull(scripts.entryId))
			: and(eq(scripts.kind, "page"), eq(scripts.entryId, entryId))
	) as SQL;
}

/** The Site script (`entryId` null) or an Entry's page script; null while there is none. */
export async function getScript(scope: Pick<SiteScope, "first">, entryId: string | null): Promise<Script | null> {
	if (entryId !== null && !isUuid(entryId)) return null;
	const row = await scope.first(scripts, whereFor(entryId));
	return row ? toScript(row) : null;
}

/**
 * Saves the Draft of the Site script (`entryId` null) or of an Entry's page script, making it the
 * first time (open the Site with `structure.edit`). With `basedOn`, refused when the Draft changed
 * since that version (`DraftChangedError`). An `entryId` that isn't one of the Site's Entries is
 * `EntryNotFoundError`. Visitors run nothing of it until it is published.
 */
export async function saveScriptDraft(
	scope: SiteScope,
	entryId: string | null,
	code: string,
	base: SaveBase = {},
): Promise<Script> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await scope.transaction(async (tx) => {
				if (entryId !== null && (!isUuid(entryId) || !(await tx.first(entries, eq(entries.id, entryId))))) {
					throw new EntryNotFoundError();
				}
				const [current] = await tx.db
					.select()
					.from(scripts)
					.where(tx.where(scripts, whereFor(entryId)))
					.for("update");
				if (base.basedOn !== undefined) {
					const version = current?.draftHash ?? null;
					if (version !== base.basedOn) throw new DraftChangedError(version);
				}
				const now = tx.now();
				const draft = {
					draft: code,
					draftHash: contentHash(code),
					updatedAt: now,
					updatedBy: personIdOf(tx.access.actor),
					updatedVia: clientNameOf(tx.access.via),
				};
				if (current) {
					const [updated] = await tx.update(scripts, draft, eq(scripts.id, current.id));
					await noteDraftChange(
						tx,
						{ kind: "script", id: current.id },
						{
							content: current.draft,
							changedAt: current.updatedAt,
							changedBy: current.updatedBy,
							since: current.createdAt,
						},
						code,
					);
					return toScript(updated as ScriptRow);
				}
				const made = await tx.insert(scripts, {
					kind: entryId === null ? "site" : "page",
					entryId,
					...draft,
					createdAt: now,
				});
				await noteDraftChange(
					tx,
					{ kind: "script", id: made.id },
					{ content: "", changedAt: now, changedBy: null, since: now },
					code,
					{ created: true },
				);
				return toScript(made);
			});
		} catch (error) {
			// Someone made the same script at the same moment: the next try saves over theirs, checked again.
			if (!isUniqueViolation(error, "scripts_site_id_kind_entry_id_unique") || attempt >= 3) throw error;
		}
	}
}

/** A script of the Site by its id; `ScriptNotFoundError` when there is none. */
export async function scriptById(scope: Pick<SiteScope, "first">, scriptId: string): Promise<Script> {
	const row = isUuid(scriptId) ? await scope.first(scripts, eq(scripts.id, scriptId)) : undefined;
	if (!row) throw new ScriptNotFoundError();
	return toScript(row);
}

/** Reads a script to publish it, holding it until the transaction ends. */
export async function lockScript(scope: SiteScope, scriptId: string): Promise<ScriptRow> {
	const [row] = isUuid(scriptId)
		? await scope.db
				.select()
				.from(scripts)
				.where(scope.where(scripts, eq(scripts.id, scriptId)))
				.for("update")
		: [];
	if (!row) throw new ScriptNotFoundError();
	return row;
}

/**
 * Publishes a script's Draft (called by `publish`, which checks `structure.edit` and clears the page
 * cache), or `version` when given: a Scheduled publish's text, frozen when it was scheduled.
 */
export async function publishScriptDraft(
	scope: SiteScope,
	scriptId: string,
	version?: unknown,
): Promise<{ id: string; publishedAt: Date }> {
	const row = await lockScript(scope, scriptId);
	const code = typeof version === "string" ? version : row.draft;
	const hash = typeof version === "string" ? contentHash(version) : row.draftHash;
	const now = scope.now();
	// Pages loaded before this publish still ask for the file it replaces: it is served for 30 days.
	if (row.published !== null && row.publishedHash && row.publishedHash !== hash) {
		await retireScriptFiles(scope, [{ hash: row.publishedHash, code: row.published }]);
	}
	await scope.update(
		scripts,
		{ published: code, publishedHash: hash, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(scripts.id, row.id),
	);
	await scope.audit("script.publish", { scriptId: row.id, kind: row.kind, entryId: row.entryId });
	return { id: row.id, publishedAt: now };
}

/**
 * The scripts a page runs, as paths on the Site's domain, the Site script first: the published ones
 * (`/_wc/js/<hash>.js`), or in Code mode the Drafts (`/_webcraft/edit/js/<hash>.js`). Empty scripts
 * aren't run.
 */
export async function pageScripts(
	scope: Pick<VisitorScope, "first">,
	entryId: string | null,
	version: "published" | "draft",
	/** Where the Drafts' files are: Code mode's own path unless given (the Staging address serves them as the Site's). */
	draftPath: string = CODE_MODE_SCRIPT_PATH,
): Promise<PageScript[]> {
	const found = [await scope.first(scripts, whereFor(null))];
	if (entryId !== null) found.push(await scope.first(scripts, whereFor(entryId)));
	return found.flatMap((row): PageScript[] => {
		if (!row) return [];
		const kind = row.kind === "page" ? "page" : "site";
		if (version === "draft") {
			return row.draft.trim() ? [{ kind, src: `${draftPath}${row.draftHash}.js` }] : [];
		}
		return row.published?.trim() ? [{ kind, src: `${SCRIPT_PATH}${row.publishedHash}.js` }] : [];
	});
}

/** A script's file name: 16 hexadecimal digits of its text's SHA-256, then `.js`. */
const SCRIPT_NAME = /^([0-9a-f]{16})\.js$/;

/** A script of the Site by its file name: a published one, or with `draft` one of the Drafts; null for any other name. */
export async function scriptFile(
	scope: Pick<VisitorScope, "first">,
	name: string,
	version: "published" | "draft",
): Promise<string | null> {
	const hash = SCRIPT_NAME.exec(name)?.[1];
	if (!hash) return null;
	if (version === "draft") return (await scope.first(scripts, eq(scripts.draftHash, hash)))?.draft ?? null;
	return (await scope.first(scripts, eq(scripts.publishedHash, hash)))?.published ?? null;
}

export function toScript(row: ScriptRow): Script {
	return {
		id: row.id,
		siteId: row.siteId,
		kind: row.kind as ScriptKind,
		entryId: row.entryId,
		status: row.published === null ? "draft" : row.published === row.draft ? "published" : "changed",
		draft: row.draft,
		published: row.published,
		version: row.draftHash,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}
