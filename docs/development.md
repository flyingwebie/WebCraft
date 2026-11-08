# Development

How to run WebCraft locally, how the code is laid out, how to test it, and the conventions every change follows. Terms follow `GLOSSARY.md`; decisions are in `docs/adr/`.

## Layout

A Bun-workspaces monorepo, scaffolded once with Better-T-Stack (TanStack Start, oRPC, Better Auth, Postgres + Drizzle, Biome, Turborepo) and reshaped to the spec's layout.

| Path | What it is | Runs on |
| --- | --- | --- |
| `apps/server` | The web process. One request handler routes every request by hostname: the admin host to the admin side (the TanStack Start admin, `/healthz`, `/readyz`, later `/api/v1`, `/mcp`, OAuth and the Caddy ask endpoint), every other hostname to the Site pipeline. | Bun 1.4 |
| `apps/worker` | The worker: runs pg-boss jobs. | Node LTS |
| `apps/cli` | The `webcraft` command (`webcraft admin migrate` for now). | Bun |
| `packages/core` | Domain modules and the ports every process shares: `Clock`, `Mailer`, outgoing HTTP, `Logger`, job definitions, `InstallServices`. | both |
| `packages/db` | Postgres: Drizzle schema and migrations, connections, the migrate step, the schema check, the pg-boss job queue. | both |
| `packages/auth` | WebCraft's auth interface, with Better Auth behind it (placeholder). | both |
| `packages/api` | The Management API: oRPC procedures (placeholder). | both |
| `packages/mcp` | The MCP server, generated from the API (placeholder). | both |
| `packages/renderer` | Template markup and the Site renderer (placeholder). | both |
| `packages/ui` | shadcn components for the admin. | browser |
| `packages/config` | The shared `tsconfig.base.json`. | |
| `tests` | The seam-1 test harness and the tests that use it. | Bun |
| `scripts` | `dev.ts`, the licence check and the denylist check. | Bun / sh |

The Better-T-Stack command was:

```sh
bun create better-t-stack@latest webcraft --frontend tanstack-start --backend self --runtime none \
  --database postgres --orm drizzle --api orpc --auth better-auth --payments none \
  --addons biome turborepo --examples none --db-setup docker --web-deploy none --server-deploy none \
  --no-git --package-manager bun
```

## Setup

You need Bun 1.4, Node 22.18 or later (CI and the images use the current LTS), and either Docker or a Postgres 18 server you can create databases on.

```sh
bun install
cp .env.example .env     # then set DATABASE_URL (see "Databases" below)
bun run dev
```

`bun run dev` does everything in one go:

1. Checks that Postgres answers at `DATABASE_URL`. Only when it doesn't, and the host is this machine, it starts `docker-compose.dev.yml` with the user, password and port from `DATABASE_URL`. A server that already answers is never touched.
2. Creates the database named in `DATABASE_URL` if it's missing.
3. Runs the migrate step.
4. Starts the web process (`vite dev` on Bun, port `PORT`) and the worker (Node, restarting when its files change). Ctrl-C stops both.

Open `http://admin.localhost:3000/` for the admin. Every other hostname is a Site; names under `.localhost` reach your machine without DNS changes, so `http://shop.localhost:3000/` is a Site hostname (an unknown one, for now). Vite refuses hostnames outside `.localhost` in development.

Run every command from the repo root: Bun loads `.env` from the directory it runs in.

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Postgres if needed, migrate, then web and worker. |
| `bun test` | Every test. `bun test tests/web/health.test.ts` runs one file; `bun test -t "readyz"` filters by name. |
| `bun run lint` | Biome lint and format check (`bun run format` fixes what it can). |
| `bun run typecheck` | `tsc` in every workspace (through Turborepo) and in `scripts/`. |
| `bun run build` | Builds the admin and the server bundle (`apps/server/dist`). |
| `bun run db:migrate` | The migrate step: `webcraft admin migrate`. |
| `bun run db:generate` | Writes a migration for your schema changes (`--custom --name=<name>` for an empty one to hold hand-written SQL). |
| `bun run db:studio` | Drizzle Studio on `DATABASE_URL`. |
| `bun run start` / `bun run start:worker` | The production web process (after `build`) and worker. |
| `bun run check:licences` | Fails on a dependency whose licence isn't AGPL-compatible. |
| `bun run check:denylist` | The reference-material denylist check (see below). |

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | all | The Install's Postgres database. Tests derive their database names from it. |
| `WEBCRAFT_ADMIN_HOST` | web, worker | The admin's hostname, without scheme or port (`admin.example.com`). Reserved: it never resolves to a Site. |
| `PORT` | web | The web process's port (default 3000). |
| `WEBCRAFT_DENYLIST` | denylist check | The denylist itself, one pattern per line. CI fills it from the `REFERENCE_DENYLIST` secret. |
| `WEBCRAFT_DENYLIST_FILE` | denylist check | The path of a file holding the denylist, kept outside the repo. |
| `CI` | denylist check | When set, a missing denylist fails the check instead of skipping it. |

