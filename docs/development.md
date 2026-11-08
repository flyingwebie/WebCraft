# Development

How to run WebCraft locally, how the code is laid out, how to test it, and the conventions every change follows. Terms follow `GLOSSARY.md`; decisions are in `docs/adr/`.

## Layout

A Bun-workspaces monorepo, scaffolded once with Better-T-Stack (TanStack Start, oRPC, Better Auth, Postgres + Drizzle, Biome, Turborepo) and reshaped to the spec's layout.

| Path | What it is | Runs on |
| --- | --- | --- |
| `apps/server` | The web process. One request handler routes every request by hostname: the admin host to the admin side (the TanStack Start admin, `/healthz`, `/readyz`, the Management API at `/api/rpc`, later `/api/v1`, `/mcp`, OAuth and the Caddy ask endpoint), every other hostname to the Site pipeline. | Bun 1.4 |
| `apps/worker` | The worker: runs pg-boss jobs. | Node LTS |
| `apps/cli` | The `webcraft` command (`webcraft admin migrate`, `rotate-key` and `create-superadmin` for now). | Bun |
| `packages/core` | Domain modules (the permission check, the tenant data layer, Workspaces, Sites, Staff, the Audit log, the content store and publishing, the Site side of rendering, secrets, setup, people, Install settings, the Master key banner, email) and the ports every process shares: `Clock`, `Mailer`, outgoing HTTP, `Logger`, job definitions, `InstallServices`. | both |
| `packages/db` | Postgres: Drizzle schema and migrations, connections, the migrate step, the schema check, the pg-boss job queue. | both |
| `packages/auth` | WebCraft's auth interface (`Auth`): signing in and out, sessions, creating people, password rules. Better Auth sits behind it; no other package imports Better Auth. | both |
| `packages/api` | The Management API: oRPC procedures, served to the admin at `/api/rpc`. | both |
| `packages/mcp` | The MCP server, generated from the API (placeholder). | both |
| `packages/renderer` | Element trees (the stored form of Templates) and the renderer that turns them into HTML; Template markup joins it. It reads nothing itself. | both |
| `packages/ui` | shadcn components for the admin (preset `b1Fk3bmIS`) and its theme. | browser |
| `packages/config` | The shared `tsconfig.base.json`. | |
| `tests` | The seam-1 test harness and its tests, and the seam-2 browser harness (`tests/browser`). | Bun |
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
cp .env.example .env     # then set DATABASE_URL (see "Databases" below) and WEBCRAFT_SECRET_KEY
bun run dev
```

Make the Master key for `WEBCRAFT_SECRET_KEY` with `openssl rand -base64 32` (see "Secrets and the Master key").

`bun run dev` does everything in one go:

1. Checks the settings web and worker need, and stops with the reason when one is missing or malformed.
2. Checks that Postgres answers at `DATABASE_URL`. Only when it doesn't, and the host is this machine, it starts `docker-compose.dev.yml` with the user, password and port from `DATABASE_URL`. A server that already answers is never touched.
3. Creates the database named in `DATABASE_URL` if it's missing.
4. Runs the migrate step.
5. Starts the web process (`vite dev` on Bun, port `PORT`) and the worker (Node, restarting when its files change). Ctrl-C stops both.

Open `http://admin.localhost:3000/` for the admin. On a fresh database the web log prints a setup token and a link to the setup wizard (`setupUrl`); open it to create the Superadmin (see "Signing in and the setup wizard"). Every other hostname is a Site; names under `.localhost` reach your machine without DNS changes. With `WEBCRAFT_SITES_DOMAIN=sites.localhost`, a Site with the slug `shop` answers on its Staging address `http://shop.sites.localhost:3000/` (`sites.get` gives it as `stagingUrl`). Vite refuses hostnames outside `.localhost` in development.

Run every command from the repo root: Bun loads `.env` from the directory it runs in.

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Postgres if needed, migrate, then web and worker. |
| `bun test` | Every seam-1 test. `bun test tests/web/health.test.ts` runs one file; `bun test -t "readyz"` filters by name. |
| `bun run test:browser` | The browser accessibility checks (seam 2), against the production build: run `bun run build` first, and once `bunx playwright install chromium` in `tests/`. |
| `bun run lint` | Biome lint and format check (`bun run format` fixes what it can). |
| `bun run typecheck` | `tsc` in every workspace (through Turborepo) and in `scripts/`. |
| `bun run build` | Builds the admin and the server bundle (`apps/server/dist`). |
| `bun run db:migrate` | The migrate step: `webcraft admin migrate`. |
| `bun apps/cli/src/main.ts admin create-superadmin <email>` | Creates the Superadmin of a fresh Install without the wizard (see below). |
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
| `WEBCRAFT_SITES_DOMAIN` | web, worker | Optional. The domain Staging addresses sit under: each Site answers on `<site slug>.<sites domain>` (`sites.example.com` gives `bakery.sites.example.com`; point a wildcard DNS record at the Install). Without it Sites have no Staging address. When the admin host sits right under it (`cms.example.com` under `example.com`), its first label can't be a Site slug. |
| `PORT` | web | The web process's port (default 3000). |
| `WEBCRAFT_SECRET_KEY` | web, worker, `rotate-key` | The Master key, at least 32 characters (`openssl rand -base64 32`). It encrypts every stored secret. Keep a copy outside the server. |
| `WEBCRAFT_OLD_SECRET_KEY` | `rotate-key` | The Master key being replaced, only while `webcraft admin rotate-key` runs. |
| `WEBCRAFT_DENYLIST` | denylist check | The denylist itself, one pattern per line. CI fills it from the `REFERENCE_DENYLIST` secret. |
| `WEBCRAFT_DENYLIST_FILE` | denylist check | The path of a file holding the denylist, kept outside the repo. |
| `CI` | denylist check | When set, a missing denylist fails the check instead of skipping it. |

Web and worker refuse to start when a setting is missing or malformed (a Master key that is missing or shorter than 32 characters prints the `openssl rand -base64 32` command), when the database is behind (see "Migrations"), and when `WEBCRAFT_SECRET_KEY` isn't the Install's current Master key (see "Secrets and the Master key").

## Databases

Several worktrees and CI jobs share one Postgres server, so names must never collide:

