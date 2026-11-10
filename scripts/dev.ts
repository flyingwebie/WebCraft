// `bun run dev`: local development in one command. Run it from the repo root, where Bun loads `.env`.
//
// 0. Refuses to go on without the settings web and worker need, including a Master key
//    (WEBCRAFT_SECRET_KEY) of at least 32 characters.
// 1. Makes sure Postgres answers at DATABASE_URL. Only when it doesn't, and DATABASE_URL points at
//    this machine, it starts docker-compose.dev.yml with the same user, password and port.
// 2. Creates the database named in DATABASE_URL if it doesn't exist yet.
// 3. Runs the migrate step (without the Backup it takes first on a server: a development database
//    doesn't need one).
// 4. Starts the web process (`vite dev` on Bun) and the worker (Node, restarting on changes).
import { ConfigError, LogSettingsError, loadInstallConfig, loadMasterKey, logSettings } from "@webcraft/core";
import pg from "pg";

const ROOT = new URL("..", import.meta.url).pathname;
const COMPOSE_FILE = "docker-compose.dev.yml";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Node runs the worker's TypeScript directly from this version on. */
const MIN_NODE = [22, 18];

function fail(message: string): never {
	console.error(`dev: ${message}`);
	process.exit(1);
}

function info(message: string): void {
	console.log(`dev: ${message}`);
}

const env = process.env;
// Web runs in apps/server and the worker in the repo root: one storage folder for both.
env.WEBCRAFT_STORAGE_DIR ||= `${ROOT}storage`;
env.WEBCRAFT_BACKUP_DIR ||= `${ROOT}backups`;
// Readable log lines in a terminal; servers keep JSON, one object per line.
env.WEBCRAFT_LOG_FORMAT ||= "pretty";
if (!env.DATABASE_URL) fail("DATABASE_URL is not set. Copy .env.example to .env (see docs/development.md).");
// The same checks web and worker run when they start, so a bad setting is reported once, here.
try {
	loadInstallConfig(env);
	loadMasterKey(env);
	logSettings(env);
} catch (error) {
	if (error instanceof ConfigError || error instanceof LogSettingsError) fail(`${error.message} Set it in .env.`);
	throw error;
}

const databaseUrl = new URL(env.DATABASE_URL);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
if (!databaseName) fail("DATABASE_URL has no database name.");

await checkNode();
await ensurePostgres();
await ensureDatabase();
await runStep(["bun", "apps/cli/src/main.ts", "admin", "migrate", "--no-backup"]);
await startProcesses();

async function checkNode(): Promise<void> {
	const result = Bun.spawnSync(["node", "--version"]);
	if (!result.success) fail("Node is not installed. The worker runs on Node LTS (see docs/development.md).");
	const [major = 0, minor = 0] = result.stdout.toString().trim().slice(1).split(".").map(Number);
	const [minMajor = 0, minMinor = 0] = MIN_NODE;
	if (major < minMajor || (major === minMajor && minor < minMinor)) {
		fail(`The worker needs Node ${MIN_NODE.join(".")} or later; this machine has ${result.stdout.toString().trim()}.`);
	}
}

/** A connection string for the server's maintenance database, `postgres`. */
function maintenanceUrl(): string {
	const url = new URL(databaseUrl);
	url.pathname = "/postgres";
	return url.toString();
}

async function canConnect(): Promise<boolean> {
	const client = new pg.Client({ connectionString: maintenanceUrl(), connectionTimeoutMillis: 3_000 });
	try {
		await client.connect();
		return true;
	} catch {
		return false;
	} finally {
		await client.end().catch(() => {});
	}
}

async function ensurePostgres(): Promise<void> {
	if (await canConnect()) return;
	const where = `${databaseUrl.hostname}:${databaseUrl.port || "5432"}`;
	if (!LOCAL_HOSTS.has(databaseUrl.hostname)) {
		fail(`Postgres at ${where} doesn't answer. Start it, or point DATABASE_URL at a server you can reach.`);
	}
	info(`Postgres at ${where} doesn't answer; starting it with ${COMPOSE_FILE}.`);
	const compose = Bun.spawnSync(["docker", "compose", "-f", COMPOSE_FILE, "up", "--detach", "--wait"], {
		cwd: ROOT,
		env: {
			...env,
			WEBCRAFT_DEV_POSTGRES_PORT: databaseUrl.port || "5432",
			POSTGRES_USER: decodeURIComponent(databaseUrl.username) || "postgres",
			POSTGRES_PASSWORD: decodeURIComponent(databaseUrl.password),
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	if (!compose.success) fail(`Could not start Postgres with ${COMPOSE_FILE}. Is Docker running?`);
	for (let attempt = 0; attempt < 30; attempt++) {
		if (await canConnect()) return;
		await Bun.sleep(1_000);
	}
	fail(`Postgres started but doesn't accept the user and password in DATABASE_URL.`);
}

async function ensureDatabase(): Promise<void> {
	const client = new pg.Client({ connectionString: maintenanceUrl() });
	await client.connect();
	try {
		const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
		if (found.rowCount === 0) {
			await client.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
			info(`Created the database ${databaseName}.`);
		}
	} finally {
		await client.end();
	}
}

async function runStep(command: string[]): Promise<void> {
	const step = Bun.spawn(command, { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" });
	if ((await step.exited) !== 0) fail(`\`${command.join(" ")}\` failed.`);
}

async function startProcesses(): Promise<void> {
	const port = env.PORT ?? "3000";
	info(`Admin: http://${env.WEBCRAFT_ADMIN_HOST}:${port}/ (every other hostname is a Site)`);
	const children = [
		Bun.spawn(["bun", "--bun", "vite", "dev"], {
			cwd: `${ROOT}apps/server`,
			env: { ...env, PORT: port },
			stdout: "inherit",
			stderr: "inherit",
		}),
		Bun.spawn(["node", "--watch", "apps/worker/src/main.ts"], {
			cwd: ROOT,
			env,
			stdout: "inherit",
			stderr: "inherit",
		}),
	];
	let interrupted = false;
	const stopAll = () => {
		for (const child of children) child.kill("SIGINT");
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			interrupted = true;
			stopAll();
		});
	}
	// When either process ends, stop the other one too.
	const code = await Promise.race(children.map((child) => child.exited));
	stopAll();
	await Promise.all(children.map((child) => child.exited));
	process.exit(interrupted ? 0 : code);
}
