/**
 * Undo of an Import run: removes the whole run, in two steps, while nothing it brought in has been
 * published or edited since. The Drafts it created are deleted, the Drafts it updated go back to
 * what they were, the files it fetched go to the Media library's Trash (unless something outside
 * the run uses them), the Redirect rules it added are removed (through the Module keeping them;
 * a rule someone changed since stays), and the Post Types it created are deleted once they hold no
 * Entry and nothing else of the Site names them (Templates, other Post Types' Relationships); its
 * Import's settings go back to what the run started with. Fields it added to a Post Type the Site
 * had stay: Structure someone may build on.
 *
 * "Edited" is any change to the Draft the run left: a Draft save by a person (even one that changes
 * nothing, which saves it again), or a later run of an Import updating it.
 */
import {
	entries,
	importItems,
	importRunChanges,
	importRuns,
	imports,
	media,
	postTypes,
	templates,
} from "@webcraft/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { removalBlocks, removeEntries, replaceDraft } from "../content/entries.ts";
import { sameJson } from "../content/json.ts";
import { siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { listPostTypes } from "../content/post-types.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { isUuid } from "../ids.ts";
import { mediaUses } from "../media/usage.ts";
import type { ModuleHost } from "../modules/host.ts";
import { actingPerson } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { ImportRunNotFoundError, ImportUndoRefusedError, type UndoRefusal } from "./errors.ts";
import { entryStates, touched } from "./pipeline.ts";

/**
 * What undoing a run does: how many Drafts it deletes and puts back, how many files go to the Trash,
 * how many Redirect rules it removes and which Post Types it deletes.
 */
export type UndoPreview = { removes: number; restores: number; files: number; rules: number; postTypes: string[] };

/** Undo's first step answers what it would do; the second does it. */
export type ImportUndo =
	| { undone: false; preview: UndoPreview; confirmation: Confirmation }
	| { undone: true; preview: UndoPreview };

type RunRow = typeof importRuns.$inferSelect;
type ChangeRow = typeof importRunChanges.$inferSelect;

/** What undoing a run would do, or why it can't be undone. */
type UndoPlan =
	| { refused: UndoRefusal; entries: { id: string; title: string }[] }
	| { removes: string[]; restores: ChangeRow[]; files: string[]; rules: ChangeRow[]; postTypes: ChangeRow[] };

/**
 * Undoes a run, in two steps (open the Site with `import.run`): without `confirmation` it answers what
 * it would do and a confirmation id; with it, it does it (logged `import.undo`). Refused
 * (`ImportUndoRefusedError`) for a run that hasn't ended or was undone, and once anything it brought
 * in was published or edited since.
 */
export async function undoRun(
	scope: SiteScope,
	modules: ModuleHost,
	runId: string,
	confirmation?: string,
): Promise<ImportUndo> {
	const done = await scope.transaction(async (tx) => {
		const [run] = isUuid(runId)
			? await tx.db
					.select()
					.from(importRuns)
					.where(tx.where(importRuns, eq(importRuns.id, runId)))
					.for("update")
			: [];
		if (!run) throw new ImportRunNotFoundError();
		const plan = await undoPlan(tx, run);
		if ("refused" in plan) throw new ImportUndoRefusedError(plan.refused, plan.entries);
		const preview: UndoPreview = {
			removes: plan.removes.length,
			restores: plan.restores.length,
			files: plan.files.length,
			rules: plan.rules.length,
			postTypes: plan.postTypes.map((change) => (change.details as { name: string }).name),
		};
		const request = { action: "import.undo", target: run.id, preview };
		if (confirmation === undefined) {
			return { undo: { undone: false, preview, confirmation: await askConfirmation(tx, request) } as ImportUndo };
		}
		await useConfirmation(tx, confirmation, request);

		for (const change of plan.restores) {
			await replaceDraft(tx, change.entryId as string, change.before);
		}
		const blocked = await removeEntries(tx, plan.removes);
		if (blocked.length > 0) {
			throw new ImportUndoRefusedError(
				"linked",
				blocked.map((block) => ({ id: block.by.entryId, title: block.by.title })),
			);
		}
		// What Undo put back is as untouched as before the run: a later run may update it again.
		const restored = await entryStates(
			tx,
			plan.restores.map((change) => change.entryId as string),
		);
		for (const state of restored) {
			await tx.update(
				importItems,
				{ writtenHash: state.hash, writtenAt: state.updatedAt },
				and(eq(importItems.importId, run.importId), eq(importItems.entryId, state.id)),
			);
		}
		if (plan.files.length > 0) {
			await tx.update(
				media,
				{ trashedAt: tx.now(), trashedBy: actingPerson(tx.access.actor), updatedAt: tx.now() },
				and(inArray(media.id, plan.files), isNull(media.trashedAt)),
			);
			await clearPageCache(tx);
		}
		const removedTypes = await removeCreatedPostTypes(tx, plan.postTypes);
		if (removedTypes > 0) {
			// The Import's settings go back to what the run started with, naming no Post Type it removed.
			const [current] = await tx.select(imports, eq(imports.id, run.importId));
			const resolved = (run.summary as { resolved?: unknown }).resolved;
			if (current && resolved && sameJson(current.settings, resolved)) {
				await tx.update(imports, { settings: run.settings, updatedAt: tx.now() }, eq(imports.id, current.id));
			}
			await clearPageCache(tx);
		}
		await tx.update(
			importRuns,
			{ status: "undone", undoneAt: tx.now(), undoneBy: actingPerson(tx.access.actor) },
			eq(importRuns.id, run.id),
		);
		await tx.audit("import.undo", {
			importId: run.importId,
			runId: run.id,
			number: run.number,
			removed: preview.removes,
			restored: preview.restores,
			trashed: preview.files,
			rules: preview.rules,
			postTypes: removedTypes,
		});
		return { undo: { undone: true, preview } as ImportUndo, rules: plan.rules };
	});
	// Redirect rules are the Module's: removed through it once the rest is undone.
	const rules = "rules" in done ? (done.rules ?? []) : [];
	if (done.undo.undone && rules.length > 0) {
		await modules.removeImportedRules(
			scope.site,
			rules.map((change) => {
				const { from, to } = change.details as { from: string; to: string };
				return { ruleId: change.ruleId as string, from, to };
			}),
		);
	}
	return done.undo;
}

/**
 * Deletes the Post Types a run created while they hold no Entry and nothing else of the Site names
 * them (a Template, a Relationship of a Post Type that stays): answers how many went.
 */
async function removeCreatedPostTypes(scope: SiteScope, created: readonly ChangeRow[]): Promise<number> {
	const all = await listPostTypes(scope);
	const removable = new Set<string>();
	for (const change of created) {
		const id = change.postTypeId;
		if (!id || !all.some((each) => each.id === id)) continue;
		const held = await scope.count(entries, eq(entries.postTypeId, id));
		const templated = await scope.count(templates, eq(templates.postTypeId, id));
		if (held === 0 && templated === 0) removable.add(id);
	}
	// A Post Type a staying one points at stays too, until nothing staying names one being removed.
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of [...removable]) {
			const key = all.find((each) => each.id === id)?.key;
			const named = all.some((other) => !removable.has(other.id) && JSON.stringify(other.fields).includes(`"${key}"`));
			if (named) {
				removable.delete(id);
				changed = true;
			}
		}
	}
	if (removable.size > 0) await scope.delete(postTypes, inArray(postTypes.id, [...removable]));
	return removable.size;
}