- **Each worktree uses its own database**, named `wc_t<N>` after the ticket it works on (`wc_t48` for #48): `DATABASE_URL=postgres://postgres:webcraft@localhost:55432/wc_t48`. Outside the ticket workflow, any unique name works.
- **Tests never use that database.** Each run creates `<name>_test_<run id>_tpl`, migrates it once with the real migrations, and copies it into a fresh `<name>_test_<run id>_<n>` for every test Install (`CREATE DATABASE ... TEMPLATE`, which is fast). All of them are dropped when the run ends. The run id holds the start time, so a run that was killed leaves databases the next run of the same worktree recognises and drops once they are six hours old.
- Never drop or change a database that doesn't start with your own name.

## How a request flows

`apps/server/src/handler.ts` is the web process: `createWebHandler({ services, adminApp })` returns a plain `(Request) => Promise<Response>`.

- **Admin host** (`apps/server/src/admin/side.ts`): the web process answers its own paths first (`/healthz`, `/readyz`, the Management API at `/api/rpc`; add `/api/v1`, `/mcp` and the rest there), then hands the request to the admin app. In production the admin's built files are served from `apps/server/dist/client` here too, so Sites never expose them.
- **`/api/rpc`** is the Management API as the admin's own pages call it: every procedure in `packages/api/src/router.ts`, over oRPC's RPC protocol, signed in with the session cookie. A request another site's page makes (by its `Origin` or `Sec-Fetch-Site` header) is refused with 403, so no other site can act with a signed-in person's cookie. Procedures get `{ services, headers, resHeaders, via }`; start them from `procedure`, `signedIn` or `onInstall(permission)` in `packages/api/src/context.ts` (see "Writing a procedure"), and throw WebCraft's own errors: `packages/api/src/errors.ts` turns them into API error codes, which the admin translates.
- **Every other hostname** (`apps/server/src/site/pipeline.ts`): the Site pipeline (see "The Site pipeline and the page cache"). A hostname that is no Site's gets the unbranded 404 (`Not Found`, plain text), and nothing on a Site hostname ever reaches the admin. Anything a Site visitor sees must stay unbranded: use `plainText`, `notFound` and `json` from `apps/server/src/responses.ts`.
- `/healthz` answers 200 while the process is up. `/readyz` answers 200 when the database is reachable and has had every migration this version expects, 503 otherwise. Both answer only on the admin host; container health checks must send `Host: <admin host>`.
- `apps/server/src/server.ts` is the TanStack Start server entry: it builds the services and wraps the admin renderer in the hostname router. `vite dev` runs it in development; `vite build` bundles it into `dist/server/server.js`, which `apps/server/src/serve.ts` serves with `Bun.serve` in production. Tests call `createWebHandler` directly, without the admin app.

## Tenancy and permissions

An Install holds Workspaces (one per client), and each Workspace holds Sites. The Superadmin and Staff hold an Install-level role; Members hold a Membership in a Workspace (ADR 0001). Every procedure checks a Permission with `can()`, and every query on tenant data goes through the data layer (ADRs 0007, 0028).

### Permissions and roles

`packages/core/src/permissions/`:

- **`PERMISSIONS`** (`roles.ts`) names every Permission and the levels it is checked at: the Install, a Workspace or a Site (`entry.publish` is checked on a Site, `site.create` on a Workspace, `workspace.create` on the Install).
- **`ROLES`** is the role table: each built-in role (`superadmin`, `staff`, `owner`, `editor`, `author`) is a Permission set, plus what it reaches: the whole Install, the Workspaces its holder is assigned to (Staff), or one Workspace and the Sites its Membership names (Members). Roles are stored as text keys (`install_roles.role`, `memberships.role`); an unknown key grants nothing. Which Workspaces Staff reach (`install_roles.all_workspaces`, `staff_workspaces`) and which Sites a Membership reaches (`memberships.all_sites`, `membership_sites`) are kept apart from the role.
- **`can(actor, permission, resource)`** answers whether an actor may do something; `permissionsOn(actor, resource)` lists what they may do there (the admin reads these lists to decide what to show). Only person actors exist so far; API tokens, OAuth grants and Modules become more kinds of `Actor`, each limited by what stands behind it.
- **Adding a Permission**: add it to `PERMISSIONS` with its level, add it to the roles that hold it, and change the role's row in `tests/permissions/roles.test.ts` (one test per role). Never check a role name in code: check a Permission.
- Staff never hold a Membership: a Staff invite refuses an address someone already signs in with, and `services.memberships.add` refuses Staff and the Superadmin.

### The tenant data layer

`services.data` (`packages/core/src/tenancy/data-layer.ts`) is the only way to tenant data. It opens a scope after checking the Permission, and a scope's queries are limited to its Workspace (and Site):

```ts
const site = await services.data.site(access, siteId, "entry.publish"); // can() runs here
const drafts = await site.select(entries, eq(entries.status, "draft")); // only this Site's rows
const entry = await site.insert(entries, { title, createdAt: site.now() }); // fills workspace_id and site_id
await site.audit("entry.publish", { entryId: entry.id }); // who, when, how, Workspace and Site filled in
```

- `services.data.install(access, permission)`, `.workspace(access, workspaceId, permission)` and `.site(access, siteId, permission)` open the three levels. A Workspace or Site the actor can't see answers `WorkspaceNotFoundError` / `SiteNotFoundError` (404), one they see without the Permission `PermissionDeniedError` (403), so nobody learns what exists outside their reach.
- A Workspace scope works on **Workspace tables** (a `workspace_id` column); a Site scope on **Site tables** (both `workspace_id` and `site_id`, with a composite foreign key to `sites (workspace_id, id)` so a row can never point at another Workspace's Site). Module tables follow the same rule.
- Scope queries: `select(table, where?, { orderBy, limit })`, `first`, `count`, `insert`, `update(table, set, where?)`, `delete`. For a join, a lock (`.for("update")`) or anything else, run your own query on `scope.db` (the scope's transaction inside `scope.transaction`) and include `scope.where(table, extra?)`: every query on a tenant table must carry it. `scope.transaction(work)` runs queries and Audit log entries together.
- **Visitors** have no person behind them: `services.data.visitors(site)` opens a Site read-only (`select`, `first`, `count`, `where`, `db`), with no Audit log and no secrets. Only the Site pipeline opens one, after finding the Site by hostname, and code reading through it reads only what any visitor may see (published content).
- `scope.secrets` holds the Workspace's or Site's secrets (`set(name, value)`, `useWith`, `describe`, `remove`); `services.secrets` holds only the Install's own.
- The Install scope's `db` is for Install-level tables (Workspaces, Staff, invites); a domain function takes the scope it needs as its first argument, such as `createSite(workspace, input)`.

### Writing a procedure

A procedure validates its input with Zod, opens the data layer with the Permission it needs, and calls a domain function that takes the scope:

```ts
create: signedIn
	.input(z.object({ workspaceId: id, name: z.string().trim().min(1).max(100), slug: z.string().max(100) }))
	.handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "site.create");
		return { site: await context.services.sites.create(workspace, input) };
	}),
```

- `signedIn` gives `context.access`: the person as `can()` sees them (read fresh on every request, so a change to someone's access takes effect at once) and `via`, how the call came in. Install-level procedures start from `onInstall("staff.manage")`, which gives `context.install`.
- A Site procedure takes `siteId` only: the data layer finds its Workspace.
- Every procedure here is internal to the admin; `/api/v1` and the public ones come later.
- Add one isolation line for it (below) when it takes a `workspaceId` or `siteId`.

### The Audit log

The Audit log is one append-only table (`audit_log`; triggers refuse updates and truncation). `recordAudit` (`packages/core/src/audit.ts`) is the only function that writes it; code calls it through `scope.audit(action, details)`, which fills in who, when, how (`via`), the Workspace and the Site. An Install scope's `audit` takes the Workspace (and Site) the action concerns as a third argument, a Workspace scope's the Site.

- **Actions** are `<noun>.<verb>`: `install.claim`, `superadmin.create`, `masterKey.confirmStored`, `workspace.create`, `site.create`, `staff.invite`, `staff.revokeInvite`, `staff.join`, `staff.changeWorkspaces`, `postType.create`, `postType.update`, `entry.publish`, `template.publish`. Saving a Draft isn't logged; publishing is.
- **How** (`AuditVia`): `admin` for `/api/rpc`, `command` with the command's name for `webcraft admin …`. Later kinds: Edit mode, an API token's name, an AI client's name, a Module, Impersonation.
- **Details** are plain JSON about what changed (a name, an email address); never a secret's value.
- `audit.list` gives the Superadmin the newest entries; the screens and the Staff and Owner views come with the Audit log screens.

### Staff and invites

The Superadmin invites Staff by email (`staff.invite`), to all Workspaces (including later ones) or chosen ones. The invite is the `staff-invite` System email (see "Email"), in the Install's default Admin language, with a link to `/invite?token=…` that works once, for 7 days; only the token's hash is stored. Inviting the same address again replaces the invite. Accepting creates the account with the role and its Workspaces, records `staff.join`, and signs the person in.

## Content and publishing

The content store is `packages/core/src/content/`, behind `services.postTypes`, `services.entries`, `services.templates` and `services.publishing`. Its tables (`post_types`, `entries`, `published_slugs`, `templates`) are Site tables.

- **Post Types** are Structure without a Draft: `create`, `update`, `list`, `get`. Each has a `key` (`blog`, made from the name when not given; it never changes), a `name`, a URL pattern and its Fields, in order. Changing one applies at once and clears the Site's page cache.
- **URL patterns** (`content/url-patterns.ts`) are fixed path parts (lower-case letters, digits, dashes) and exactly one `{slug}`: `/blog/{slug}`, `/{slug}`. Fixed parts can't start with `_`, so no pattern reaches the paths the Install keeps (`/_webcraft/…`, `/_media/…`). When several patterns match a path, the most specific is tried first (a fixed part beats `{slug}` at the first place they differ). Nested Pages and the Site template's routing come with #61.
- **Fields** (`content/fields.ts`) are `{ key, label, type, translatable, required }`; `text` is the only type so far (#59 adds the rest). A key never changes, so a Field's values and bindings follow it. Keys can't be a built-in Field or a name Template markup reads from (`site`, `props`, `item`, …).
- **Built-in Fields** every Entry has: `title`, `slug` (both translatable, stored like Fields), `status`, `author`, `createdAt`, `updatedAt` (Draft saved), `publishedAt` (first publish) and `lastPublishedAt`. A Post Type lists them as `builtInFields`.
- **Entries** keep two versions side by side in `entries.draft` and `entries.published` (null until the first publish). Inside each, values are stored per key and per language (ADR 0003): `{ values: { title: { en: { value, by } }, summary: { … } } }`, where `by` is who wrote it (a person; AI translation joins later). A shared Field keeps one value under the Default language; a Translatable field falls back to the Default language one Field at a time. Sites have one language (`sites.default_language`, `en`) until #80. `status` is worked out: `draft` (never published), `published`, `changed` (the Draft differs).
- **The Draft is written in one place**: `changeDraft` in `content/entries.ts`, which `entries.create` and `entries.saveDraft` both go through, with the Entry row locked. Co-editing (#71, ADR 0025) replaces it with changes to the Draft's shared document; nothing else writes `entries.draft`.
- **Slugs**: made from the title when not given (accents dropped, `crème brûlée` gives `creme-brulee`), unique within the Post Type (`-2`, `-3`, …), and never changed by a new title. A slug another Entry of the Post Type has, in its Draft or published, is refused. `published_slugs` holds each Entry's published slug per language, so the Site finds an Entry by URL with one indexed lookup.
- **Entry templates** (`content/templates.ts`) are one per Post Type, `templates` rows of kind `entry` holding element trees in `draft` and `published`. `saveEntryTemplate` checks the tree with `parseEntryTemplate`: it may read the built-in Fields and the Post Type's Fields, and holds no `<main>` (the page's `<main>` is around it). The Site template and Archive templates become more kinds.

### Publishing

`services.publishing.publish(scope, item)` (`content/publishing.ts`) is the one way anything is published. `item` is `{ kind: "entry" | "template", id }`; Globals, Components, Forms and the Design system become more kinds. Open the Site with `publishPermission(item)` (`entry.publish` for Entries, `structure.edit` for Structure such as Templates); `publish` checks it again, so the worker's Scheduled publishes (#69) hold it too. In one transaction it:

1. locks the item and checks it can be published: an Entry needs a title, a slug and every required Field (`EntryIncompleteError`), and its slug must be free among published Entries of its Post Type (`EntrySlugTakenError`); a Template must still fit its Post Type (`ElementTreeInvalidError`);
2. copies the Draft over the published version and sets `publishedAt` (first time) and `lastPublishedAt`;
3. clears the Site's page cache (`clearPageCache`: raises `sites.page_cache_generation`);
4. writes the Audit log (`entry.publish`, `template.publish`).

Revisions (#67), Publish all (#68), Scheduled publish (#69), Review (#70), Webhooks and the CDN purge hook in here.

## The Site pipeline and the page cache

`apps/server/src/site/pipeline.ts` answers every hostname other than the admin host (ADR 0004):

1. **Hostname → Site** (`services.sitePages.resolveHost`): a Staging address, `<site slug>.<WEBCRAFT_SITES_DOMAIN>`, compared in lower case without a trailing dot. Anything else gets the unbranded 404. Primary, Redirect and language domains (#82, #80) join here. The admin host never resolves to a Site, and no Site slug can make a Staging address equal to it (`reservedSlugs`).
2. **Only `GET` and `HEAD`** for now (405 otherwise); Form posts come with their reserved paths.
3. **Page cache lookup** by normalised URL (`canonicalPath`): decoded path segments, no trailing slash, no query parameters (none changes a page yet; Filters will keep theirs, sorted).
4. **Render on a miss** (`services.sitePages.render`): the published Entry whose Post Type's URL pattern and published slug match, through its published Entry template. An Entry whose Entry template isn't published has no page yet. The page is kept in the cache.
5. **Answer** with `Content-Type: text/html`, `Cache-Control: public, max-age=0, must-revalidate` (browsers and proxies revalidate every time, since a publish must show at once), a strong `ETag` (SHA-256 of the HTML; `If-None-Match` gets 304), `X-Cache: HIT` or `MISS`, and on a Staging address `X-Robots-Tag: noindex`. A path with no page is the plain 404.

**The page cache** (`apps/server/src/site/page-cache.ts`) is in the web process's memory, 64 MiB by default, least recently used pages going first. Every page is kept under the Site's page cache generation, read with the hostname; `publish` raises the generation in Postgres in the publish's own transaction, so the whole Site's cache is cleared at once, in every web process, whichever process published (the worker too). A request that read an older generation never stores its page. The Content API (#108) and a CDN purge can key on the same generation and ETags.

Staging addresses show published pages for now; #68 makes them show Drafts, at which point Staging answers stop being cached.

### Element trees and the renderer

Templates are stored as element trees (`packages/renderer/src/tree.ts`, ADR 0002), the one canonical format the builder, Template markup (#58) and the renderer share:

```ts
{ version: 1, nodes: [
  { type: "element", id: "Xb3…", tag: "article", attributes: [], classes: [], children: [
    { type: "element", id: "Q9z…", tag: "h1", attributes: [], classes: [], children: [{ type: "value", path: "title" }] },
    { type: "element", id: "k2P…", tag: "a", classes: [],
      attributes: [{ name: "href", value: [{ type: "text", text: "/blog/" }, { type: "value", path: "slug" }] }],
      children: [{ type: "text", text: "Read more" }] },
  ] },
] }
```

- Elements have a stable `id` (filled in when missing, kept when given), a lower-case `tag` from `TEMPLATE_ELEMENTS`, ordered `attributes` (a list: Postgres `jsonb` doesn't keep key order, and a round trip must lose nothing), `classes` (Class ids, ADR 0009; refused until Classes exist, #64) and `children`. Text nodes are fixed text; value nodes and attribute value parts are **bindings**: a `path` (`title`, a Field key; later `site.x`, `props.x`, `item.x`), which Edit mode (#72) reads to tag editable regions.
- `parseElementTree(input, options)` checks a tree and answers its canonical form, or throws `ElementTreeInvalidError` with every problem and where (`nodes[0].children[2].attributes[1]`): scripts, elements outside `TEMPLATE_ELEMENTS`, `on…`, `style`, `class`, `srcdoc` and `data-wc-…` attributes, unknown value names (`isKnownValue`), unknown Classes, duplicate ids, children of void elements, more than 64 levels or 10,000 nodes. The API answers it as `TEMPLATE_INVALID` with `data.problems`.
- New node types (Component placements, Loops, Conditions, the content outlet) join the `TreeNode` union and `parseElementTree`; a change old trees can't be read as raises `ELEMENT_TREE_VERSION`.
- `renderPage` writes a whole document: `<html lang dir>`, the title (`<title> · <Site name>`), and the Entry template inside `<main>` (the built-in Site template until #61). Text and values are escaped for text or double-quoted attributes; `href`, `src` and other URL attributes (and each `srcset` candidate) keep only `http`, `https`, `mailto`, `tel`, relative paths and `#anchors`, anything else becoming `#`. Dates render as `2026-03-02` until Template markup's formatters. No script, inline style or event handler is ever written.

## Migrations

Migrations are drizzle-kit files in `packages/db/src/migrations`, applied by their own `migrate` step (ADR 0031), never by web or worker at start-up.

- Change the schema in `packages/db/src/schema/` (one file per area, re-exported from `index.ts`), then `bun run db:generate`. Commit the generated folder.
- Hand-written SQL (functions, triggers, data fixes) goes in its own custom migration: `bun run db:generate --custom --name=<what-it-does>`. Keeping it separate means a regenerated schema migration never loses it.
- Every change keeps the previous version working on the new schema: add first, remove in a later release. There are no down-migrations.
- `webcraft admin migrate` applies pending migrations in one transaction, then installs or upgrades the job queue (pg-boss) schema. Web and worker check both at start-up and refuse to run on a database that is behind; `/readyz` reports the same check.
- When two branches both add migrations, keep the integration branch's and regenerate yours on top with `bun run db:generate`.

## Jobs

Jobs are defined with `defineJob({ name, payload, queue, run })` (in `packages/core/src/jobs/`, or next to their module, such as `email/outbox.ts`) and listed in `coreJobs` (`packages/core/src/jobs/index.ts`); the worker only works listed jobs. `sample-ping.ts` is the sample to copy.

- `name` is the queue name, `area.action` (`email.send`). Never rename one that has shipped.
- `payload` is a Zod schema; it is checked when the job is sent and again when it runs.
- `queue` holds retry and expiry settings (`retryLimit`, `retryDelay`, `retryBackoff`, ...).
- `run(payload, services)` gets the same `InstallServices` as the web process: use `services.clock`, `services.http` and `services.log`, never `Date.now()`, `fetch` or `console` directly. To email someone, send a System email (see "Email"); never call `services.mailer`.
- Enqueue with `services.jobs.send(job, payload, { startAfter })`.
- **Scheduled jobs**: `defineSchedule({ job, cron, payload })`, listed in `coreSchedules`. `cron` is read in UTC (`17 3 * * *` is every day at 03:17). The worker registers every listed schedule when it starts (and removes ones no longer listed); when it was down at a due time, the job runs once when it is back. The test harness's `drainJobs()` sends each scheduled job whose time came by the test clock since the last drain.

## Email

Everything about email is in `packages/core/src/email/`, behind `services.email`. Nothing else calls the `Mailer`: every email goes through the System email sender, which records it in the Email log and queues it.

**Sending a System email** (an email to a person with an account, or to an address about to get one, such as an invite):

```ts
await services.email.send({
	type: "review-submitted",                       // from the catalogue
	to: [{ personId }, { email: "new@client.example", language: "it" }],
	data: { authorName, itemTitle, siteName, reviewPath: `/sites/${siteId}/review/${id}` },
	related: { kind: "entry", id },                  // what the Email log links to
});
// → [{ recipient, status: "queued" | "logged" | "turned-off", emailId }]
```

- **The catalogue** (`email/catalogue.ts`) lists every System email type with its category and a Zod schema of its data. `security` emails (invites, resets, sign-in changes) always go; each `work` and `alert` type can be turned off by each person in Your account › Emails, and is then skipped for them (`turned-off`). Add a type to the catalogue, its wording to `email/wording/en.ts` and `it.ts` (a missing one fails the typecheck), and its name (and, for work and alert types, a description) under `emailTypes` in the admin's message files. Never rename a type that shipped.
- **Links** in data are admin paths (`/invites/abc`), never full URLs: the sender puts the admin's origin in front, so System emails only ever link into the admin.
- **Language and layout**: each recipient gets the email in their Admin language (a bare address: the `language` given, else the Install's default), in one built-in layout (`email/layout.ts`: logo or sender name on a bar in the accent colour, heading, paragraphs, one button, footer), under **Install branding** (Install settings › Email (SMTP): sender name, logo address, accent colour, footer text). Every value is escaped. Work and alert emails link to the person's switches.
- **Which SMTP**: each queued email names its SMTP (`SmtpChoice` in `email/outbox.ts`). System emails always use the Install SMTP; a Site's own SMTP becomes another choice with Site mail. The Install SMTP password is the Install secret `smtp.password`, filled in only for the send.
- **No SMTP yet**: until the Superadmin sets the Install SMTP, the email is written to the log (`warn`, with `to`, `subject` and `text`) instead of being sent, and the Email log says "Written to the log".
- **Delivery and retries**: the `email.send` job sends it. A failed attempt is tried again after 1 minute, then a wait that doubles up to 4 hours, until 24 hours after it was queued; then it is Failed. An address the server refuses for good (a 5xx answer to `RCPT TO`) is Failed at once. Completed `email.send` jobs, which hold the body, are deleted after an hour.
- **Failing**: 3 failed sends in a row make the SMTP Failing: logged as an error, shown in Install settings › Email (SMTP) and as a notice on every admin page for the Superadmin (an email about a failing Install SMTP would go through it). A send that goes through, or saving new settings, clears it. Test emails don't count.
- **Test email**: `services.email.sendTest` sends at once through settings that may not be saved yet, and answers the server's reply.
- **The Email log** keeps time, type, recipient, subject, SMTP, status (Queued, Retrying, Sent, Failed, Written to the log), attempts, the server's last answer and the related item, never the body. The `email.purge-log` job deletes lines older than 90 days every day.
- **The Mailer** (`email/mailer.ts`) is the edge: `send(email, smtp)` over SMTP with Nodemailer (`email/smtp-mailer.ts`), rejecting with `SmtpDeliveryError` (the server's answer, and whether it refused the recipient for good).
- **Who manages it**: the Install SMTP, Install branding and the Email log procedures (`packages/api/src/procedures/email.ts`) are for the Superadmin, through one gate at the top of that file (`emailAdmin`). Changing the SMTP goes through the `sensitive` middleware (`packages/api/src/context.ts`), where the recent identity check will go.

## Secrets and the Master key

Every secret (SMTP passwords, AI keys, CDN tokens, Webhook and CAPTCHA secrets) goes through `services.secrets` (`packages/core/src/secrets/`). Secrets are write-only: code gets a value only inside a callback, and people see only "set" and its last 4 characters.

```ts
const password = { owner: { kind: "install" }, name: "smtp.password" } as const;

await services.secrets.set(password, value);                      // stores or replaces it
await services.secrets.useWith(password, (value) => smtp.login(user, value));
await services.secrets.describe(password);                        // { set: true, lastFour: "…", updatedAt } or { set: false }
await services.secrets.remove(password);
```

- **Owners**: a secret belongs to the Install (`{ kind: "install" }`: Install SMTP, shared AI keys), a Workspace (its AI key) or a Site (its SMTP, CDN token, Webhook and CAPTCHA secrets). `services.secrets` holds the Install's own; a Workspace's or Site's are reached only through the data layer, `workspace.secrets.set("ai.key", value)`, so code can't name another Workspace's secret (see "The tenant data layer"). They have foreign keys to their Workspace and Site, and go when it is deleted. A name is unique within its owner: 1 to 200 letters, digits and `.:_-`, such as `smtp.password` or `webhook:<id>:signing`.
- **No read-back**: there is no function that returns a value. `useWith` refuses a callback that returns the value (or a string holding it), so fill the secret into the call inside the callback and return the call's result. Never log a value, put it in a job payload or send it to the browser. `describe` shows no characters of a secret shorter than 16 characters, so never more than a quarter of one shows.
- **Errors**: `useWith` throws `SecretNotSetError` for a secret nobody set, and `useWith` and `describe` throw `SecretUnreadableError` for one that was changed outside WebCraft. Messages name the secret, never its value.
- **Encryption**: AES-256-GCM, with a random 12-byte nonce per value, under a key derived with HKDF-SHA256 from the Master key and the secret's key version. The authenticated data binds each ciphertext to its owner and name, so a ciphertext copied into another row can't be decrypted there. Only Web Crypto is used, so the same code runs on Bun and Node.
- **Key versions**: the table `master_key_versions` holds the fingerprint of every Master key the Install has had (never a key). The Install's first secret records its key as version 1; each rotation adds the next. Every secret stores the version it is encrypted under.
- **Fingerprint**: `masterKey.fingerprint()` (a `MasterKey` comes from `loadMasterKey(env)` or `parseMasterKey(value, source)`) is a one-way value, 64 hexadecimal characters, safe to store and show. Backup manifests carry it, and restore compares it with the running key (ADR 0032).
- **Start-up**: web and worker read the key with `loadMasterKey`, then open secrets with `openSecrets`, which refuses a key that isn't the Install's current one. An Install with no secrets yet accepts any key.

### Rotating the Master key

`webcraft admin rotate-key` decrypts every secret with the old key and encrypts it again under the new key as the next key version, in one transaction. If any secret can't be decrypted, nothing changes and the command lists it. The new key goes where web and worker will read it from afterwards, `WEBCRAFT_SECRET_KEY`; the key being replaced is passed once, in `WEBCRAFT_OLD_SECRET_KEY` or a file.

1. Make the new key: `openssl rand -base64 32`. Store a copy outside the server.
2. Stop web and worker.
3. Put the new key in `WEBCRAFT_SECRET_KEY` in the Install's environment.
4. Run the command in that environment, with the old key:

   ```sh
   WEBCRAFT_OLD_SECRET_KEY='<old key>' webcraft admin rotate-key
   # or: webcraft admin rotate-key --old-key-file /run/secrets/old-master-key
   ```

   It prints how many secrets it re-encrypted, the new key version and the new key's fingerprint.
5. Start web and worker. Then remove the old key from wherever you passed it; it opens nothing any more.

Running the command again after it finished changes nothing. It refuses a new key the Install used before, and an old key that isn't the current one. Web or worker left running with the old key can no longer read or write secrets, and both refuse to start again until they have the new key, naming the key version they need.

### When the Master key is lost

Secrets can't be recovered without their Master key, and web and worker refuse to start with any other key while secrets exist. To start again with a new key, deleting every secret:

1. Make a new key with `openssl rand -base64 32` and put it in `WEBCRAFT_SECRET_KEY`.
2. `webcraft admin rotate-key --old-key-lost` lists the secrets that would be deleted and the lost key's version and fingerprint, and changes nothing. If you still have the old key, or mistyped the new one, stop here and rotate normally.
3. `webcraft admin rotate-key --old-key-lost --confirm-fingerprint <first 12 characters of that fingerprint>` deletes them and makes the new key the next key version. Typing the fingerprint proves you read the listing for this Install; a bare "yes" would not. It refuses when `WEBCRAFT_SECRET_KEY` is still the current key.
4. Start web and worker, and set the listed secrets again.

## Signing in and the setup wizard

- **`@webcraft/auth`** is the only way into sign-in: `services.auth.signIn`, `session(headers)`, `signOut`, `createPerson` (inside the caller's transaction). Better Auth 1.7.18 (pinned in the root `package.json` catalog) sits behind it in `packages/auth/src/auth.ts`; no other package imports it. Its own HTTP endpoints are not served: WebCraft's procedures call it. When you upgrade it, read its security advisories and keep the version exact.
- **People** are the `people` table; their password hash is a row in `credentials`. Install-level roles are text keys in `install_roles` (`superadmin` and `staff`, ADR 0028; see "Tenancy and permissions"). Emails are stored in lower case.
- **Passwords** need at least 12 characters (`assertNewPasswordAllowed`). Extra checks, such as the leaked-password lookup, plug in as `passwordChecks` in `createAuth`.
- **Sessions** end after 7 days unused and 30 days after sign-in, by WebCraft's clock (`services.clock`), so tests move them with `install.clock.advance`. A session in use is renewed at most every 10 minutes. The cookie is `HttpOnly`, `SameSite=Lax` and `Secure` (except on a `.localhost` development host), signed with a key derived from the Master key: a new Master key signs everyone out.
- **The setup token**: while the Install has no Superadmin, every start of the web process prints a new one-time token and a `setupUrl` in the log (`warn`, fields `setupToken` and `setupUrl`). Only its SHA-256 hash is stored; the last 10 printed stay valid. Claiming the Install with one creates the Superadmin and deletes every token. Creating the Superadmin is serialised with a Postgres advisory lock, across processes.
- **`webcraft admin create-superadmin <email> [--name <name>] [--language <en|it>]`** does the same headless: the password is asked twice on a terminal, or read from the first line of standard input (`printf '%s\n' "$PASSWORD" | webcraft admin create-superadmin ops@agency.example`); it is refused on the command line. It needs the Install's environment (`DATABASE_URL`, `WEBCRAFT_ADMIN_HOST`, `WEBCRAFT_SECRET_KEY`) and finishes setup, so the wizard never opens.
- **Setup stages** (`services.setup.stage()`): `claim` (no Superadmin: the wizard asks for the token), `continue` (the Superadmin exists and goes through the wizard's remaining steps, signed in), `done` (the wizard answers 404 for good).
- **The Master key banner** shows to the Superadmin until they confirm the running Master key is stored outside the server. The confirmation stores who, when and the key's fingerprint, and is logged; with another key the banner returns.

## The admin

The admin is a TanStack Start app in `apps/server/src/routes` (file routes) and `apps/server/src/ui` (everything else). It reads and changes data only through the Management API: `getApi()` (`ui/api.ts`) calls the procedures in-process while a page renders on the server, and `/api/rpc` in the browser.

- **Shell context**: the root route loads `shell.context` on every navigation (who is signed in, Admin language, theme, setup stage, banners); routes read it with `Route.useRouteContext()`. After a change that affects it, call `router.invalidate()` or navigate.
- **Text**: every word people see comes from `apps/server/src/messages/en.json` and `it.json`, through `useT()` (`t("shell.nav.overview")`, with ICU placeholders such as `{name}`). Add each key to both files; a missing key fails the typecheck, and `tests/i18n/admin-messages.test.ts` checks that every language has every key with the same placeholders. Page titles come from `pageTitle(language, key)` in the route's `head`.
- **Right to left**: `<html lang dir>` follows the Admin language (`ADMIN_LANGUAGES` in `@webcraft/core/admin-languages`). Use logical classes (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`, `border-s`) and flip direction icons with `rtl:rotate-180`.
- **Light and dark**: `<html class="light|dark">` when a person chose, no class to follow the device (`prefers-color-scheme`); the `dark:` variant and the colour variables in `packages/ui/src/styles/globals.css` handle all three.
- **Levels and the sidebar**: `ui/shell/levels.ts` holds each level's sidebar groups and items (`label`, `icon`, `to`, `requires`: the Permission that shows it). The levels are the Install, a Workspace and a Site: pages under `routes/_admin/workspaces.$workspaceId.tsx` are at the Workspace level and pages under `routes/_admin/sites.$siteId.tsx` at the Site level. Those two routes load the Workspace or Site and the person's Permissions there, and set `place` in the route context; the sidebar, the breadcrumbs (the Workspace's and Site's names first) and the context switcher read it. A page reads `Route.useRouteContext().place.permissions` to decide what to offer, never a role name. A page sets its breadcrumb with `staticData: { crumb: "<message key>" }`.
- **Pages** inside the shell are routes under `routes/_admin/` (signed in only). Start a page with `PageHeader`; use the shadcn components from `@webcraft/ui/components/*`.
- **The setup wizard's steps** are the list in `ui/setup/steps.tsx`: each has a title, a hint, a stage and a panel. After `two-factor` comes `email` (the Install SMTP, which can be skipped); the Modules step goes after it, as a `continue` step. The last step finishes setup.
- **Times** are shown in UTC with `formatUtc`, and days with `formatUtcDate` (`ui/format.ts`), in one fixed form: the server renders pages first, and its date formatting differs from the browser's in small ways, which breaks hydration.
- **shadcn components** come from preset `b1Fk3bmIS` (`style: base-vega`, zinc, RTL on, see `packages/ui/components.json`). Add one with `bunx shadcn add <name>` in `packages/ui`, then run `bun run lint`: generated code sometimes fails the accessibility rules; fix the component (several are marked `WebCraft:`) rather than switching a rule off, and give every visible or screen-reader string a prop so it can be translated.

## Testing

Tests live in `tests/`, grouped by area, and run with `bun test` from the repo root. They test at the spec's seams and check what a person, visitor or client would observe: HTTP responses, emails that went out, outgoing calls, job outcomes and later responses. They never import internal functions or read tables directly; refactoring without changing behaviour must not break a test.

**Seam 1** is the web process's handler, booted in-process against a real Postgres. `createTestInstall()` from `tests/harness/index.ts` gives each test file its own Install:

| Part | What it does |
| --- | --- |
| `install.secrets` | Every secret of the Install (`set`, `useWith`, `describe`, `remove`), for any owner, encrypted under its Master key: for tests of the secret store. WebCraft's own code reaches a Workspace's or Site's secrets through the data layer. |
| `install.env` | The environment a real process needs to run as this Install: `DATABASE_URL`, `WEBCRAFT_ADMIN_HOST` and `WEBCRAFT_SECRET_KEY`. |
| `install.request(url, init)` | Sends a standard `Request` through the handler, in process. Always use a full URL: the hostname decides where it goes. `install.adminUrl("/healthz")` builds admin-host URLs (`https://admin.test/...`); a Site's Staging address is `https://<slug>.sites.test` (`sites.get` answers it as `stagingUrl`). |
| `install.browser()` | A person's browser on the admin: it keeps cookies and sends the admin's origin. `browser.api` is the typed Management API client (`await browser.api.session.current()`); errors reject with their API `code`. `install.browser({ origin })` sends requests from another site's pages. |
| `install.createSuperadmin(account?)` | Creates the Superadmin as `webcraft admin create-superadmin` does and answers the account (email, password `TEST_PASSWORD`). |
| `install.superadmin()` | A browser signed in as the Superadmin (made first when there is none). |
| `install.createWorkspace(name?)`, `install.createSite(workspaceId, { name?, slug? })` | A Workspace or Site, created by the Superadmin through the API. |
| `install.createStaff({ workspaces })` | A Staff member, the way people become one: invited, then accepting the link in the email. Answers `{ account, personId, browser }`. |
| `install.createMember({ workspaceId, role, sites? })` | A Member with a Membership, signed in. Until Member invites exist it gives the Membership directly (`install.addMembership` for an existing person). |
| `install.signIn(account)` | A new browser, signed in. |
| `install.setupToken()` | The setup token the web process printed when it last started (the harness starts like the web process, printing one while there's no Superadmin). |
| `install.jobs.send(job, payload)` | Enqueues a job as the web process would. |
| `install.drainJobs()` | Runs every job that is due by the test clock, including jobs those jobs enqueue and scheduled jobs whose time came, and returns `{ completed, failed }`. |
| `install.lastEmailTo(address)` | Runs the due jobs, then answers the newest email to the address: sent through the Install SMTP or, while it isn't set, written to the log (`{ to, subject, text }`). `inviteLinkIn(email)` finds an invite link in one. |
| `install.sendSystemEmail(email)` | Sends a System email as WebCraft's features do (`services.email.send`); drain the jobs to send it. |
| `install.mail` | The fake Mailer: `sent` holds every email the server took (with the `smtp` settings it went through, password included), `attempts` every try; `fail(response)` makes every send fail with that answer until `accept()`; `rejectRecipient(address)` refuses one address for good; `clear()` forgets them. |
| `install.http` | The fake outgoing HTTP: `respond(method, url or RegExp, { status, body, headers } or a function)`; `requests` holds every call. A request nobody prepared an answer for fails like an unreachable server. |
| `install.clock` | Time stands still until `advance(ms)` or `set(date)`. The job queue reads the same time inside Postgres, so a job sent with `startAfter` in an hour runs only after `advance` passes it, and retries wait for their delay. `advance` jumps like a process that slept, so moving days ahead is quick. Sessions expire by this clock too. Starts at `2026-03-02T09:00:00Z` unless you pass `{ now }`. |
| `install.logs` | Every log entry the Install wrote. |
| `install.restart({ masterKey? })` | Starts the Install again, as web and worker do (with another Master key when given), running their start-up checks and printing a new setup token while there's no Superadmin. |
| `install.close()` | Stops the Install and drops its database. |

`createTestInstall({ database: "empty" })` gives an Install whose database nobody migrated, and `{ database: "unreachable" }` one whose database doesn't answer. Every test Install starts with the Master key `TEST_MASTER_KEY` unless you pass `{ masterKey }`; tests never use the key in `.env`. Its sites domain is `sites.test` (`TEST_SITES_DOMAIN`) unless you pass `{ sitesDomain }` (`null` for none), and its admin host `admin.test` unless you pass `{ adminHost }`.

`tests/harness/trees.ts` writes element trees briefly: `tree(element("article", [element("h1", [value("title")])]))`, `text("…")`, and attributes as `element("a", [text("More")], { href: [{ type: "text", text: "/blog/" }, value("slug")] })`. `tests/sites/first-site.test.ts` shows a whole Site: Post Type, Entry template, Entry, publish, the rendered page and the page cache.

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

`tests/worker/sample-job.test.ts` shows the job drain, the fake outgoing HTTP and the clock; `tests/email/` shows the fake mailer and `install.sendSystemEmail`; `tests/web/health.test.ts` shows the database modes. Tests in one file share their Install, so give each test its own data (its own Workspace, its own email address) or create an Install per test when they must not see each other. `tests/worker/node-worker.test.ts` starts the real worker with `node`, the way to check something runs on Node; give it `install.env`. It also sends a System email with the real Mailer to `startSmtpServer()` (`tests/harness/smtp-server.ts`), a real SMTP server in the test process, which the browser tests use too (the production web process sends test emails with the real Mailer). Start a real `bun` process (the CLI, the web entry) in an empty directory when a test leaves a setting out on purpose: Bun fills missing variables from the `.env` in the directory it starts in (see `tests/secrets/start-refusal.test.ts`).

**Workspace isolation**: every procedure that takes a `workspaceId` or `siteId` gets one line in `tests/isolation/procedures.test.ts`, proving it works on the caller's own Workspace and refuses another's (404 or 403). The last test there fails when a procedure is missing:

```ts
isolation.refuses("sites.list", (api, { workspaceId }) => api.sites.list({ workspaceId }), { as: ["staff", "editor"] });
```

`as` names who calls it (Staff assigned to that one Workspace by default, or a Member of it). The helper is `workspaceIsolation` in `tests/harness/isolation.ts`.

**Seam 2** is a real browser, for accessibility (and later the editors). `tests/browser/harness.ts` starts a test Install served by the production web process (`bun run build` first) on `http://admin.localhost:<port>`, and Chromium through Playwright; `tests/browser/checks.ts` holds the checks; files are named `*.browser.ts` so `bun test` leaves them out, and `bun run test:browser` runs them. Every check runs with the device set to light and to dark (the admin follows the device).

- `expectAccessibleScreen(page, where)`: axe-core finds no violation of WCAG 2.0, 2.1 or 2.2 at A or AA, nor of its best practices; the first Tab reaches "Skip to main content" and following it moves focus to `<main>`; Tab visits every link, button and field in page order, each with a visible focus indicator; no positive `tabindex`; Tab always moves on (no traps); the page logged no errors.
- `expectOverlayUsable(page, trigger, "menu" | "dialog", where)`: opens a menu or dialog from the keyboard, checks it with axe, and Escape closes it with focus back on the trigger.

`startBrowserInstall()` also gives the test Install behind the web process (`browserInstall.install`), to prepare data through the Management API, send System emails and drain jobs before the page opens (see `tests/browser/email.browser.ts`).

**Adding a screen** is one line in `tests/browser/screens.ts`: its name, its path and who looks at it (`superadmin`, `staff` or `signed-out`). A screen inside a Workspace or Site gives its path as a function of the shared fixture (`({ siteId }) => `/sites/${siteId}``); prepare more data in `admin-screens.browser.ts` through `install.install`, the same Install in the test process. For a state a path can't reach (a wizard step, an error shown, an open menu), write a test like `tests/browser/setup-wizard.browser.ts`: drive the page there with Playwright, then call `expectAccessibleScreen` or `expectOverlayUsable`. Don't retest behaviour seam 1 covers.

```ts
export const ADMIN_SCREENS: readonly Screen[] = [
	// ...
	{ name: "Site › Overview", path: ({ siteId }) => `/sites/${siteId}`, as: "staff" },
];
```

## Conventions

- **Words**: use `GLOSSARY.md` terms exactly, in code, tests, UI text and commits. British spelling in prose ("licence", "normalise").
- **TypeScript**: strict, with explicit `.ts`/`.tsx` extensions on relative imports and only erasable syntax (no `enum`, `namespace` or parameter properties). That lets Node run shared code and the worker without a build step.
- **Runtimes** (ADR 0006): `packages/*` and `apps/worker` use standard Web and Node APIs only; Biome rejects the `Bun` global and `bun:*` imports there, and their tsconfigs don't load Bun's types. `apps/server`, `apps/cli`, `tests` and `scripts` may use Bun.
- **Edges go through ports**: time through `Clock`, email through `Mailer` (only the email sender calls it; features send System emails with `services.email.send`), calls to other servers through `services.http`. Tests replace them with fakes; nothing else is faked.
- **Secrets** go through `services.secrets` only: never in another table, a log line, a job payload or a response (see "Secrets and the Master key").
- **Workspace data** goes through the data layer (`services.data`), which runs `can()` first (ADR 0007); no query on tenant data without a Workspace, and no check of a role name: check a Permission.
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
- **Accessibility (browser)**: builds the admin, installs Playwright's Chromium and runs `bun run test:browser`.
- **Reference-material denylist** over tracked files, the commit messages being added and the branch name, with the list from the `REFERENCE_DENYLIST` repository secret. It fails when the secret is missing, as it is for pull requests from forks.
