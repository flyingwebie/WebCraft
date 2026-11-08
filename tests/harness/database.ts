import { randomBytes } from "node:crypto";
import { runMigrations } from "@webcraft/db";
import pg from "pg";

/**
 * Test databases. Every name starts with the database name in DATABASE_URL plus `_test_`, then a
 * run id that holds the start time, so parallel runs (other worktrees, CI jobs) on one Postgres
 * server never collide, and leftovers of killed runs can be recognised by age and dropped.
 *
 *   wc_t48_test_<run id>_tpl   migrated once per run, never connected to after that
 *   wc_t48_test_<run id>_<n>   one copy of the template per test Install
 */

/** Runs older than this are certainly over; their databases are leftovers of a killed run. */
const LEFTOVER_AGE_MS = 6 * 60 * 60 * 1000;

/** Postgres names are at most 63 bytes; leave room for `_test_<run id>_<n>`. */
const MAX_BASE_LENGTH = 32;

export type TestDatabase = {
	url: string;
	drop(): Promise<void>;
};

let runId: string | undefined;
let template: Promise<string> | undefined;
let copies = 0;

/** A fresh database that has had every real migration: a copy of this run's template. */
export async function createMigratedDatabase(): Promise<TestDatabase> {
	template ??= createTemplate();
	const templateName = await template;
	const name = `${prefix()}${++copies}`;
	await admin((client) => client.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(templateName)}`));
	return testDatabase(name);
}

/** A fresh database nobody has migrated, as a new Install's database is before `migrate`. */
export async function createEmptyDatabase(): Promise<TestDatabase> {
	const name = `${prefix()}${++copies}`;
	await admin((client) => client.query(`CREATE DATABASE ${quote(name)}`));
	return testDatabase(name);
}

/** Drops this run's template. The harness calls it once all test files have finished. */
export async function dropTemplate(): Promise<void> {
	if (!template) return;
	const name = await template.catch(() => undefined);
	template = undefined;
	if (name) await dropDatabase(name);
}

async function createTemplate(): Promise<string> {
	await dropLeftovers();
	const name = `${prefix()}tpl`;
	await admin((client) => client.query(`CREATE DATABASE ${quote(name)}`));
	try {
		await runMigrations(urlFor(name));
	} catch (error) {
		await dropDatabase(name);
		throw error;
	}
	return name;
}

function testDatabase(name: string): TestDatabase {
	return { url: urlFor(name), drop: () => dropDatabase(name) };
}

async function dropDatabase(name: string): Promise<void> {
	await admin((client) => client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`));
}

/** Drops this base name's test databases left behind by runs that were killed hours ago. */
async function dropLeftovers(): Promise<void> {
	const ours = `${baseName()}_test_`;
	const { rows } = await admin((client) =>
		client.query<{ datname: string }>("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [ours]),
	);
	for (const { datname } of rows) {
		// Only names this harness makes: <start time>_<6 hex digits>_<tpl or a number>.
		const match = /^([0-9a-z]{8,})_[0-9a-f]{6}_(tpl|\d+)$/.exec(datname.slice(ours.length));
		const startedAt = match?.[1] ? Number.parseInt(match[1], 36) : Number.NaN;
		if (Number.isFinite(startedAt) && Date.now() - startedAt > LEFTOVER_AGE_MS) {
			await dropDatabase(datname);
		}
	}
}

/** `<base>_test_<start time in base 36>_<random>_`: the start time lets `dropLeftovers` judge age. */
function prefix(): string {
	runId ??= `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
	return `${baseName()}_test_${runId}_`;
}

function databaseUrl(): URL {
	const value = process.env.DATABASE_URL;
	if (!value) {
		throw new Error(
			"Tests need DATABASE_URL: a Postgres server where they may create and drop databases named after it. See docs/development.md.",
		);
	}
	return new URL(value);
}

function baseName(): string {
	const name = decodeURIComponent(databaseUrl().pathname.slice(1)) || "webcraft";
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_")
		.slice(0, MAX_BASE_LENGTH);
}

function urlFor(name: string): string {
	const url = databaseUrl();
	url.pathname = `/${name}`;
	return url.toString();
}

/** Runs `work` on a connection to the server's maintenance database, `postgres`. */
async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: urlFor("postgres"), application_name: "webcraft-tests" });
	await client.connect();
	try {
		return await work(client);
	} finally {
		await client.end();
	}
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}
