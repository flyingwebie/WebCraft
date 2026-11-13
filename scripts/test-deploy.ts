// The deploy smoke test (`bun run test:deploy`, not part of `bun run test`): builds the web and worker
// images from this checkout, brings up deploy/compose/docker-compose.yml under a Compose project of its
// own (its own containers, network and volumes, on free ports of 127.0.0.1), and checks what an agency
// would see on a new server: the migrate step finishes, Caddy gets a certificate for the admin host on
// demand (from Caddy's own local authority, as there is no public DNS here) and `/readyz` answers
// through it; plain HTTP goes on to HTTPS except domain verification; an unknown hostname gets no
// certificate; the admin renders; the web log prints the setup link; the worker works and its Chromium
// prints a Report's PDF; the `webcraft`
// command runs in the web container, and its health checks find the web process and the worker;
// `webcraft admin backup` writes into the Backups volume, which the
// worker shares; and, with web and worker stopped, `webcraft admin restore` puts that Backup back and
// the Install comes up again. It removes its project (and only its project) when it ends.
//
//   bun run test:deploy                 build the images, then test
//   bun run test:deploy --no-build      test images already built (WEBCRAFT_IMAGE, WEBCRAFT_VERSION)
//   bun run test:deploy --keep          leave the stack running afterwards, to look around
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const COMPOSE_FILE = join(ROOT, "deploy/compose/docker-compose.yml");
const ADMIN_HOST = "admin.webcraft-smoke.test";
const READY_WITHIN_MS = 5 * 60_000;

const args = new Set(process.argv.slice(2));
const build = !args.has("--no-build");
const keep = args.has("--keep");
// The images to test with --no-build (the CI job builds them first).
const { WEBCRAFT_IMAGE, WEBCRAFT_VERSION } = process.env;
const image = WEBCRAFT_IMAGE ?? "webcraft-smoke";
const version = WEBCRAFT_VERSION ?? "test";
const project = `webcraft-smoke-${process.pid}-${Date.now().toString(36)}`;

type Run = { code: number; stdout: string; stderr: string };

/**
 * The environment commands run with: this process's, without the Install's settings. Bun loads the
 * checkout's `.env` into this process, and Compose would prefer those values to the stack's own file.
 */
const CLEAN_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !/^(WEBCRAFT_|POSTGRES_|DATABASE_URL$|PORT$)/.test(name)),
);

