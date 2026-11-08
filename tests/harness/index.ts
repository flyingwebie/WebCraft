import { createServer } from "node:net";
import {
	coreJobs,
	createJobQueue,
	createLogger,
	createSecrets,
	ensureQueues,
	type InstallServices,
	type JobQueue,
	type LogEntry,
	MASTER_KEY_VARIABLE,
	openSecrets,
	parseMasterKey,
	runJob,
	type Secrets,
} from "@webcraft/core";
import { createBoss, openDatabase } from "@webcraft/db";
import { createWebHandler } from "@webcraft/server/handler";
import type { PgBoss } from "pg-boss";

import { createTestClock, type TestInstallClock } from "./clock.ts";
import { createEmptyDatabase, createMigratedDatabase, type TestDatabase } from "./database.ts";
import { createFakeHttp, type FakeHttp } from "./fake-http.ts";
import { createFakeMailer, type FakeMailer } from "./fake-mailer.ts";

export type { TestInstallClock } from "./clock.ts";
export type { FakeHttp, RecordedRequest } from "./fake-http.ts";
export type { FakeMailer } from "./fake-mailer.ts";

/** The admin host of every test Install. `.test` is reserved, so it can never be a real Site. */
export const TEST_ADMIN_HOST = "admin.test";

/**
 * The Master key of every test Install unless a test chooses another. Tests never use the key in
 * `.env`, so they behave the same on every machine.
 */
export const TEST_MASTER_KEY = "test-master-key-0123456789abcdefghijklmnop";

/** Where a test Install's clock starts unless a test says otherwise: a Monday morning. */
export const DEFAULT_TEST_TIME = new Date("2026-03-02T09:00:00.000Z");

export type TestInstallOptions = {
	/**
	 * - `migrated` (default): a fresh database with every real migration applied.
	 * - `empty`: a fresh database nobody has migrated yet.
	 * - `unreachable`: a connection string where no Postgres server answers.
	 */
	database?: "migrated" | "empty" | "unreachable";
	/** Where the clock starts. */
	now?: Date;
	/** The Master key the Install starts with (`WEBCRAFT_SECRET_KEY`); `TEST_MASTER_KEY` unless given. */
	masterKey?: string;
};

/** One job the drain ran. */
export type JobRun = {
	name: string;
	data: unknown;
	/** Why it failed; absent when it completed. */
	error?: Error;
};

export type DrainReport = {
	completed: JobRun[];
	failed: JobRun[];
};

/** A running Install inside the test process, with fakes at its edges. */
export type TestInstall = {
	/** The admin hostname, `admin.test`. */
	adminHost: string;
	/** The Install's database, for tests that start a real process (such as the worker) against it. */
	databaseUrl: string;
	/**
	 * The environment a real process (the worker, the CLI) needs to run as this Install:
	 * `DATABASE_URL`, `WEBCRAFT_ADMIN_HOST` and `WEBCRAFT_SECRET_KEY`.
	 */
	readonly env: Record<string, string>;
	/** A URL on the admin host, such as `adminUrl("/healthz")`. */
	adminUrl(path: string): string;
	/** Sends a standard Request through the web process's handler, in process, without a port. */
	request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	/** The job queue the Install uses, to enqueue a job the way the web process would. */
	jobs: JobQueue;
	/** Runs every job that is due by the test clock, including the jobs those jobs enqueue. */
	drainJobs(): Promise<DrainReport>;
	/** The Install's secrets, encrypted under its Master key: set, use and describe them. */
	readonly secrets: Secrets;
	/** Every email the Install sent. */
	mail: FakeMailer;
	/** The Install's outgoing HTTP: prepare answers, read what was requested. */
	http: FakeHttp;
	clock: TestInstallClock;
	/** Every log entry the Install wrote. */
	logs: LogEntry[];
	/**
	 * Starts the Install again with another Master key, as web and worker do after their
	 * `WEBCRAFT_SECRET_KEY` changes, running the same start-up check. When the check refuses the key,
	 * this rejects with the same error and the Install keeps running as before.
	 */
	restart(options: { masterKey: string }): Promise<void>;
	/** Stops the Install and drops its database. */
	close(): Promise<void>;
};

/**
 * Boots an Install in the test process: its own fresh database (migrated with the real
 * migrations by default), the web handler, the job queue, and fakes for mail, outgoing HTTP and
 * the clock. Call it in `beforeAll` and `close()` it in `afterAll`.
 */