Web and worker refuse to start when a setting is missing or malformed, and when the database is behind (see "Migrations").

## Databases

Several worktrees and CI jobs share one Postgres server, so names must never collide:

- **Each worktree uses its own database**, named `wc_t<N>` after the ticket it works on (`wc_t48` for #48): `DATABASE_URL=postgres://postgres:webcraft@localhost:55432/wc_t48`. Outside the ticket workflow, any unique name works.
- **Tests never use that database.** Each run creates `<name>_test_<run id>_tpl`, migrates it once with the real migrations, and copies it into a fresh `<name>_test_<run id>_<n>` for every test Install (`CREATE DATABASE ... TEMPLATE`, which is fast). All of them are dropped when the run ends. The run id holds the start time, so a run that was killed leaves databases the next run of the same worktree recognises and drops once they are six hours old.
- Never drop or change a database that doesn't start with your own name.

## How a request flows

`apps/server/src/handler.ts` is the web process: `createWebHandler({ services, adminApp })` returns a plain `(Request) => Promise<Response>`.

- **Admin host** (`apps/server/src/admin/side.ts`): the web process answers its own paths first (`/healthz`, `/readyz`; add `/api/v1`, `/mcp` and the rest there), then hands the request to the admin app. In production the admin's built files are served from `apps/server/dist/client` here too, so Sites never expose them.
- **Every other hostname** (`apps/server/src/site/pipeline.ts`): the Site pipeline. Until Sites exist it answers every hostname with the unbranded 404 (`Not Found`, plain text). Anything a Site visitor sees must stay unbranded: use `plainText`, `notFound` and `json` from `apps/server/src/responses.ts`.
- `/healthz` answers 200 while the process is up. `/readyz` answers 200 when the database is reachable and has had every migration this version expects, 503 otherwise. Both answer only on the admin host; container health checks must send `Host: <admin host>`.
- `apps/server/src/server.ts` is the TanStack Start server entry: it builds the services and wraps the admin renderer in the hostname router. `vite dev` runs it in development; `vite build` bundles it into `dist/server/server.js`, which `apps/server/src/serve.ts` serves with `Bun.serve` in production. Tests call `createWebHandler` directly, without the admin app.

## Migrations

Migrations are drizzle-kit files in `packages/db/src/migrations`, applied by their own `migrate` step (ADR 0031), never by web or worker at start-up.

- Change the schema in `packages/db/src/schema/` (one file per area, re-exported from `index.ts`), then `bun run db:generate`. Commit the generated folder.
- Hand-written SQL (functions, triggers, data fixes) goes in its own custom migration: `bun run db:generate --custom --name=<what-it-does>`. Keeping it separate means a regenerated schema migration never loses it.
- Every change keeps the previous version working on the new schema: add first, remove in a later release. There are no down-migrations.
- `webcraft admin migrate` applies pending migrations in one transaction, then installs or upgrades the job queue (pg-boss) schema. Web and worker check both at start-up and refuse to run on a database that is behind; `/readyz` reports the same check.
- When two branches both add migrations, keep the integration branch's and regenerate yours on top with `bun run db:generate`.

## Jobs

Jobs are defined in `packages/core/src/jobs/` with `defineJob({ name, payload, queue, run })`, and listed in `coreJobs` (`packages/core/src/jobs/index.ts`); the worker only works listed jobs. `sample-ping.ts` is the sample to copy.

- `name` is the queue name, `area.action` (`email.send`). Never rename one that has shipped.
- `payload` is a Zod schema; it is checked when the job is sent and again when it runs.
- `queue` holds retry and expiry settings (`retryLimit`, `retryDelay`, `retryBackoff`, ...).
- `run(payload, services)` gets the same `InstallServices` as the web process: use `services.clock`, `services.mailer`, `services.http` and `services.log`, never `Date.now()`, `fetch` or `console` directly.
- Enqueue with `services.jobs.send(job, payload, { startAfter })`.

## Testing

Tests live in `tests/`, grouped by area, and run with `bun test` from the repo root. They test at the spec's seams and check what a person, visitor or client would observe: HTTP responses, emails that went out, outgoing calls, job outcomes and later responses. They never import internal functions or read tables directly; refactoring without changing behaviour must not break a test.

**Seam 1** is the web process's handler, booted in-process against a real Postgres. `createTestInstall()` from `tests/harness/index.ts` gives each test file its own Install:

| Part | What it does |
| --- | --- |
| `install.request(url, init)` | Sends a standard `Request` through the handler, in process. Always use a full URL: the hostname decides where it goes. `install.adminUrl("/healthz")` builds admin-host URLs (`https://admin.test/...`). |
| `install.jobs.send(job, payload)` | Enqueues a job as the web process would. |
| `install.drainJobs()` | Runs every job that is due by the test clock, including jobs those jobs enqueue, and returns `{ completed, failed }`. |
| `install.mail` | The fake Mailer: `install.mail.sent` holds every email; `clear()` forgets them. |
| `install.http` | The fake outgoing HTTP: `respond(method, url or RegExp, { status, body, headers } or a function)`; `requests` holds every call. A request nobody prepared an answer for fails like an unreachable server. |
| `install.clock` | Time stands still until `advance(ms)` or `set(date)`. The job queue reads the same time inside Postgres, so a job sent with `startAfter` in an hour runs only after `advance` passes it, and retries wait for their delay. Starts at `2026-03-02T09:00:00Z` unless you pass `{ now }`. |
| `install.logs` | Every log entry the Install wrote. |
| `install.close()` | Stops the Install and drops its database. |

`createTestInstall({ database: "empty" })` gives an Install whose database nobody migrated, and `{ database: "unreachable" }` one whose database doesn't answer.

A seam-1 test:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("the sample job emails the status of a URL", async () => {
	install.http.respond("GET", "https://status.example.org/ping", { status: 204 });

	await install.jobs.send(samplePing, { url: "https://status.example.org/ping", notify: "ops@agency.example" });
	const report = await install.drainJobs();

	expect(report.failed).toEqual([]);
	expect(install.mail.sent.map((email) => email.subject)).toEqual(["https://status.example.org/ping answered 204"]);
});
```

`tests/worker/sample-job.test.ts` uses every part of the harness; `tests/web/health.test.ts` shows the database modes. Tests in one file share their Install, so give each test its own data (its own Workspace, its own email address) or create an Install per test when they must not see each other. `tests/worker/node-worker.test.ts` starts the real worker with `node`, the way to check something runs on Node.

**Seam 2** (a browser, for accessibility and the editors) arrives with the admin screens.

## Conventions

- **Words**: use `GLOSSARY.md` terms exactly, in code, tests, UI text and commits. British spelling in prose ("licence", "normalise").
- **TypeScript**: strict, with explicit `.ts`/`.tsx` extensions on relative imports and only erasable syntax (no `enum`, `namespace` or parameter properties). That lets Node run shared code and the worker without a build step.
- **Runtimes** (ADR 0006): `packages/*` and `apps/worker` use standard Web and Node APIs only; Biome rejects the `Bun` global and `bun:*` imports there, and their tsconfigs don't load Bun's types. `apps/server`, `apps/cli`, `tests` and `scripts` may use Bun.
- **Edges go through ports**: time through `Clock`, email through `Mailer`, calls to other servers through `services.http`. Tests replace them with fakes; nothing else is faked.
- **Workspace data** goes through the Workspace-scoped data layer and the `can()` check once they exist (ADR 0007); no query without a Workspace.
- **Errors**: Site visitors and unknown hostnames see plain, unbranded answers. Unexpected errors are logged and answered with a plain 500.
- **Logs**: JSON lines through `Logger` (`services.log`), with fields rather than values pasted into the message.
- **Licences**: every workspace's `package.json` says `"license": "AGPL-3.0-or-later"`; new dependencies must pass `bun run check:licences`.
- **Commits**: Gitmoji + Conventional Commits with the ticket number, such as `✨ feat(auth): add setup wizard (#50)`.
- **Before you finish**: `bun run lint`, `bun run typecheck` and `bun test` all pass.

## Reference-material denylist

Names of third-party products that informed WebCraft must never appear in anything tracked (ADR 0013, `docs/reference-material.md`). `scripts/check-denylist.sh` enforces it: it reads one case-insensitive extended regular expression per line from `WEBCRAFT_DENYLIST` or from the file named by `WEBCRAFT_DENYLIST_FILE`, and checks tracked files, file names, the messages of the commits in `--range` and a `--branch` name. It prints only where a match is (file and line, commit, branch), never the list or the matching text.

```sh
WEBCRAFT_DENYLIST_FILE=~/.config/webcraft/reference-denylist.txt bun run check:denylist -- --range main..HEAD
```

To check every commit locally, turn on the opt-in hooks (staged files before a commit, then the commit message):

```sh
git config core.hooksPath .githooks
export WEBCRAFT_DENYLIST_FILE=~/.config/webcraft/reference-denylist.txt   # in your shell profile
```

Without a list the check is skipped locally with a warning and fails in CI.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`:

- **Lint, typecheck, build and licences**.
- **Tests** against a Postgres 18 service, with the current Node LTS installed for the worker test.
- **Reference-material denylist** over tracked files, the commit messages being added and the branch name, with the list from the `REFERENCE_DENYLIST` repository secret. It fails when the secret is missing, as it is for pull requests from forks.
