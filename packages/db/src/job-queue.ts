import { type ConstructorOptions, PgBoss } from "pg-boss";
import pgBossPackage from "pg-boss/package.json" with { type: "json" };

/** The Postgres schema that holds the job queue's tables. */
export const JOB_QUEUE_SCHEMA = "pgboss";

/** The job queue schema version this build of WebCraft expects. */
export const JOB_QUEUE_SCHEMA_VERSION: number = pgBossPackage.pgboss.schema;

export type JobQueueOptions = Omit<ConstructorOptions, "connectionString" | "schema" | "migrate">;

/**
 * Creates a pg-boss instance on the Install's database. It never changes the schema: the
 * `migrate` step installs and upgrades it (ADR 0031), and `start()` fails on an old one.
 */
export function createBoss(databaseUrl: string, options: JobQueueOptions = {}): PgBoss {
	return new PgBoss({
		connectionString: databaseUrl,
		schema: JOB_QUEUE_SCHEMA,
		...options,
		migrate: false,
	});
}
