import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AdminLanguageCode,
	type Clock,
	coreJobs,
	coreSchedules,
	countriesFromFile,
	createInstallServices,
	createJobQueue,
	createLogger,
	createSecrets,
	type Edge,
	ensureQueues,
	FIRST_PARTY_MODULES,
	type InstallPorts,
	type InstallServices,
	type JobQueue,
	type LogEntry,
	MASTER_KEY_VARIABLE,
	moduleSchemas,
	type NewMembership,
	parseMasterKey,
	runJob,
	type Secrets,
	type SendResult,
	type SystemEmail,
	type SystemEmailType,
} from "@webcraft/core";
import { createBoss, type MigrationReport, openDatabase, runMigrations } from "@webcraft/db";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import { createWebHandler } from "@webcraft/server/handler";
import { createImageProcessor } from "@webcraft/worker/images";
import type { PgBoss } from "pg-boss";

import { createTestBrowser, fromAddress, type TestBrowser, type TestBrowserOptions } from "./browser.ts";
import { createTestClock, type TestInstallClock } from "./clock.ts";
import { testCountryFile } from "./countries.ts";
import { createEmptyDatabase, createMigratedDatabase, type TestDatabase } from "./database.ts";
import { createFakeDns, type FakeDns } from "./fake-dns.ts";
import { createFakeHttp, type FakeHttp } from "./fake-http.ts";
import { createFakeMailer, type FakeMailer } from "./fake-mailer.ts";
import { createFakeTls, type FakeTls } from "./fake-tls.ts";

export { API_PATH, fromAddress, type TestBrowser, type TestBrowserOptions } from "./browser.ts";
export type { TestInstallClock } from "./clock.ts";
export type { FakeDns } from "./fake-dns.ts";
export type { FakeHttp, RecordedRequest } from "./fake-http.ts";
export { FAKE_SMTP_RESPONSE, type FakeMailer, type SentEmail } from "./fake-mailer.ts";
export { createFakeS3, type FakeS3, type FakeS3Options } from "./fake-s3.ts";
export type { FakeTls } from "./fake-tls.ts";
export { type LocalSmtpServer, type ReceivedEmail, startSmtpServer } from "./smtp-server.ts";

/** The invite link in an invite email: `https://admin.test/invite?token=…`. Throws when there is none. */
export function inviteLinkIn(email: { text: string } | undefined): string {
	const link = email?.text.match(/https:\/\/\S+\/invite\?token=[A-Za-z0-9_-]+/)?.[0];
	if (!link) throw new Error(`The email holds no invite link:\n${email?.text ?? "(no email)"}`);
	return link;
}

/** Requests to the leaked-password range service (see `leakedPasswordCheck` in `@webcraft/auth`). */
export const LEAKED_PASSWORD_RANGE = /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/;

/** The admin host of every test Install. `.test` is reserved, so it can never be a real Site. */
export const TEST_ADMIN_HOST = "admin.test";

/** Where people reach a test Install's admin. */
export const TEST_ADMIN_ORIGIN = `https://${TEST_ADMIN_HOST}`;

/**
 * The Sites domain of every test Install unless a test chooses another (`WEBCRAFT_SITES_DOMAIN`):
 * each Site answers on its Staging address, `https://<site slug>.sites.test`.
 */
export const TEST_SITES_DOMAIN = "sites.test";

/**
 * The Master key of every test Install unless a test chooses another. Tests never use the key in
 * `.env`, so they behave the same on every machine.
 */
export const TEST_MASTER_KEY = "test-master-key-0123456789abcdefghijklmnop";

/**
 * The public addresses of every test Install unless a test chooses others
 * (`WEBCRAFT_PUBLIC_ADDRESSES`): an IPv4 and an IPv6 address from the ranges kept for documentation,
 * so no test can ever reach a real server. The admin host resolves to them too.
 */
