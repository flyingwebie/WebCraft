// The worker runs on Node, not Bun (ADR 0006). This test starts the real worker process with
// `node` against a test Install's database and checks it works a job the test sends.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const WORKER = new URL("../../apps/worker/src/main.ts", import.meta.url).pathname;

let install: TestInstall;
let pingTarget: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
	install = await createTestInstall();
	pingTarget = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
});

afterAll(async () => {
	await pingTarget.stop(true);
	await install.close();
});

test("the worker process runs on Node and works the sample job", async () => {
	const url = `http://127.0.0.1:${pingTarget.port}/ping`;
	await install.jobs.send(samplePing, { url });

	const worker = Bun.spawn(["node", WORKER], {
		env: { ...process.env, ...install.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const entry = await firstLogEntry(worker.stdout, (line) => line.msg === "Pinged a URL", 20_000);

		expect(entry).toMatchObject({ level: "info", job: "sample.ping", url, status: 200 });
	} finally {
		worker.kill("SIGTERM");
	}
	expect(await worker.exited).toBe(0);
});

type LogLine = Record<string, unknown>;

/**
 * Waits for the first JSON log line on `stream` that matches, or fails after `timeoutMs`. It keeps
 * reading to the end either way: a pipe nobody reads makes the worker's next write fail.
 */
function firstLogEntry(
	stream: ReadableStream<Uint8Array>,
	matches: (line: LogLine) => boolean,
	timeoutMs: number,
): Promise<LogLine> {
	const seen: string[] = [];
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`No matching log line in ${timeoutMs} ms. Saw:\n${seen.join("\n")}`)),
			timeoutMs,
		);
		(async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of stream) {
				buffered += decoder.decode(chunk, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					seen.push(line);
					const parsed = parseJson(line);
					if (parsed && matches(parsed)) {
						clearTimeout(timer);
						resolve(parsed);
					}
				}
			}
			clearTimeout(timer);
			reject(new Error(`The worker exited without a matching log line. Saw:\n${seen.join("\n")}`));
		})().catch(reject);
	});
}

function parseJson(line: string): LogLine | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null ? (value as LogLine) : undefined;
	} catch {
		return undefined;
	}
}
