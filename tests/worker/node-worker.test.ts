// The worker runs on Node, not Bun (ADR 0006). These tests start the real worker process with
// `node` against a test Install's database and check it works the jobs the tests send, including a
// System email it sends through a real SMTP server with the real Mailer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";

import { createTestInstall, type LocalSmtpServer, startSmtpServer, type TestInstall } from "../harness/index.ts";

const WORKER = new URL("../../apps/worker/src/main.ts", import.meta.url).pathname;

let install: TestInstall;
let pingTarget: ReturnType<typeof Bun.serve>;
let smtpServer: LocalSmtpServer;

beforeAll(async () => {
	install = await createTestInstall();
	pingTarget = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
	smtpServer = await startSmtpServer({ username: "mailer", password: "the smtp password" });
});

afterAll(async () => {
	await pingTarget.stop(true);
	await smtpServer.close();
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

test("the worker sends a queued System email through the Install SMTP, signing in with the stored password", async () => {
	const superadmin = await install.createSuperadmin();
	const browser = await install.signIn(superadmin);
	await browser.api.install.smtp.update({
		host: smtpServer.host,
		port: smtpServer.port,
		security: "none",
		username: "mailer",
		password: "the smtp password",
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
	const [queued] = await install.sendSystemEmail({
		type: "staff-invite",
		to: { email: "new.colleague@agency.example", language: "en" },
		data: { inviterName: "Sam Superadmin", acceptPath: "/invites/abc", expiresInDays: 7 },
	});
	expect(queued?.status).toBe("queued");

	const worker = Bun.spawn(["node", WORKER], {
		env: { ...process.env, ...install.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	// Read what the worker writes, or its next write could block on a full pipe.
	const output = firstLogEntry(worker.stdout, () => false, 30_000).catch(() => undefined);
	try {
		const email = await smtpServer.firstEmail();

		expect(email.from).toBe("noreply@agency.example");
		expect(email.to).toEqual(["new.colleague@agency.example"]);
		expect(email.message).toContain("Subject: Sam Superadmin invited you to WebCraft");
		expect(email.message).toContain("Auto-Submitted: auto-generated");
		expect(email.message).toContain("Accept the invite: https://admin.test/invites/abc");

		// The worker records the server's answer just after the server takes the email.
		const sent = await eventually(async () => {
			const [line] = (await browser.api.install.emailLog.list({})).lines;
			return line?.status === "sent" ? line : undefined;
		});
		expect(sent).toMatchObject({ attempts: 1, lastResponse: expect.stringMatching(/^250 /) });
	} finally {
		worker.kill("SIGTERM");
	}
	expect(await worker.exited).toBe(0);
	await output;
});

/** Asks `check` again every 100 ms until it answers something, for at most 10 seconds. */
async function eventually<Value>(check: () => Promise<Value | undefined>): Promise<Value> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await check();
		if (value !== undefined) return value;
		await Bun.sleep(100);
	}
	throw new Error("It didn't happen within 10 seconds.");
}

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