export async function createTestInstall(options: TestInstallOptions = {}): Promise<TestInstall> {
	const mode = options.database ?? "migrated";
	const testDatabase = await openTestDatabase(mode);
	const databaseUrl = testDatabase?.url ?? (await unreachableDatabaseUrl());

	const { clock, jobQueueClock } = createTestClock(options.now ?? DEFAULT_TEST_TIME);
	const logs: LogEntry[] = [];
	const log = createLogger({ clock, write: (entry) => logs.push(entry) });
	const database = openDatabase(databaseUrl, { maxConnections: 4, applicationName: "webcraft-tests" });

	let boss: PgBoss | undefined;
	if (mode === "migrated") {
		boss = createBoss(databaseUrl, {
			clock: jobQueueClock,
			supervise: false,
			schedule: false,
			registerInstance: false,
			max: 2,
			application_name: "webcraft-tests",
		});
		boss.on("error", (error) => log.error("The job queue reported an error", { error }));
		await boss.start();
		await ensureQueues(boss, coreJobs);
	}

	const mail = createFakeMailer();
	const http = createFakeHttp();
	const env = {
		DATABASE_URL: databaseUrl,
		WEBCRAFT_ADMIN_HOST: TEST_ADMIN_HOST,
		[MASTER_KEY_VARIABLE]: options.masterKey ?? TEST_MASTER_KEY,
	};
	/** Web and worker open secrets with their start-up check; they never start on a database that is behind. */
	const startSecrets = (masterKey: string) => {
		const options = { database, masterKey: parseMasterKey(masterKey, MASTER_KEY_VARIABLE), clock };
		return mode === "migrated" ? openSecrets(options) : Promise.resolve(createSecrets(options));
	};
	const services: InstallServices = {
		config: { databaseUrl, adminHost: TEST_ADMIN_HOST },
		database,
		jobs: boss ? createJobQueue(boss) : withoutJobQueue(mode),
		mailer: mail,
		secrets: await startSecrets(env[MASTER_KEY_VARIABLE]),
		http: http.fetch,
		clock,
		log,
	};
	const handle = createWebHandler({ services });

	return {
		adminHost: TEST_ADMIN_HOST,
		databaseUrl,
		env,
		adminUrl: (path) => new URL(path, `https://${TEST_ADMIN_HOST}`).toString(),
		request: (input, init) =>
			handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
		jobs: services.jobs,
		drainJobs: () => {
			if (!boss) throw new Error(`An Install with an ${mode} database has no job queue to drain.`);
			return drainJobs(boss, services);
		},
		get secrets() {
			return services.secrets;
		},
		mail,
		http,
		clock,
		logs,
		async restart({ masterKey }) {
			services.secrets = await startSecrets(masterKey);
			env[MASTER_KEY_VARIABLE] = masterKey;
		},
		async close() {
			await boss?.stop({ graceful: false, close: true });
			await database.close();
			await testDatabase?.drop();
		},
	};
}

/** Every round fetches each queue until a round finds nothing due; this stops a job loop. */
const MAX_DRAIN_ROUNDS = 100;

async function drainJobs(boss: PgBoss, services: InstallServices): Promise<DrainReport> {
	const report: DrainReport = { completed: [], failed: [] };
	for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
		let ran = 0;
		for (const job of coreJobs) {
			for (const item of await boss.fetch(job.name, { batchSize: 100 })) {
				ran++;
				try {
					await runJob(job, item.data, services);
					await boss.complete(job.name, item.id);
					report.completed.push({ name: job.name, data: item.data });
				} catch (cause) {
					const error = cause instanceof Error ? cause : new Error(String(cause));
					await boss.fail(job.name, item.id, { name: error.name, message: error.message });
					report.failed.push({ name: job.name, data: item.data, error });
				}
			}
		}
		if (ran === 0) return report;
	}
	throw new Error(`drainJobs stopped after ${MAX_DRAIN_ROUNDS} rounds: jobs keep enqueueing more jobs.`);
}

function openTestDatabase(mode: TestInstallOptions["database"]): Promise<TestDatabase | undefined> {
	switch (mode) {
		case "empty":
			return createEmptyDatabase();
		case "unreachable":
			return Promise.resolve(undefined);
		default:
			return createMigratedDatabase();
	}
}

function withoutJobQueue(mode: string): JobQueue {
	return {
		send: () => Promise.reject(new Error(`An Install with an ${mode} database has no job queue.`)),
	};
}

/** A connection string for a local port nothing listens on. */
async function unreachableDatabaseUrl(): Promise<string> {
	const port = await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
		});
	});
	return `postgres://webcraft:unused@127.0.0.1:${port}/unreachable`;
}
