// Bun's `expect(promise)` followed by `.rejects` or `.resolves` waits without running queued
// `setImmediate` callbacks, so a promise that needs one (the test clock settling the job queue,
// pg-pool handing back a connection) waits for some timer to wake the event loop: up to a second
// each time, which once made the suite spend two thirds of its time idle. Tests await first and
// assert on the value: `expect(await rejection(promise))` from `tests/harness/settled.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
// Built from parts, so this file doesn't match itself.
const forbidden = new RegExp(`\\)\\s*\\.(${["re", "jects"].join("")}|${["re", "solves"].join("")})\\.`);

describe("tests await a promise before asserting on it", () => {
	test("no test asserts through expect(promise) with rejects or resolves", () => {
		const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(repoRoot, "tests") })].filter(
			(file) => !file.includes("node_modules"),
		);
		const offenders = files.flatMap((file) =>
			readFileSync(join(repoRoot, "tests", file), "utf8")
				.split("\n")
				.flatMap((line, index) => (forbidden.test(line) ? [`tests/${file}:${index + 1}`] : [])),
		);
		expect(offenders).toEqual([]);
	});
});
