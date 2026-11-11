/**
 * Component scripts (GLOSSARY.md): one optional script per Component of the Site, which Staff write
 * in Code mode's JS panel. It is Structure (`structure.edit`, Staff only) with a Draft, published with
 * its Component (`publish` with `{ kind: "component", id }` publishes both). It is kept as a row of
 * the `scripts` table (`kind = 'component'`), so its versions are files named by their hash like the
 * Site script's, retired for 30 days when a publish replaces them (ADR 0023).
 *
 * Besides its code each version holds its Consent category (Necessary unless Staff choose another),
 * which visitors must accept before it runs, and the Site's Libraries it needs, which then load only
 * on pages showing the Component. Pages load it through a loader of its own
 * (`componentLoaderName`, renderer), once per page, between the Site script and the page script.
 */
import { components, libraries, scripts } from "@webcraft/db/schema";
import {
	componentLoaderName,
	componentLoaderText,
	contentHash,
	type PageComponentScript,
	readComponentLoaderName,
} from "@webcraft/renderer";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { SCRIPT_PATH } from "../design-system/stylesheet.ts";
import { CODE_MODE_SCRIPT_PATH } from "../edit-mode/paths.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { isUuid } from "../ids.ts";
import { personIdOf } from "../permissions/can.ts";
import { LibraryNotFoundError } from "../site-scripts/errors.ts";
import { CONSENT_CATEGORIES, type ConsentCategory } from "../site-scripts/outside-scripts.ts";
import { retiredScript, retireScriptFiles } from "../site-scripts/retired.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { ComponentFromModuleError, ComponentNotFoundError, DraftChangedError } from "./errors.ts";
import type { SaveBase } from "./json.ts";

/** One version of a Component script: its code, its Consent category and the Libraries it declares. */
export type ComponentScriptVersion = {
	code: string;
	consentCategory: ConsentCategory;
	/** The Site's Libraries it needs, by id: they load only on pages showing the Component. */
	libraryIds: string[];
};

