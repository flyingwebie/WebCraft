/**
 * Modules' partitioned tables (SDK 1.4, ADR 0019): a Module keeps rows that pile up (Site analytics'
 * raw events) in a table partitioned by month on a time column. WebCraft makes the partitions, each
 * holding one month (UTC): the current month and the next `MONTHS_AHEAD`, every day, and any month a
 * new row needs at once; and it drops a month once all of it is older than the Install keeps the
 * table's rows (the Module's `keepMonths`, until the Superadmin changes it). Rows go with their whole
 * month, never one by one, so dropping them costs nothing.
 */
import type { Database } from "@webcraft/db";
import { modulePartitionSettings } from "@webcraft/db/schema";
import { type Label, wordsIn } from "@webcraft/module-sdk";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { personIdOf } from "../permissions/can.ts";
import type { InstallScope } from "../tenancy/data-layer.ts";
import type { EnsurePartition } from "./data.ts";
import { ModuleNotFoundError } from "./errors.ts";
import { type CompiledPartitioning, KEEP_MONTHS, type ModuleRegistry, type RunnableModule } from "./registry.ts";
import { writeLine } from "./runtime.ts";

/** How many months after the current one have their partitions made ahead of time. */
export const MONTHS_AHEAD = 2;

/** A partitioned table of a Module's, as the Superadmin sees it on the Modules screen. */
export type PartitionView = { table: string; label: string; keepMonths: number; defaultMonths: number };

export type PartitionKeeper = {
	/** Makes sure the month `at` is in has its partition, before a row goes in. */
	ensure: EnsurePartition;
	/** A Module's partitioned tables, with how long the Install keeps each one's rows. */
	views(module: RunnableModule, language: string): Promise<PartitionView[]>;
	/** Changes how many months the Install keeps a partitioned table's rows (`module.approve`). */
	setKeepMonths(scope: InstallScope, moduleId: string, table: string, months: number): Promise<void>;
	/** Makes the months ahead and drops the months past keeping, for every Module (the daily job). */
	maintain(): Promise<void>;
};

/** A month (UTC) by its first moment. */
function monthOf(at: Date): Date {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

function addMonths(month: Date, months: number): Date {
	return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + months, 1));
}

/** A month's partition's name: the table's, then the year and month, such as `events_2026_03`. */
function partitionName(table: string, month: Date): string {
	return `${table}_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MONTH_SUFFIX = /_(\d{4})_(\d{2})$/;

function ident(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Makes a partitioned table's partitions for the months given (each `<table>_<yyyy>_<mm>`), on a plain
 * connection in its open transaction: a Site import's, whose rows may be in months long past.
 */
export async function makeMonthPartitions(
	client: pg.ClientBase,
	schema: string,
	table: string,
	months: readonly Date[],
): Promise<void> {
	for (const at of months) {
		const month = monthOf(at);
		const name = partitionName(table, month);
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${ident(schema)}.${ident(name)} PARTITION OF ${ident(schema)}.${ident(table)} FOR VALUES FROM ('${month.toISOString()}') TO ('${addMonths(month, 1).toISOString()}')`,
		);
	}
}

/** Postgres errors a partition another process just made answers with: it exists, or it would overlap. */
const RACED = new Set(["42P07", "42P17", "23505"]);