export const TEST_INSTALL_ADDRESSES = ["203.0.113.10", "2001:db8::10"] as const;

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
	/** `WEBCRAFT_SITES_DOMAIN`: `TEST_SITES_DOMAIN` unless given; null for an Install without one. */
	sitesDomain?: string | null;
	/** `WEBCRAFT_ADMIN_HOST`: `TEST_ADMIN_HOST` unless given. */
	adminHost?: string;
	/** `WEBCRAFT_EDGE`: `caddy` unless given. */
	edge?: Edge;
	/** `WEBCRAFT_PUBLIC_ADDRESSES`: `TEST_INSTALL_ADDRESSES` unless given. */
	publicAddresses?: readonly string[];
	/**
	 * The Modules the Install loads: this build's first-party Modules unless given, as web and
	 * worker load them. Their migrations must already be in the database: every test database has
	 * had `TEST_MODULES`' (the first-party Modules and the samples).
	 */
	modules?: readonly ModuleDefinition[];
	/** The largest image the worker processes, in pixels: the real limit unless given (to test it without huge files). */
	maxImagePixels?: number;
};

/** A person's account in a test, with the password they sign in with. */
export type TestAccount = {
	name: string;
	email: string;
	password: string;
	adminLanguage: AdminLanguageCode;
};

