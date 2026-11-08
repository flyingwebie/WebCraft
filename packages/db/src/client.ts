import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { relations } from "./relations.ts";

export type DatabaseOptions = {
	/** Most connections this process keeps open. */
	maxConnections?: number;
	/** Shown in `pg_stat_activity`, such as `webcraft-web`. */
	applicationName?: string;
};

/** A connection pool to the Install's database, with the Drizzle query builder on top. */
export type Database = {
	db: ReturnType<typeof createDrizzle>;
	pool: pg.Pool;
	close(): Promise<void>;
};

/** An open transaction, as `db.transaction()` hands it to its callback. */
export type Transaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

/** Opens a pool to `databaseUrl`. Connections are made on first use, not here. */
export function openDatabase(databaseUrl: string, options: DatabaseOptions = {}): Database {
	const pool = new pg.Pool({
		connectionString: databaseUrl,
		max: options.maxConnections ?? 10,
		application_name: options.applicationName ?? "webcraft",
		connectionTimeoutMillis: 5_000,
	});
	// An idle connection that drops (a restarted server, a network blip) emits an error on the pool;
	// without a listener that error would crash the process. The next query opens a new connection.
	pool.on("error", () => {});
	return {
		db: createDrizzle(pool),
		pool,
		close: () => pool.end(),
	};
}

function createDrizzle(pool: pg.Pool) {
	return drizzle({ client: pool, relations });
}
