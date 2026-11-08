import type { Clock } from "@webcraft/core";
import { TestClock } from "pg-boss";

/**
 * The test Install's clock. Time stands still until a test moves it, and the job queue reads the
 * same time inside Postgres, so a job sent to start in an hour runs only once the clock has
 * moved an hour on.
 */
export type TestInstallClock = Clock & {
	/** Jumps to `time`, forwards or backwards. */
	set(time: Date): Promise<void>;
	/** Moves time forward by `milliseconds`. */
	advance(milliseconds: number): Promise<void>;
};

export function createTestClock(start: Date): { clock: TestInstallClock; jobQueueClock: TestClock } {
	const jobQueueClock = new TestClock(start);
	return {
		jobQueueClock,
		clock: {
			now: () => new Date(jobQueueClock.now()),
			set: (time) => jobQueueClock.setTime(time),
			// Jumps as if the process had slept: every timer the jump passes fires once, instead of an
			// interval replaying each period it skipped, so moving days ahead takes no longer than a
			// minute. Jobs still run by the database's time, which moves the same way.
			advance: async (milliseconds) => {
				await jobQueueClock.setTime(jobQueueClock.now() + milliseconds);
				await jobQueueClock.tick(0);
			},
		},
	};
}
