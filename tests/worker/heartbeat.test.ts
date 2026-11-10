// The worker heartbeat (`startWorkerHeartbeat`) records its start time through the Clock port, like
// `createWorkers` does, so it is timed by the test clock rather than the wall clock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, createWorkers, startWorkerHeartbeat } from "@webcraft/core";
import { openDatabase } from "@webcraft/db";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	// Far from the real wall clock, so a `startedAt` taken from `new Date()` instead of the Clock
	// port would not equal it.
	install = await createTestInstall({ now: new Date("2026-03-02T09:00:00.000Z") });
});

afterAll(async () => {
	await install.close();
});

describe("the worker heartbeat", () => {
	test("records its start time from the Clock port, not the wall clock", async () => {
		const database = openDatabase(install.databaseUrl, { maxConnections: 1, applicationName: "webcraft-tests" });
		const workers = createWorkers({ database, clock: install.clock });
		const log = createLogger({ clock: install.clock, write: () => undefined });
		try {
			const startedAt = install.clock.now();
			const heartbeat = await startWorkerHeartbeat(workers, { hostname: "test-worker", log, clock: install.clock });
			try {
				const status = await workers.status();
				expect(status.latest).toMatchObject({ hostname: "test-worker", startedAt });

				// Moving the test clock on doesn't change the recorded start time, only `beatAt`.
				await install.clock.advance(5 * 60_000);
				const after = await workers.status();
				expect(after.latest?.startedAt).toEqual(startedAt);
				expect(after.latest?.beatAt).toEqual(startedAt);
			} finally {
				await heartbeat.stop();
			}
		} finally {
			await database.close();
		}
	});
});