/** A password every test account can use: long enough for the password rules. */
export const TEST_PASSWORD = "a long enough test password";

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
	/** The domain Staging addresses sit under, `sites.test`, or null when the Install has none. */
	sitesDomain: string | null;
	/** The Install's database, for tests that start a real process (such as the worker) against it. */
	databaseUrl: string;
	/**
	 * The folder the Install keeps files in while its storage is local disk (`WEBCRAFT_STORAGE_DIR`):
	 * a new, empty folder for each test Install, removed by `close()`.
	 */
	storageDir: string;
	/**
	 * The environment a real process (the worker, the CLI) needs to run as this Install:
	 * `DATABASE_URL`, `WEBCRAFT_ADMIN_HOST`, `WEBCRAFT_SECRET_KEY` and `WEBCRAFT_STORAGE_DIR`.
	 */
	readonly env: Record<string, string>;
	/** A URL on the admin host, such as `adminUrl("/healthz")`. */
	adminUrl(path: string): string;
	/** Sends a standard Request through the web process's handler, in process, without a port. */
	request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	/**
	 * A new browser on the admin: it keeps cookies like a browser and calls the Management API the
	 * way the admin does. Each browser comes from its own client address unless `address` says
	 * otherwise (null: one the web process can't tell); `userAgent` is the browser it says it is.
	 * Give `origin` to send requests from another site's pages.
	 */
	browser(options?: TestBrowserOptions): TestBrowser;
	/**
	 * The setup token the web process printed in its log when it last started, or undefined when it
	 * printed none (the Install has a Superadmin).
	 */
	setupToken(): string | undefined;
	/**
	 * Creates the Superadmin without the wizard, as `webcraft admin create-superadmin` does, and
	 * answers the account with its password.
	 */
	createSuperadmin(account?: Partial<TestAccount>): Promise<TestAccount>;
	/** A new browser, signed in with the account's email and password. */
	signIn(account: Pick<TestAccount, "email" | "password">, browser?: TestBrowserOptions): Promise<TestBrowser>;
	/**
	 * A browser signed in as the Superadmin: the one `createSuperadmin` made, or a new default
	 * Superadmin when there is none yet. The same browser every time.
	 */
	superadmin(): Promise<TestBrowser>;
	/** Creates a Workspace as the Superadmin. */
	createWorkspace(name?: string): Promise<{ id: string; name: string }>;
	/** Creates a Site in a Workspace as the Superadmin; the slug is made unique unless given. */
	createSite(workspaceId: string, site?: { name?: string; slug?: string }): Promise<{ id: string; slug: string }>;
	/**
	 * Makes a Member the way people become one: the Superadmin invites them into the Workspace, and
	 * they accept the link in the email with a new account. Answers their account, their id and their
	 * signed-in browser.
	 */
	createMember(options: {
		workspaceId: string;
		role: "owner" | "editor" | "author";
		/** The Sites the Membership reaches; all of them unless given. */
		sites?: "all" | string[];
		name?: string;
		email?: string;
	}): Promise<{ account: TestAccount; personId: string; browser: TestBrowser }>;
	/**
	 * Gives an existing person a Membership directly, as accepting a Member invite does underneath:
	 * for tests of what a Membership may never be (Staff never hold one).
	 */
	addMembership(membership: NewMembership): Promise<void>;
	/**
	 * Makes a Staff member the way people become one: the Superadmin invites them, and they accept
	 * the link in the email. Answers their account, their id and their signed-in browser.
	 */
	createStaff(options: {
		workspaces: "all" | string[];
		name?: string;
		email?: string;
	}): Promise<{ account: TestAccount; personId: string; browser: TestBrowser }>;
	/** The job queue the Install uses, to enqueue a job the way the web process would. */
	jobs: JobQueue;
	/**
	 * Runs every job that is due by the test clock, including the jobs those jobs enqueue, and the
	 * scheduled jobs (such as the daily Email log purge) whose time came since the last drain. Give
	 * `only` to run just the jobs with those names (`media.process`), leaving the rest queued.
	 */
	drainJobs(options?: { only?: readonly string[] }): Promise<DrainReport>;
	/**
	 * Every secret of the Install, encrypted under its Master key: set, use and describe them, for
	 * the Install, a Workspace or a Site (`{ owner: { kind: "site", workspaceId, siteId }, name }`).
	 * WebCraft's own code reaches a Workspace's or Site's secrets through the data layer; tests of
	 * the secret store use this.
	 */
	readonly secrets: Secrets;
	/**
	 * Sends a System email the way WebCraft's features do (`services.email.send`): rendered for each
	 * recipient, recorded in the Email log and queued; drain the jobs to send it.
	 */
	sendSystemEmail<Type extends SystemEmailType>(email: SystemEmail<Type>): Promise<SendResult[]>;
	/** Every email the Install sent. */
	mail: FakeMailer;
	/**
	 * The newest email to `address`: runs the jobs that are due, then looks at what the Install SMTP
	 * sent or, while it isn't set, what was written to the log instead. Throws when there is none.
	 * The clock stands still, so emails queued in the same instant can go out in either order: drain
	 * the jobs between two emails to one address when the order matters.
	 */
	lastEmailTo(address: string): Promise<{ to: string; subject: string; text: string }>;
	/**
	 * The Install's outgoing HTTP: prepare answers, read what was requested. The leaked-password
	 * range service answers that no password is leaked unless a test answers it otherwise.
	 */
	http: FakeHttp;
	/** The Install's DNS: names resolve only to what a test answers (`dns.answer(name, addresses)`). */
	dns: FakeDns;
	/** The certificates hosts answer with over HTTPS (`tls.answer(name, { expiresAt })`); none unless given. */
	tls: FakeTls;
	/**
	 * Points a domain at this Install, as its DNS records would: it resolves to the Install's first
	 * address, every HTTP request to it reaches this Install's handler, and it answers HTTPS with a
	 * certificate valid for 90 more days (or the one given; null for none).
	 */
	connectDomain(name: string, options?: { certificate?: { expiresAt: Date; trusted?: boolean } | null }): void;
	clock: TestInstallClock;
	/** Every log entry the Install wrote. */
	logs: LogEntry[];
	/**
	 * Starts the Install again, with another Master key when given, as web and worker do after their
	 * `WEBCRAFT_SECRET_KEY` changes, running the same start-up checks (and printing a new setup token
	 * when the Install has no Superadmin). When the check refuses the key, this rejects with the same
	 * error and the Install keeps running as before. `modules` starts it with other Modules, as a
	 * new version of WebCraft with other versions of its Modules would.
	 */
	restart(options?: { masterKey?: string; modules?: readonly ModuleDefinition[] }): Promise<void>;
	/**
	 * Runs the `migrate` step on the Install's database, as `webcraft admin migrate` does: WebCraft's
	 * pending migrations, then the Modules' (the Install's own Modules unless given).
	 */
	migrate(options?: { modules?: readonly ModuleDefinition[] }): Promise<MigrationReport>;
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
	const storageDir = mkdtempSync(join(tmpdir(), "webcraft-storage-"));
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
	const dns = createFakeDns();
	const http = createFakeHttp(dns.resolver);
	const tls = createFakeTls();
	// The leaked-password range service lists no password as leaked unless a test says otherwise.
	http.respond("GET", LEAKED_PASSWORD_RANGE, { body: "" });
	const adminHost = options.adminHost ?? TEST_ADMIN_HOST;
	const adminOrigin = `https://${adminHost}`;
	const sitesDomain = options.sitesDomain === undefined ? TEST_SITES_DOMAIN : options.sitesDomain;
	const edge = options.edge ?? "caddy";
	const publicAddresses = [...(options.publicAddresses ?? TEST_INSTALL_ADDRESSES)];
	const countryFile = testCountryFile();
	// The admin host resolves to the Install's addresses, as it does on a server.
	if (publicAddresses.length > 0) dns.answer(adminHost, publicAddresses);
	const env: Record<string, string> = {
		DATABASE_URL: databaseUrl,
		WEBCRAFT_ADMIN_HOST: adminHost,
		...(sitesDomain ? { WEBCRAFT_SITES_DOMAIN: sitesDomain } : {}),
		WEBCRAFT_EDGE: edge,
		...(publicAddresses.length > 0 ? { WEBCRAFT_PUBLIC_ADDRESSES: publicAddresses.join(",") } : {}),
		[MASTER_KEY_VARIABLE]: options.masterKey ?? TEST_MASTER_KEY,
		WEBCRAFT_STORAGE_DIR: storageDir,
		WEBCRAFT_COUNTRY_FILE: countryFile,
	};
	const ports: InstallPorts = {
		config: { databaseUrl, adminHost, adminOrigin, sitesDomain, storageDir, edge, publicAddresses, countryFile },
		database,
		jobs: boss ? createJobQueue(boss) : withoutJobQueue(mode),
		mailer: mail,
		http: http.fetch,
		dns: dns.resolver,
		tls: tls.probe,
		// The real reading of a file of address ranges, with the test suite's own file.
		countries: countriesFromFile(countryFile, log),
		clock,
		log,
		// The real image processing the worker does (it isn't an edge, so it isn't faked).
		images: createImageProcessor(
			options.maxImagePixels === undefined ? {} : { maxInputPixels: options.maxImagePixels },
		),
	};
	/**
	 * Starts the services as the web process does: the Master key check (web and worker never start
	 * on a database that is behind), then the setup token when the Install has no Superadmin.
	 */
	let modules = options.modules ?? FIRST_PARTY_MODULES;
	const start = async (masterKey: string) => {
		const key = parseMasterKey(masterKey, MASTER_KEY_VARIABLE);
		const started = await createInstallServices(ports, key, { checkMasterKey: mode === "migrated", modules });
		if (mode === "migrated") await started.setup.announce();
		return started;
	};
	// Scheduled jobs come due by the test clock: the drain sends each one whose time came since then.
	const schedulesCheckedAt = { time: clock.now() };
	// The handler keeps this object; a restart swaps the services inside it.
	const services: InstallServices = await start(env[MASTER_KEY_VARIABLE] ?? TEST_MASTER_KEY);
	const secretStore = (masterKey: string) =>
		createSecrets({ database, clock, masterKey: parseMasterKey(masterKey, MASTER_KEY_VARIABLE) });
	let secrets = secretStore(env[MASTER_KEY_VARIABLE] ?? TEST_MASTER_KEY);
	const handle = createWebHandler({ services });
	const send = (request: Request) => handle(request);

	let superadminAccount: TestAccount | undefined;
	let superadminBrowser: TestBrowser | undefined;
	let made = 0;
	/** A number for names and addresses that must not repeat within this Install. */
	const next = () => ++made;

	const createSuperadmin = async (overrides: Partial<TestAccount> = {}) => {
		const account: TestAccount = {
			name: "Sam Superadmin",
			email: "superadmin@agency.example",
			password: TEST_PASSWORD,
			adminLanguage: "en",
			...overrides,
		};
		await services.setup.createSuperadmin(account);
		superadminAccount = account;
		return account;
	};
	const signIn = async (
		{ email, password }: Pick<TestAccount, "email" | "password">,
		browserOptions: TestBrowserOptions = {},
	) => {
		const browser = createTestBrowser({ send, adminOrigin, ...browserOptions });
		await browser.api.session.signIn({ email, password });
		return browser;
	};
	const lastEmailTo = async (address: string) => {
		const to = address.trim().toLowerCase();
		if (boss) await drainJobs(boss, services);
		const sent = mail.sent.findLast((email) => email.to === to);
		if (sent) return { to: sent.to, subject: sent.subject, text: sent.text };
		const logged = logs.findLast((entry) => (entry.email as { to?: unknown } | undefined)?.to === to)?.email as
			| { to: string; subject: string; text: string }
			| undefined;
		if (logged) return logged;
		throw new Error(`No email went to ${to}.`);
	};
	const superadmin = async () => {
		if (superadminBrowser) {
			// A test may have moved the clock past the session's end.
			if ((await superadminBrowser.api.session.current()).person) return superadminBrowser;
		}
		superadminAccount ??= await createSuperadmin();
		superadminBrowser = await signIn(superadminAccount);
		return superadminBrowser;
	};

	/**
	 * Runs a Sensitive action as the Superadmin. A test may have moved the clock past the last identity
	 * check, so when one is asked for, the Superadmin confirms their password and the call is retried.
	 */
	const asSuperadmin = async <Result>(admin: TestBrowser, call: () => Promise<Result>): Promise<Result> => {
		try {
			return await call();
		} catch (error) {
			if ((error as { code?: string }).code !== "IDENTITY_CHECK_REQUIRED" || !superadminAccount) throw error;
			await admin.api.session.confirmIdentity({ password: superadminAccount.password });
			return call();
		}
	};

	return {
		adminHost,
		sitesDomain,
		databaseUrl,
		storageDir,
		env,
		adminUrl: (path) => new URL(path, adminOrigin).toString(),
		// A Request given keeps the client address it came from (`fromAddress`).
		request: (input, init) =>
			handle(
				input instanceof Request
					? fromAddress(new Request(input, init), (input as Request & { ip?: string }).ip ?? null)
					: new Request(String(input), init),
			),
		browser: (browserOptions) => createTestBrowser({ send, adminOrigin, ...browserOptions }),
		createSuperadmin,
		signIn,
		superadmin,
		async createWorkspace(name) {
			const admin = await superadmin();
			const { workspace } = await admin.api.workspaces.create({ name: name ?? `Workspace ${next()}` });
			return { id: workspace.id, name: workspace.name };
		},
		async createSite(workspaceId, site = {}) {
			const admin = await superadmin();
			const number = next();
			const created = await admin.api.sites.create({
				workspaceId,
				name: site.name ?? `Site ${number}`,
				slug: site.slug ?? `site-${number}`,
			});
			return { id: created.site.id, slug: created.site.slug };
		},
		async createMember({ workspaceId, role, sites = "all", name, email }) {
			const admin = await superadmin();
			const number = next();
			const account: TestAccount = {
				name: name ?? `Member ${number}`,
				email: email ?? `member-${number}@client.example`,
				password: TEST_PASSWORD,
				adminLanguage: "en",
			};
			await asSuperadmin(admin, () => admin.api.members.invite({ workspaceId, email: account.email, role, sites }));
			const token = new URL(inviteLinkIn(await lastEmailTo(account.email))).searchParams.get("token") ?? "";
			const browser = createTestBrowser({ send, adminOrigin: TEST_ADMIN_ORIGIN });
			const { personId } = await browser.api.invites.accept({ token, ...account });
			return { account, personId, browser };
		},
		addMembership: (membership) => services.memberships.add(membership),
		async createStaff({ workspaces, name, email }) {
			const admin = await superadmin();
			const number = next();
			const account: TestAccount = {
				name: name ?? `Staff ${number}`,
				email: email ?? `staff-${number}@agency.example`,
				password: TEST_PASSWORD,
				adminLanguage: "en",
			};
			await asSuperadmin(admin, () => admin.api.staff.invite({ email: account.email, workspaces }));
			const token = new URL(inviteLinkIn(await lastEmailTo(account.email))).searchParams.get("token") ?? "";
			const browser = createTestBrowser({ send, adminOrigin });
			const { personId } = await browser.api.invites.accept({ token, ...account });
			return { account, personId, browser };
		},
		setupToken: () => {
			const printed = logs.findLast((entry) => typeof entry.setupToken === "string");
			return printed?.setupToken as string | undefined;
		},
		jobs: services.jobs,
		drainJobs: async (drainOptions = {}) => {
			if (!boss) throw new Error(`An Install with an ${mode} database has no job queue to drain.`);
			await sendDueSchedules(boss, services.jobs, clock, schedulesCheckedAt);
			return drainJobs(boss, services, drainOptions.only);
		},
		get secrets() {
			return secrets;
		},
		sendSystemEmail: (email) => services.email.send(email),
		mail,
		lastEmailTo,
		http,
		dns,
		tls,
		connectDomain(name, connectOptions = {}) {
			const domain = name.toLowerCase();
			dns.answer(domain, [publicAddresses[0] ?? "203.0.113.10"]);
			const escaped = domain.replaceAll(".", "\\.");
			http.respond("GET", new RegExp(`^https?://${escaped}(:\\d+)?/`), async (request) => {
				const response = await handle(new Request(request.url, { headers: request.headers }));
				return {
					status: response.status,
					body: new Uint8Array(await response.arrayBuffer()),
					headers: Object.fromEntries(response.headers),
				};
			});
			const certificate =
				connectOptions.certificate === undefined
					? { expiresAt: new Date(clock.now().getTime() + 90 * 24 * 60 * 60_000) }
					: connectOptions.certificate;
			tls.answer(domain, certificate);
		},
		clock,
		logs,
		async restart(restartOptions = {}) {
			const masterKey = restartOptions.masterKey ?? env[MASTER_KEY_VARIABLE] ?? TEST_MASTER_KEY;
			const before = modules;
			modules = restartOptions.modules ?? modules;
			try {
				Object.assign(services, await start(masterKey));
			} catch (error) {
				modules = before;
				throw error;
			}
			secrets = secretStore(masterKey);
			env[MASTER_KEY_VARIABLE] = masterKey;
		},
		migrate: (migrateOptions = {}) =>
			runMigrations(databaseUrl, { modules: moduleSchemas(migrateOptions.modules ?? modules) }),
		async close() {
			await boss?.stop({ graceful: false, close: true });
			await database.close();
			await testDatabase?.drop();
			rmSync(storageDir, { recursive: true, force: true });
		},
	};
}

/**
 * Sends each scheduled job whose time came, by the test clock, since the last drain: once, however
 * many times it came due (as the worker does after being down).
 */
async function sendDueSchedules(boss: PgBoss, jobs: JobQueue, clock: Clock, checkedAt: { time: Date }) {
	const now = clock.now();
	for (const schedule of coreSchedules) {
		const [next] = boss.previewSchedule(schedule.cron, { from: checkedAt.time, count: 1, tz: "UTC" });
		if (next && next.getTime() <= now.getTime()) await jobs.send(schedule.job, schedule.payload);
	}
	checkedAt.time = now;
}

/** Every round fetches each queue until a round finds nothing due; this stops a job loop. */
const MAX_DRAIN_ROUNDS = 100;

async function drainJobs(boss: PgBoss, services: InstallServices, only?: readonly string[]): Promise<DrainReport> {
	const report: DrainReport = { completed: [], failed: [] };
	const jobs = only ? coreJobs.filter((job) => only.includes(job.name)) : coreJobs;
	for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
		let ran = 0;
		for (const job of jobs) {
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