/** Whether a run can be undone now, and why not. */
export async function undoState(
	scope: SiteScope,
	run: RunRow,
): Promise<{ available: boolean; reason: UndoRefusal | null }> {
	const plan = await undoPlan(scope, run);
	return "refused" in plan ? { available: false, reason: plan.refused } : { available: true, reason: null };
}

/**
 * What undoing a run would do: the Entries it created to delete, the Drafts it updated to put back
 * and the files it fetched to put in the Trash; or why it can't be undone, with the Entries in the way.
 */
async function undoPlan(scope: SiteScope, run: RunRow): Promise<UndoPlan> {
	if (run.status !== "done" && run.status !== "stopped" && run.status !== "failed") {
		return { refused: "status", entries: [] };
	}
	const changes = await scope.select(
		importRunChanges,
		and(eq(importRunChanges.runId, run.id), inArray(importRunChanges.action, ["created", "updated"])),
	);
	const rules = changes.filter((change) => change.kind === "redirect" && change.ruleId);
	const createdTypes = changes.filter((change) => change.kind === "postType" && change.postTypeId);
	const entryChanges = changes.filter((change) => change.kind === "entry" && change.entryId);
	const states = new Map(
		(
			await entryStates(
				scope,
				entryChanges.map((change) => change.entryId as string),
			)
		).map((state) => [state.id, state]),
	);
	const published: string[] = [];
	const edited: string[] = [];
	const removes: string[] = [];
	const restores: ChangeRow[] = [];
	for (const change of entryChanges) {
		const state = states.get(change.entryId as string);
		// Deleted since: there is nothing of it to undo.
		if (!state) continue;
		const publishedSince =
			change.action === "created"
				? state.published
				: (state.lastPublishedAt?.getTime() ?? null) !== (change.publishedThen?.getTime() ?? null);
		if (publishedSince) published.push(state.id);
		else if (touched(state, change)) edited.push(state.id);
		else if (change.action === "created") removes.push(state.id);
		else restores.push(change);
	}
	if (published.length > 0) return { refused: "published", entries: await titled(scope, published) };
	if (edited.length > 0) return { refused: "edited", entries: await titled(scope, edited) };
	// Told at the first step, and in the report, not only when it would go ahead.
	const blocked = await removalBlocks(scope, removes);
	if (blocked.length > 0) {
		const linking = new Map(
			blocked.map((block) => [block.by.entryId, { id: block.by.entryId, title: block.by.title }]),
		);
		return { refused: "linked", entries: [...linking.values()].slice(0, 20) };
	}
	const removing = new Set(removes);
	const files: string[] = [];
	for (const change of changes) {
		if (change.kind !== "media" || !change.mediaId) continue;
		const found = await scope.first(media, and(eq(media.id, change.mediaId), isNull(media.trashedAt)));
		if (!found) continue;
		// A file something outside the run uses stays in the Media library.
		const uses = await mediaUses(scope, found.id);
		if (uses.every((use) => use.kind === "entry" && removing.has(use.id))) files.push(found.id);
	}
	return { removes, restores, files, rules, postTypes: createdTypes };
}

/** The first Entries of a list with their titles in the Default language, for a refusal to name. */
async function titled(scope: SiteScope, ids: readonly string[]): Promise<{ id: string; title: string }[]> {
	const { defaultLanguage } = await siteLanguages(scope);
	const rows = await scope.select(entries, inArray(entries.id, ids.slice(0, 20)));
	return rows.map((row) => ({
		id: row.id,
		title: readValue(storedVersion(row.draft), { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
	}));
}
