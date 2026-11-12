// The worker runs on Node, not Bun (ADR 0006). These tests start the real worker process with
// `node` against a test Install's database and check it works the jobs the tests send, including a
// System email it sends through a real SMTP server with the real Mailer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";
import pg from "pg";
import { imageInfo, photo, upload } from "../harness/images.ts";
import { createTestInstall, type LocalSmtpServer, startSmtpServer, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

const WORKER = new URL("../../apps/worker/src/main.ts", import.meta.url).pathname;
/** These tests read the worker's JSON log lines, whatever format the checkout's own `.env` asks for. */
const JSON_LINES = { WEBCRAFT_LOG_FORMAT: "json" };

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
		env: { ...process.env, ...install.env, ...JSON_LINES },
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
		env: { ...process.env, ...install.env, ...JSON_LINES },
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

test("the worker cleans an uploaded photo on Node, then makes its AVIF and WebP widths", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId, { slug: "worker-photos" })).id;
	await goLive(install, siteId);
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 700, height: 400, orientation: 8, camera: true }), "oven.jpg"),
	});

	const worker = Bun.spawn(["node", WORKER], {
		env: { ...process.env, ...install.env, ...JSON_LINES },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const done = await firstLogEntry(worker.stdout, (line) => line.msg === "Made the variants of an image", 45_000);
		// Upright, the photo is 400 pixels wide: only the 320 width fits.
		expect(done).toMatchObject({ job: "media.variants", mediaId: media.id, widths: [320] });

		const { media: ready } = await admin.api.media.get({ siteId, mediaId: media.id });
		expect(ready).toMatchObject({ status: "ready", width: 400, height: 700 });
		expect(ready.variants.map((variant) => `${variant.format} ${variant.width}`)).toEqual(["avif 320", "webp 320"]);
		const served = await install.request(`https://worker-photos.live.test${ready.url}`);
		expect(await imageInfo(new Uint8Array(await served.arrayBuffer()))).toMatchObject({
			width: 400,
			height: 700,
			exif: false,
			camera: false,
		});
	} finally {
		worker.kill("SIGTERM");
	}
	expect(await worker.exited).toBe(0);
}, 60_000);

test("the worker says when the database drops connections it had open: a flapping database shows in the log", async () => {
	const url = `http://127.0.0.1:${pingTarget.port}/before-the-drop`;
	await install.jobs.send(samplePing, { url });
	const worker = Bun.spawn(["node", WORKER], {
		env: { ...process.env, ...install.env, ...JSON_LINES },
		stdout: "pipe",
		stderr: "pipe",
	});
	const lines: LogLine[] = [];
	const reading = (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of worker.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			const whole = buffered.split("\n");
			buffered = whole.pop() ?? "";
			for (const line of whole) {
				const parsed = parseJson(line);
				if (parsed) lines.push(parsed);
			}
		}
	})();
	const admin = new pg.Client({ connectionString: install.databaseUrl });
	await admin.connect();
	try {
		// It has worked a job, so it holds connections open.
		await eventually(async () => lines.find((line) => line.msg === "Pinged a URL"));

		// The database server ends them, as a restart or a failover does.
		await admin.query(
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'webcraft-worker'",
		);

		const said = await eventually(async () =>
			lines.find((line) => String(line.msg).startsWith("The database dropped a connection")),
		);
		expect(said).toMatchObject({ level: "warn", process: "worker" });
	} finally {
		await admin.end();
		worker.kill("SIGTERM");
	}
	await worker.exited;
	await reading;
}, 60_000);

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

test("on a database fresh from the migrate step, with no job queue made yet, the worker starts and works", async () => {
	const fresh = await createTestInstall({ database: "empty" });
	try {
		await fresh.migrate();
		const worker = Bun.spawn(["node", WORKER], {
			env: { ...process.env, ...fresh.env, ...JSON_LINES },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const entry = await firstLogEntry(
				worker.stdout,
				(line) => line.msg === "The worker is working the job queue" || line.level === "error",
				20_000,
			);

			expect(entry).toMatchObject({ level: "info", msg: "The worker is working the job queue" });
		} finally {
			worker.kill("SIGTERM");
		}
		expect(await worker.exited).toBe(0);
	} finally {
		await fresh.close();
	}
});