/** A Component script, as the content store hands it out. */
export type ComponentScript = {
	id: string;
	componentId: string;
	/** Never published, published as it is, or changed since, as for its Component. */
	status: "draft" | "published" | "changed";
	draft: ComponentScriptVersion;
	published: ComponentScriptVersion | null;
	/** The Draft's version, which a save names as `basedOn`: covers its code and its settings. */
	version: string;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

/** What a save of a Component script's Draft gives: its code, and its settings when they change. */
export type ComponentScriptInput = { code: string; consentCategory?: ConsentCategory; libraryIds?: string[] };

type ScriptRow = typeof scripts.$inferSelect;

function whereComponent(componentId: string): SQL {
	return and(eq(scripts.kind, "component"), eq(scripts.componentId, componentId)) as SQL;
}

function draftOf(row: ScriptRow): ComponentScriptVersion {
	return {
		code: row.draft,
		consentCategory: readCategory(row.consentCategory),
		libraryIds: [...(row.libraryIds ?? [])],
	};
}

function publishedOf(row: ScriptRow): ComponentScriptVersion | null {
	if (row.published === null) return null;
	return {
		code: row.published,
		consentCategory: readCategory(row.publishedConsentCategory),
		libraryIds: [...(row.publishedLibraryIds ?? [])],
	};
}

function readCategory(value: string | null): ConsentCategory {
	return (CONSENT_CATEGORIES as readonly string[]).includes(value ?? "") ? (value as ConsentCategory) : "necessary";
}

/** A version's own version: 16 hexadecimal digits of the SHA-256 of its code and settings. */
function versionOf(version: ComponentScriptVersion): string {
	return contentHash(JSON.stringify([version.code, version.consentCategory, [...version.libraryIds].sort()]));
}

function sameVersion(a: ComponentScriptVersion | null, b: ComponentScriptVersion | null): boolean {
	return a !== null && b !== null && versionOf(a) === versionOf(b);
}

export function toComponentScript(row: ScriptRow): ComponentScript {
	const draft = draftOf(row);
	const published = publishedOf(row);
	return {
		id: row.id,
		componentId: row.componentId as string,
		status: published === null ? "draft" : sameVersion(draft, published) ? "published" : "changed",
		draft,
		published,
		version: versionOf(draft),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}

/** Whether a Component script's Draft differs from what is published (a never-published empty one doesn't). */
export function componentScriptChanged(row: ScriptRow): boolean {
	const draft = draftOf(row);
	const published = publishedOf(row);
	if (published === null) return draft.code.trim() !== "";
	return !sameVersion(draft, published);
}

/**
 * Checks `componentId` is one of the Site's own Components: a Module's has no Component script
 * (`ComponentFromModuleError`), and one the Site doesn't have is `ComponentNotFoundError`.
 */
async function ownComponent(scope: Pick<SiteScope, "first">, componentId: string): Promise<void> {
	if (!isUuid(componentId)) {
		throw /^[a-z][a-z0-9-]*:[A-Z]/.test(componentId) ? new ComponentFromModuleError() : new ComponentNotFoundError();
	}
	if (!(await scope.first(components, eq(components.id, componentId)))) throw new ComponentNotFoundError();
}

/** One of the Site's Components' script; null while it has none. Open the Site with `structure.edit`. */
export async function componentScriptOf(
	scope: Pick<SiteScope, "first">,
	componentId: string,
): Promise<ComponentScript | null> {
	await ownComponent(scope, componentId);
	return getComponentScript(scope, componentId);
}

/** Saves one of the Site's Components' script's Draft (`saveComponentScriptDraft`), checking the Component first. */
export async function saveComponentScript(
	scope: SiteScope,
	componentId: string,
	input: ComponentScriptInput,
	base: SaveBase = {},
): Promise<ComponentScript> {
	await ownComponent(scope, componentId);
	return saveComponentScriptDraft(scope, componentId, input, base);
}

/** A Component's script; null while it has none. Open the Site with `structure.edit`. */
export async function getComponentScript(
	scope: Pick<SiteScope, "first">,
	componentId: string,
): Promise<ComponentScript | null> {
	if (!isUuid(componentId)) return null;
	const row = await scope.first(scripts, whereComponent(componentId));
	return row ? toComponentScript(row) : null;
}

/**
 * Saves the Draft of a Component's script, making it the first time; the Consent category and the
 * Libraries stay as they were unless given. With `basedOn`, refused when the Draft changed since
 * that version (`DraftChangedError`). A Library that isn't the Site's is `LibraryNotFoundError`.
 * The caller has checked the Component is one of the Site's own. Visitors run nothing of it until
 * its Component is published.
 */
export async function saveComponentScriptDraft(
	scope: SiteScope,
	componentId: string,
	input: ComponentScriptInput,
	base: SaveBase = {},
): Promise<ComponentScript> {
	const libraryIds = input.libraryIds === undefined ? undefined : [...new Set(input.libraryIds)];
	for (let attempt = 1; ; attempt++) {
		try {
			return await scope.transaction(async (tx) => {
				if (libraryIds && libraryIds.length > 0) {
					const known =
						libraryIds.every(isUuid) &&
						(await tx.count(libraries, inArray(libraries.id, libraryIds))) === libraryIds.length;
					if (!known) throw new LibraryNotFoundError();
				}
				const [current] = await tx.db
					.select()
					.from(scripts)
					.where(tx.where(scripts, whereComponent(componentId)))
					.for("update");
				if (base.basedOn !== undefined) {
					const version = current ? versionOf(draftOf(current)) : null;
					if (version !== base.basedOn) throw new DraftChangedError(version);
				}
				const now = tx.now();
				const draft = {
					draft: input.code,
					draftHash: contentHash(input.code),
					consentCategory: input.consentCategory ?? readCategory(current?.consentCategory ?? null),
					libraryIds: libraryIds ?? current?.libraryIds ?? [],
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
						input.code,
					);
					return toComponentScript(updated as ScriptRow);
				}
				const made = await tx.insert(scripts, {
					kind: "component",
					entryId: null,
					componentId,
					...draft,
					createdAt: now,
				});
				await noteDraftChange(
					tx,
					{ kind: "script", id: made.id },
					{ content: "", changedAt: now, changedBy: null, since: now },
					input.code,
					{ created: true },
				);
				return toComponentScript(made);
			});
		} catch (error) {
			// Someone made the same script at the same moment: the next try saves over theirs, checked again.
			if (!isUniqueViolation(error, "scripts_site_id_kind_entry_id_component_id_unique") || attempt >= 3) throw error;
		}
	}
}

/**
 * Publishes a Component's script with its Component (called by `publish`, which checks
 * `structure.edit` and clears the page cache): its Draft, code and settings, becomes what visitors
 * run. Nothing happens when the Component has no script or it is published as it is. The file a
 * publish replaces is still served for 30 days.
 */
export async function publishComponentScript(scope: SiteScope, componentId: string): Promise<void> {
	const [row] = await scope.db
		.select()
		.from(scripts)
		.where(scope.where(scripts, whereComponent(componentId)))
		.for("update");
	if (!row || !componentScriptChanged(row)) return;
	const now = scope.now();
	if (row.published !== null && row.publishedHash && row.publishedHash !== row.draftHash) {
		await retireScriptFiles(scope, [{ hash: row.publishedHash, code: row.published }]);
	}
	await scope.update(
		scripts,
		{
			published: row.draft,
			publishedHash: row.draftHash,
			publishedConsentCategory: readCategory(row.consentCategory),
			publishedLibraryIds: row.libraryIds ?? [],
			publishedAt: row.publishedAt ?? now,
			lastPublishedAt: now,
		},
		eq(scripts.id, row.id),
	);
	await scope.audit("script.publish", { scriptId: row.id, kind: "component", componentId });
}

/** A Component script a page may load, with the Libraries it declares. */
export type ComponentScriptOnPage = PageComponentScript & { libraryIds: readonly string[] };

/**
 * The Component scripts the Site's pages may load, as the version shown has them: the published ones
 * for visitors and Edit mode (loaders at `/_wc/js/component/<id>/<hash>.js`), or in Code mode the
 * Drafts (at Code mode's own path unless given). Empty scripts aren't loaded. Each carries its
 * Component's name, which Edit mode shows with an error.
 */
export async function siteComponentScripts(
	scope: Pick<VisitorScope, "select">,
	version: "published" | "draft",
	draftPath: string = CODE_MODE_SCRIPT_PATH,
): Promise<ComponentScriptOnPage[]> {
	const rows = await scope.select(scripts, eq(scripts.kind, "component"));
	const shown = rows.flatMap((row) => {
		const at = version === "draft" ? draftOf(row) : publishedOf(row);
		const hash = version === "draft" ? row.draftHash : row.publishedHash;
		return at && hash && at.code.trim() ? [{ componentId: row.componentId as string, at, hash }] : [];
	});
	if (shown.length === 0) return [];
	const names = new Map(
		(
			await scope.select(
				components,
				inArray(
					components.id,
					shown.map((script) => script.componentId),
				),
			)
		).map((row) => [row.id, row.name]),
	);
	return shown.map(({ componentId, at, hash }) => ({
		componentId,
		name: names.get(componentId) ?? "",
		src: `${version === "draft" ? draftPath : SCRIPT_PATH}${componentLoaderName(componentId, hash)}`,
		consentCategory: at.consentCategory,
		libraryIds: at.libraryIds,
	}));
}

/**
 * A Component script's loader by its name under a scripts path (`component/<id>/<hash>.js`): its text,
 * when the Site has a Component script for that Component whose version (the published one, or with
 * `draft` the Draft) is the file `hash`, or the file is one a publish replaced in the last 30 days.
 * Null for any other name.
 */
export async function componentLoaderFile(
	scope: Pick<VisitorScope, "first" | "now">,
	name: string,
	version: "published" | "draft",
): Promise<string | null> {
	const loader = readComponentLoaderName(name);
	if (!loader) return null;
	const column = version === "draft" ? scripts.draftHash : scripts.publishedHash;
	const current = await scope.first(scripts, and(whereComponent(loader.componentId), eq(column, loader.hash)) as SQL);
	if (!current && (version === "draft" || (await retiredScript(scope, loader.hash)) === null)) return null;
	return componentLoaderText(loader.componentId, loader.hash);
}