async function run(command: string[], options: { env?: Record<string, string>; quiet?: boolean } = {}): Promise<Run> {
	const child = Bun.spawn(command, {
		cwd: ROOT,
		env: { ...CLEAN_ENV, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0 && !options.quiet) {
		throw new Error(`${command.join(" ")} exited with ${code}:\n${stderr || stdout}`);
	}
	return { code, stdout, stderr };
}

/** A port nothing on 127.0.0.1 listens on right now. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")),
			);
		});
	});
}

function randomHex(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

const checks: string[] = [];
function pass(what: string): void {
	checks.push(what);
	console.log(`  ✓ ${what}`);
}
function expect(condition: unknown, what: string, detail = ""): void {
	if (!condition) throw new Error(`${what}${detail ? `\n${detail}` : ""}`);
	pass(what);
}

const httpPort = await freePort();
const httpsPort = await freePort();
const directory = mkdtempSync(join(tmpdir(), "webcraft-smoke-"));
const envFile = join(directory, ".env");
writeFileSync(
	envFile,
	[
		`WEBCRAFT_VERSION=${version}`,
		`WEBCRAFT_IMAGE=${image}`,
		`WEBCRAFT_ADMIN_HOST=${ADMIN_HOST}`,
		"WEBCRAFT_SITES_DOMAIN=sites.webcraft-smoke.test",
		`WEBCRAFT_SECRET_KEY=${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`,
		`POSTGRES_PASSWORD=${randomHex(32)}`,
		// No public DNS here: Caddy's own certificate authority instead of a public one.
		"WEBCRAFT_CADDY_OPTIONS=local_certs",
		`WEBCRAFT_HTTP_PORT=127.0.0.1:${httpPort}`,
		`WEBCRAFT_HTTPS_PORT=127.0.0.1:${httpsPort}`,
		"",
	].join("\n"),
);
const compose = ["docker", "compose", "-f", COMPOSE_FILE, "--env-file", envFile, "-p", project];

/** `curl` against Caddy on this machine, with `name` resolving to it. */
async function curl(url: string, extra: string[] = []): Promise<Run & { status: number; body: string }> {
	const port = url.startsWith("https:") ? httpsPort : httpPort;
	const name = new URL(url).hostname;
	const marker = "\n__status__:";
	const result = await run(
		[
			"curl",
			"--silent",
			"--show-error",
			"--insecure",
			"--max-time",
			"20",
			"--resolve",
			`${name}:${port}:127.0.0.1`,
			"--write-out",
			`${marker}%{http_code}`,
			...extra,
			url.replace(`//${name}/`, `//${name}:${port}/`),
		],
		{ quiet: true },
	);
	const at = result.stdout.lastIndexOf(marker);
	return {
		...result,
		body: at >= 0 ? result.stdout.slice(0, at) : result.stdout,
		status: at >= 0 ? Number(result.stdout.slice(at + marker.length)) : 0,
	};
}

async function migrateFailed(): Promise<boolean> {
	const { stdout } = await run([...compose, "ps", "--all", "--format", "json", "migrate"], { quiet: true });
	return stdout
		.split("\n")
		.filter(Boolean)
		.some((line) => {
			const container = JSON.parse(line) as { State?: string; ExitCode?: number };
			return container.State === "exited" && container.ExitCode !== 0;
		});
}

let failed = false;
try {
	if (build) {
		console.log("Building the images…");
		await run(["docker", "build", "-f", "apps/server/Dockerfile", "-t", `${image}-web:${version}`, "."]);
		await run(["docker", "build", "-f", "apps/worker/Dockerfile", "-t", `${image}-worker:${version}`, "."]);
	}
	console.log(`Starting Compose project ${project} (HTTP on ${httpPort}, HTTPS on ${httpsPort})…`);
	// "missing": the web and worker images are this commit's, built above or by the CI job, so they are
	// never pulled; Postgres and Caddy are fetched when the machine (a fresh CI runner) doesn't have them.
	await run([...compose, "up", "--detach", "--no-build", "--pull", "missing"], { quiet: true }).then((started) => {
		if (started.code !== 0) throw new Error(`docker compose up failed:\n${started.stderr}`);
	});

	const deadline = Date.now() + READY_WITHIN_MS;
	let ready = await curl(`https://${ADMIN_HOST}/readyz`);
	while (ready.status !== 200 && Date.now() < deadline) {
		if (await migrateFailed()) throw new Error("The migrate step failed.");
		await Bun.sleep(2000);
		ready = await curl(`https://${ADMIN_HOST}/readyz`);
	}
	expect(
		ready.status === 200 && JSON.parse(ready.body).status === "ready",
		"/readyz answers 200 through Caddy, over HTTPS with an on-demand certificate for the admin host",
		`${ready.status} ${ready.body} ${ready.stderr}`,
	);

	const { stdout: migrateLog } = await run([...compose, "logs", "--no-color", "migrate"]);
	expect(
		// The deploy files set WEBCRAFT_LOG_FORMAT=json, so the step reports in one JSON line; the readable
		// report is what it writes without it.
		/"msg":"The migrate step finished"|Applied \d+ migrations?|No migrations were pending/.test(migrateLog),
		"the migrate step ran and finished",
		migrateLog,
	);

	const health = await run(["docker", "inspect", "--format", "{{.State.Health.Status}}", `${project}-web-1`]);
	expect(health.stdout.trim() === "healthy", "the web container's own health check passes", health.stdout);

	const plain = await curl(`http://${ADMIN_HOST}/readyz`);
	expect(plain.status === 308, "plain HTTP goes on to HTTPS", `${plain.status} ${plain.body}`);

	const verify = await curl("http://new-domain.example/_webcraft/verify/not-a-token");
	expect(
		verify.status === 404 && verify.body === "Not Found",
		"domain verification is answered by the web process over plain HTTP, not redirected",
		`${verify.status} ${verify.body}`,
	);

	const stranger = await curl("https://not-a-site.example/");
	expect(
		stranger.status === 0 && stranger.code !== 0,
		"a hostname that isn't the Install's gets no certificate",
		`${stranger.status} ${stranger.stderr}`,
	);

	const admin = await curl(`https://${ADMIN_HOST}/`, ["--location"]);
	expect(
		admin.status === 200 && /<html/i.test(admin.body),
		"the admin renders",
		`${admin.status} ${admin.body.slice(0, 300)}`,
	);

	const { stdout: webLog } = await run([...compose, "logs", "--no-color", "web"]);
	expect(
		webLog.includes("setupUrl"),
		"the web log prints the setup link for the first Superadmin",
		webLog.slice(-2000),
	);

	const { stdout: workerLog } = await run([...compose, "logs", "--no-color", "worker"]);
	expect(
		workerLog.includes("The worker is working the job queue"),
		"the worker works the job queue",
		workerLog.slice(-2000),
	);

	// Reports' PDFs: the worker's own Chromium prints a page, with its own renderer.
	const printed = await run(
		[
			...compose,
			"exec",
			"-T",
			"worker",
			"node",
			"--input-type=module",
			"-e",
			[
				'const { createChromiumPdf } = await import("/app/apps/worker/src/pdf.ts");',
				'const pdf = await createChromiumPdf().render("<!doctype html><html><head><title>Smoke</title></head><body><p>Smoke test</p></body></html>");',
				'console.log(Buffer.from(pdf.subarray(0, 5)).toString("latin1"), pdf.byteLength);',
			].join(" "),
		],
		{ quiet: true },
	);
	expect(
		printed.code === 0 && printed.stdout.startsWith("%PDF-"),
		"the worker's Chromium prints a Report's PDF",
		`${printed.stdout}${printed.stderr}`.slice(-2000),
	);

	const cli = await run([...compose, "exec", "-T", "web", "webcraft", "admin", "migrate"]);
	expect(
		/No migrations were pending|"msg":"The migrate step finished".*"appliedMigrations":\[\]/.test(cli.stdout),
		"the webcraft command runs in the web container",
		cli.stdout,
	);

	const webHealth = await run([...compose, "exec", "-T", "web", "webcraft", "admin", "health"]);
	expect(webHealth.code === 0, "`webcraft admin health` finds the web process ready", webHealth.stdout);
	const workerHealth = await run([...compose, "exec", "-T", "web", "webcraft", "admin", "health", "--worker"]);
	expect(workerHealth.code === 0, "`webcraft admin health --worker` finds the worker checked in", workerHealth.stdout);

	const backup = await run([...compose, "exec", "-T", "web", "webcraft", "admin", "backup"]);
	const archive = /Took a Backup: (\/var\/lib\/webcraft\/backups\/webcraft-backup-[^\s]+\.tar)/.exec(
		backup.stdout,
	)?.[1];
	expect(archive, "`webcraft admin backup` writes an archive into the Backups volume", backup.stdout);
	const listed = await run([...compose, "exec", "-T", "worker", "ls", "/var/lib/webcraft/backups"]);
	expect(
		listed.stdout.includes(archive?.split("/").at(-1) ?? "-"),
		"the worker sees the same Backups folder",
		listed.stdout,
	);

	await run([...compose, "stop", "web", "worker"]);
	const restore = await run(
		[
			...compose,
			"run",
			"--rm",
			"--no-deps",
			"web",
			"webcraft",
			"admin",
			"restore",
			archive ?? "",
			"--force",
			"--confirm",
			"webcraft",
		],
		{ quiet: true },
	);
	expect(
		restore.code === 0 && restore.stdout.includes("Start web and worker."),
		"`webcraft admin restore --force` puts the Backup back into the database",
		`${restore.stdout}${restore.stderr}`,
	);
	await run([...compose, "start", "web", "worker"]);
	const restartDeadline = Date.now() + READY_WITHIN_MS;
	let again = await curl(`https://${ADMIN_HOST}/readyz`);
	while (again.status !== 200 && Date.now() < restartDeadline) {
		await Bun.sleep(2000);
		again = await curl(`https://${ADMIN_HOST}/readyz`);
	}
	expect(again.status === 200, "the restored Install is ready again", `${again.status} ${again.body}`);

	console.log(`\nThe Compose stack passed ${checks.length} checks.`);
} catch (error) {
	failed = true;
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
	const logs = await run([...compose, "logs", "--no-color", "--tail", "80"], { quiet: true });
	console.error(`\nThe stack's logs:\n${logs.stdout}${logs.stderr}`);
} finally {
	if (keep) {
		console.log(`\nLeft running. Remove it with:\n  ${compose.join(" ")} down --volumes`);
	} else {
		// Only this project's containers, network and volumes.
		await run([...compose, "down", "--volumes", "--remove-orphans", "--timeout", "10"], { quiet: true });
	}
}
process.exit(failed ? 1 : 0);