export function createPartitionKeeper(deps: {
	database: Database;
	clock: Clock;
	registry: ModuleRegistry;
}): PartitionKeeper {
	const { database, clock, registry } = deps;
	const { db } = database;
	/** Partitions this process knows exist: `<schema>.<partition>`. */
	const made = new Set<string>();

	const keepMonths = async (module: RunnableModule, partitioning: CompiledPartitioning): Promise<number> => {
		const [row] = await db
			.select({ keepMonths: modulePartitionSettings.keepMonths })
			.from(modulePartitionSettings)
			.where(
				and(eq(modulePartitionSettings.moduleId, module.id), eq(modulePartitionSettings.tableName, partitioning.name)),
			);
		return row?.keepMonths ?? partitioning.keepMonths;
	};

	/** Makes a month's partition unless it exists; answers whether it made it. */
	const make = async (
		executor: Pick<Database["db"], "execute">,
		module: RunnableModule,
		partitioning: CompiledPartitioning,
		month: Date,
	): Promise<boolean> => {
		const name = partitionName(partitioning.name, month);
		const key = `${module.schema}.${name}`;
		if (made.has(key)) return false;
		const found = await executor.execute<{ found: string | null }>(
			sql`SELECT to_regclass(${`${ident(module.schema)}.${ident(name)}`}) AS found`,
		);
		if (found.rows[0]?.found) {
			made.add(key);
			return false;
		}
		const from = month.toISOString();
		const to = addMonths(month, 1).toISOString();
		try {
			await executor.execute(
				sql.raw(
					`CREATE TABLE IF NOT EXISTS ${ident(module.schema)}.${ident(name)} PARTITION OF ${ident(module.schema)}.${ident(partitioning.name)} FOR VALUES FROM ('${from}') TO ('${to}')`,
				),
			);
		} catch (error) {
			if (!RACED.has((error as { code?: string }).code ?? "")) throw error;
			return false;
		}
		made.add(key);
		return true;
	};

	return {
		async ensure(module, partitioning, at, scope) {
			await make(scope.db, module, partitioning, monthOf(at));
		},

		async views(module, language) {
			const views: PartitionView[] = [];
			for (const partitioning of module.partitions) {
				views.push({
					table: partitioning.name,
					label: words(partitioning.label, language, module),
					keepMonths: await keepMonths(module, partitioning),
					defaultMonths: partitioning.keepMonths,
				});
			}
			return views;
		},

		async setKeepMonths(scope, moduleId, table, months) {
			const module = registry.get(moduleId);
			const partitioning = module?.runnable ? module.partitions.find((each) => each.name === table) : undefined;
			if (!module?.runnable || !partitioning) throw new ModuleNotFoundError();
			if (!Number.isInteger(months) || months < KEEP_MONTHS.min || months > KEEP_MONTHS.max) {
				throw new RangeError(`Rows are kept ${KEEP_MONTHS.min} to ${KEEP_MONTHS.max} whole months.`);
			}
			const before = await keepMonths(module, partitioning);
			if (before === months) return;
			const values = { keepMonths: months, changedAt: scope.now(), changedBy: personIdOf(scope.access.actor) };
			await scope.transaction(async (tx) => {
				await tx.db
					.insert(modulePartitionSettings)
					.values({ moduleId, tableName: table, ...values })
					.onConflictDoUpdate({
						target: [modulePartitionSettings.moduleId, modulePartitionSettings.tableName],
						set: values,
					});
				await tx.audit("module.changeKeep", { moduleId, table, from: before, to: months });
			});
		},

		async maintain() {
			const now = clock.now();
			const current = monthOf(now);
			for (const module of registry.all()) {
				if (!module.runnable) continue;
				for (const partitioning of module.partitions) {
					for (let ahead = 0; ahead <= MONTHS_AHEAD; ahead++) {
						const month = addMonths(current, ahead);
						if (await make(db, module, partitioning, month)) {
							await writeLine({ database, clock }, module, null, "info", "Made a month's partition.", {
								table: partitioning.name,
								month: month.toISOString().slice(0, 7),
							});
						}
					}
					const months = await keepMonths(module, partitioning);
					// A month goes once all of it is older than the months kept: its end is that far back.
					const cutoff = new Date(now);
					cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
					const parts = await db.execute<{ name: string }>(
						sql`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
							WHERE i.inhparent = ${`${ident(module.schema)}.${ident(partitioning.name)}`}::regclass`,
					);
					for (const { name } of parts.rows) {
						const match = MONTH_SUFFIX.exec(name);
						if (!match || name !== `${partitioning.name}${match[0]}`) continue;
						const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
						if (addMonths(month, 1).getTime() > cutoff.getTime()) continue;
						await db.execute(sql.raw(`DROP TABLE IF EXISTS ${ident(module.schema)}.${ident(name)}`));
						made.delete(`${module.schema}.${name}`);
						await writeLine({ database, clock }, module, null, "info", "Dropped a month's partition, past keeping.", {
							table: partitioning.name,
							month: month.toISOString().slice(0, 7),
							keepMonths: months,
						});
					}
				}
			}
		},
	};
}

function words(label: Label, language: string, module: RunnableModule): string {
	return wordsIn(label, language, module.manifest.adminLanguages);
}

/** Makes Modules' partitions ahead of time and drops the months past keeping. */
export const modulePartitionsJob = defineJob({
	name: "modules.partitions",
	payload: z.object({}),
	run: (_payload, services): Promise<void> => services.modules.maintainPartitions(),
});

/** Modules' partitions are looked after every day at 02:17 UTC. */
export const modulePartitionsSchedule = defineSchedule({ job: modulePartitionsJob, cron: "17 2 * * *", payload: {} });
