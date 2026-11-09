import type { Database } from "@webcraft/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { readHistorySettings } from "./settings.ts";

/**
 * Keeps every item's history within the Install's retention (Install settings › Revisions): a
 * Revision goes once it is older than the days Revisions are kept and isn't among its item's newest
 * ones kept anyway; a Checkpoint once it is older than the days Checkpoints are kept. The history of
 * an item that no longer exists (an Entry, a Component, a Form deleted) goes with it, and so do the
 * shared documents of Co-editing (ADR 0025) unused for `DOCUMENT_KEPT_DAYS` or whose item is gone: a
 * Draft opened again later starts a new one from its Draft. Rows go in batches, so a large Install
 * never holds one long lock.
 */

/** How long a shared document nobody opened or changed is kept. */
export const DOCUMENT_KEPT_DAYS = 30;

/** How many rows one statement deletes at most. */
const BATCH = 5_000;

/** The tables of the items whose history is kept by id, by kind. */
const ITEM_TABLES = {
	entry: "entries",
	template: "templates",
	component: "components",
	loop: "loops",
	filter: "filters",
	script: "scripts",
	form: "forms",
	formEmails: "forms",
} as const;

/** Deletes in batches until a statement deletes nothing; answers how many rows went. */
async function inBatches(database: Database, statement: () => ReturnType<typeof sql>): Promise<number> {
	let total = 0;
	for (;;) {
		const result = await database.db.execute(statement());
		const deleted = Number((result as { rowCount?: number | null }).rowCount ?? 0);
		total += deleted;
		if (deleted < BATCH) return total;
	}
}

/** Prunes every Site's history as of `now`. */
export async function pruneHistory(
	database: Database,
	now: Date,
): Promise<{ revisions: number; checkpoints: number; orphans: number; documents: number }> {
	const settings = await readHistorySettings(database.db);
	const day = 24 * 60 * 60 * 1000;
	const revisionsBefore = new Date(now.getTime() - settings.revisionDays * day);
	const checkpointsBefore = new Date(now.getTime() - settings.checkpointDays * day);
	const revisions = await inBatches(
		database,
		() => sql`
			delete from revisions where id in (
				select id from (
					select id, published_at, row_number() over (
						partition by site_id, item_kind, item_id order by published_at desc, id desc
					) as place
					from revisions
				) ranked
				where ranked.place > ${settings.revisionsKept} and ranked.published_at < ${revisionsBefore}
				limit ${BATCH}
			)`,
	);
	const checkpoints = await inBatches(
		database,
		() => sql`
			delete from checkpoints where id in (
				select id from checkpoints where taken_at < ${checkpointsBefore} limit ${BATCH}
			)`,
	);
	let orphans = 0;
	for (const table of ["revisions", "checkpoints"] as const) {
		for (const [kind, items] of Object.entries(ITEM_TABLES)) {
			orphans += await inBatches(
				database,
				() => sql`
					delete from ${sql.identifier(table)} where id in (
						select history.id from ${sql.identifier(table)} history
						where history.item_kind = ${kind}
							and not exists (select 1 from ${sql.identifier(items)} item where item.id = history.item_id)
						limit ${BATCH}
					)`,
			);
		}
	}
	for (const [kind, items] of Object.entries(ITEM_TABLES)) {
		orphans += await inBatches(
			database,
			() => sql`
				delete from draft_changes where ctid in (
					select changes.ctid from draft_changes changes
					where changes.item_kind = ${kind}
						and not exists (select 1 from ${sql.identifier(items)} item where item.id = changes.item_id)
					limit ${BATCH}
				)`,
		);
	}
	const documentsBefore = new Date(now.getTime() - DOCUMENT_KEPT_DAYS * day);
	let documents = await inBatches(
		database,
		() => sql`
			delete from draft_documents where id in (
				select id from draft_documents where used_at < ${documentsBefore} limit ${BATCH}
			)`,
	);
	for (const [kind, items] of Object.entries(ITEM_TABLES)) {
		documents += await inBatches(
			database,
			() => sql`
				delete from draft_documents where id in (
					select document.id from draft_documents document
					where document.item_kind = ${kind}
						and not exists (select 1 from ${sql.identifier(items)} item where item.id = document.item_id)
					limit ${BATCH}
				)`,
		);
	}
	return { revisions, checkpoints, orphans, documents };
}

/** Prunes every Site's Revisions and Checkpoints past the Install's retention, and the history of deleted items. */
export const historyPrune = defineJob({
	name: "history.prune",
	payload: z.object({}),
	async run(_payload, { database, clock, log }) {
		const pruned = await pruneHistory(database, clock.now());
		log.info("Pruned Revisions and Checkpoints past their retention", pruned);
	},
});

/** The prune runs every day at 03:47 UTC. */
export const historyPruneSchedule = defineSchedule({ job: historyPrune, cron: "47 3 * * *", payload: {} });
