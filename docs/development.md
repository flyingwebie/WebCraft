# Development

How to run WebCraft locally, how the code is laid out, how to test it, and the conventions every change follows. Terms follow `GLOSSARY.md`; decisions are in `docs/adr/`.

## Layout

A Bun-workspaces monorepo, scaffolded once with Better-T-Stack (TanStack Start, oRPC, Better Auth, Postgres + Drizzle, Biome, Turborepo) and reshaped to the spec's layout.

| Path | What it is | Runs on |
| --- | --- | --- |
| `apps/server` | The web process. One request handler routes every request by hostname: the admin host to the admin side (the TanStack Start admin, `/healthz`, `/readyz`, the Management API at `/api/rpc`, later `/api/v1`, `/mcp`, OAuth and the Caddy ask endpoint), every other hostname to the Site pipeline. | Bun 1.4 |
| `apps/worker` | The worker: runs pg-boss jobs. | Node LTS |
| `apps/cli` | The `webcraft` command (`webcraft admin migrate`, `rotate-key` and `create-superadmin` for now). | Bun |
| `packages/core` | Domain modules (the permission check and the list of Sensitive actions, the tenant data layer, Workspaces, Sites, Staff, the Audit log, the content store and publishing, the Site side of rendering, secrets, setup, people and their own account, Install settings, rate limits, the Master key banner, email) and the ports every process shares: `Clock`, `Mailer`, outgoing HTTP, `Logger`, job definitions, `InstallServices`. | both |
| `packages/db` | Postgres: Drizzle schema and migrations, connections, the migrate step, the schema check, the pg-boss job queue. | both |
| `packages/auth` | WebCraft's auth interface (`Auth`): signing in and out, sessions, the recent identity check, lockout, creating people, password rules and the leaked-password check. Better Auth sits behind it; no other package imports Better Auth. | both |
| `packages/api` | The Management API: oRPC procedures, served to the admin at `/api/rpc`. | both |
| `packages/mcp` | The MCP server, generated from the API (placeholder). | both |
| `packages/renderer` | Element trees (the stored form of Templates), Template markup (their lossless text view: parse, check, print), Conditions' expressions, formatters, the rich text cleaner and the renderer that turns trees into HTML. It reads nothing itself. | both |
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
| `bun run test` | Every seam-1 test, each allowed 30 s. `bun run test tests/web/health.test.ts` runs one file; `bun run test -t "readyz"` filters by name. Use `bun run test` rather than a bare `bun test`: Bun ignores a timeout in `bunfig.toml`, so a bare `bun test` gives every test only 5 s and fails on a busy machine. |
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
- **The client address** of a request comes from one function, `clientAddress(request, config)` in `apps/server/src/client-address.ts`: for now the address of the connection itself (`serve.ts` sets it from Bun's server, the development server sets it the same way). Rate limits, lockout records and the sessions list take it from there and nowhere else; `X-Forwarded-For` and similar headers are ignored until trusted proxies (`WEBCRAFT_TRUSTED_PROXIES`) are added, which changes only that function. Procedures get it as `context.clientAddress` (null when the web process can't tell).
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
- **Nobody grants more than they hold**: `holdsAccess(actor, workspaceId, { role, sites })` answers whether an actor holds at least the access a Membership gives: every Permission of the role on the Workspace, and on every Site it reaches (`"all"` means every Site, including later ones, so only someone reaching every Site holds it). Inviting a Member or changing a Member's access needs it for the new access; changing or removing a Member, or resending or revoking their invite, needs it for the access they have now. It compares Permission sets, never role names.
- Staff never hold a Membership: a Staff invite refuses an address someone already signs in with, a Member invite refuses Staff and the Superadmin, and `services.memberships.add` refuses Staff, the Superadmin and a second Membership in the same Workspace.

### The tenant data layer

`services.data` (`packages/core/src/tenancy/data-layer.ts`) is the only way to tenant data. It opens a scope after checking the Permission, and a scope's queries are limited to its Workspace (and Site):

```ts
const site = await services.data.site(access, siteId, "entry.publish"); // can() runs here
const drafts = await site.select(entries, eq(entries.status, "draft")); // only this Site's rows
const entry = await site.insert(entries, { title, createdAt: site.now() }); // fills workspace_id and site_id
await site.audit("entry.publish", { entryId: entry.id }); // who, when, how, Workspace and Site filled in
```

- `services.data.install(access, permission)`, `.workspace(access, workspaceId, permission)` and `.site(access, siteId, permission)` open the three levels. A Workspace or Site the actor can't see answers `WorkspaceNotFoundError` / `SiteNotFoundError` (404), one they see without the Permission `PermissionDeniedError` (403), so nobody learns what exists outside their reach.
- A Workspace scope works on **Workspace tables** (a `workspace_id` column); a Site scope on **Site tables** (both `workspace_id` and `site_id`, with a composite foreign key to `sites (workspace_id, id)` so a row can never point at another Workspace's Site). Module tables follow the same rule. A Workspace table may also name one of its Workspace's Sites (`membership_sites`, `invite_sites`): a Workspace scope's `insert` fills in only `workspace_id`, and the same composite foreign key keeps the Site in the Workspace.
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
- A Sensitive action adds `.use(sensitive("<action>"))` after its permission check (see "Sensitive actions" below).
- A procedure that checks a password, a setup token or an invite link starts from `authEndpoint` (or adds `.use(rateLimited("auth"))`): it is rate-limited per client address.

### Sensitive actions

A Sensitive action (`GLOSSARY.md`) needs a password, passkey or 2FA check within the last 10 minutes, in the admin session the request comes with, and is never available to API tokens or OAuth grants (ADR 0030).

- **The list** is `SENSITIVE_ACTIONS` in `packages/core/src/permissions/sensitive.ts`, one place for every Sensitive action with the reason it is one. So far: `installSmtp.change`, `staff.invite`, `staff.changeWorkspaces`, `member.invite`, `member.changeAccess`, `member.remove`, `masterKey.confirmStored`, `password.change` and `leakedPasswordCheck.change`.
- **The gate** is the `sensitive(action)` middleware (`packages/api/src/context.ts`), which calls `assertSensitiveActionAllowed(access, action, now)` from core. Put it after the permission check, so nobody is asked to confirm something they may not do:

  ```ts
  invite: onInstall("staff.manage").use(sensitive("staff.invite")).input(…).handler(…),
  ```

  It answers `IDENTITY_CHECK_REQUIRED` (403, `data.action`) when the session's last check is older than 10 minutes, and `SENSITIVE_ACTION_REFUSED` (403) for anything that isn't a person's admin session: only `signedIn` gives `access.identityCheckedAt`, so later actor kinds (API tokens, OAuth grants, Modules) are refused without a change here. Its type needs `context.access`, so it can't be put on a procedure that has no signed-in person.
- **The check**: signing in counts as one; `session.confirmIdentity({ password })` makes a fresh one for this browser's session only (wrong passwords count towards lockout). Later sign-in factors (passkeys, 2FA) add their own ways to confirm in `@webcraft/auth`, recording the check the same way.
- **In the admin**, run the call through `useSensitiveAction()` (`apps/server/src/ui/identity-check.tsx`): on `IDENTITY_CHECK_REQUIRED` it opens "Confirm it's you", then tries the call again; closing the dialog rejects with `IDENTITY_CHECK_CANCELLED`, which `errorMessage` shows like any refusal.

  ```ts
  const runSensitive = useSensitiveAction();
  await runSensitive(() => api.staff.invite({ email, workspaces }));
  ```

- **Adding one** (member invites and role changes, 2FA changes, Impersonation, API tokens, deleting a Site or Workspace, a Site's secrets): add it to `SENSITIVE_ACTIONS`, mark its procedure with `sensitive("<action>")`, wrap the admin's call in `useSensitiveAction`, and add its row to `tests/auth/sensitive-actions.test.ts`: one call that takes the action as the Superadmin. That file checks each row is refused without a recent check and allowed after one, and its last test fails while an action in the list has no row. The MCP server and the CLI leave Sensitive procedures out.

### The Audit log

The Audit log is one append-only table (`audit_log`; triggers refuse updates and truncation). `recordAudit` (`packages/core/src/audit.ts`) is the only function that writes it; code calls it through `scope.audit(action, details)`, which fills in who, when, how (`via`), the Workspace and the Site. An Install scope's `audit` takes the Workspace (and Site) the action concerns as a third argument, a Workspace scope's the Site.

- **Actions** are `<noun>.<verb>`: `install.claim`, `superadmin.create`, `masterKey.confirmStored`, `workspace.create`, `site.create`, `staff.invite`, `staff.revokeInvite`, `staff.join`, `staff.changeWorkspaces`, `member.invite`, `member.resendInvite`, `member.revokeInvite`, `member.join`, `member.changeRole`, `member.changeSites`, `member.remove`, `postType.create`, `postType.update`, `entry.publish`, `entry.delete`, `template.publish`, `globals.update`, `globals.publish`, `homePage.change`, `notFoundPage.change`, `installSmtp.change`, `leakedPasswordCheck.change`, `password.change`, `session.revoke`, `session.revokeOthers` and `account.lock`. Saving a Draft isn't logged; publishing and deleting are. Install-level actions about a person's own account (their password, their sessions) are recorded with the core function `recordAudit` and no Workspace; `account.lock` has no person who acted (WebCraft locked it) and names the locked person in its details.
- **How** (`AuditVia`): `admin` for `/api/rpc`, `command` with the command's name for `webcraft admin …`. Later kinds: Edit mode, an API token's name, an AI client's name, a Module, Impersonation.
- **Details** are plain JSON about what changed (a name, an email address); never a secret's value.
- `audit.list` gives the Superadmin the newest entries; the screens and the Staff and Owner views come with the Audit log screens.

### Staff and invites

The Superadmin invites Staff by email (`staff.invite`), to all Workspaces (including later ones) or chosen ones. The invite is the `staff-invite` System email (see "Email"), in the Install's default Admin language, with a link to `/invite?token=…` that works once, for 7 days; only the token's hash is stored. Inviting the same address again replaces the invite. Accepting creates the account with the role and its Workspaces, records `staff.join`, and signs the person in.

### Members and invites

Members are the client's people in one Workspace (`packages/core/src/tenancy/members.ts`, procedures in `packages/api/src/procedures/members.ts`). Each holds one Membership: a Workspace role (`owner`, `editor`, `author`) and every Site of the Workspace or chosen ones. One person has one account, with at most one Membership per Workspace.

- **Permissions**: `member.invite` invites Members and resends or revokes their invites; `member.manage` opens the Members screen, changes a Member's role and Sites, and removes them. Staff and Owners hold both; Editors and Authors neither. Within those, `holdsAccess` (above) limits what each person may give or touch: an Owner reaching some Sites offers only those Sites, never "All Sites", and can't change or remove a Member who reaches more.
- **Inviting** (`members.invite`): the invite is a row in `invites` with the Workspace (`workspace_id`), the role, and `all_sites` or the Sites in `invite_sites`. It is the `member-invite` System email, in the person's Admin language when the address already has an account (the Install's default otherwise), with the same one-time, 7-day `/invite?token=…` link as Staff invites. Inviting the address again into the same Workspace replaces the invite; `members.resendInvite` sends a new link valid for 7 more days, and the earlier link stops working.
- **Accepting**: `invites.get` says whether the address already has an account. Without one, `invites.accept` creates it (password rules as everywhere) with the Membership and signs the person in; with one, the person signs in with that address and `invites.join` adds the Membership. Both record `member.join`. A Member invite to Staff or the Superadmin, or to a Member of the Workspace, is refused when it is sent.
- **Changing and removing** (`members.changeAccess`, `members.remove`): the change is read on the Member's next request, like every change to someone's access (`signedIn` loads the actor fresh), so sessions already open lose access at once. Removing keeps the person's account and their Memberships elsewhere. Role and Site changes are recorded as `member.changeRole` and `member.changeSites`, with the old and new values.
- **The Members list** (`members.list`) names only the Sites the viewer can see (`otherSites` counts the rest), lists the Staff assigned to the Workspace (read-only: the Superadmin manages Staff), and gives `offer`: which roles the viewer may grant, and on which Sites.

## Content and publishing

The content store is `packages/core/src/content/`, behind `services.postTypes`, `services.entries`, `services.globals`, `services.templates`, `services.pages` and `services.publishing`. Its tables (`post_types`, `entries`, `published_slugs`, `entry_links`, `globals`, `templates`, `special_pages`) are Site tables.

- **Post Types** are Structure without a Draft: `create`, `update`, `list`, `get`. Each has a `key` (`blog`, made from the name when not given; it never changes), a `name`, a URL pattern and its Fields, in order. Changing one applies at once and clears the Site's page cache. Every Site also has the built-in **Page Post Type** (`builtIn: "page"`, see "Pages"); Staff made the rest (`builtIn: null`).
- **URL patterns** (`content/url-patterns.ts`) are fixed path parts (lower-case letters, digits, dashes) and exactly one `{slug}`: `/blog/{slug}`, `/{slug}`. When several patterns match a path, the most specific is tried first (a fixed part beats `{slug}` at the first place they differ). A pattern **owns** every path it matches (`/blog/{slug}` owns `/blog/<anything>`, not `/blog` itself), and Pages live outside every pattern, so a path never belongs to both: publishing a Page (or moving one) onto a path a pattern owns, and creating or changing a pattern that would own a published Page's path, are refused with `PATH_TAKEN` (409, `data: { path, by }`, `by` naming the Post Type or the Page). The Site pipeline tries the patterns first, then Pages.
- **Built-in Fields** every Entry has: `title`, `slug` (both translatable, stored like Fields), `status`, `author`, `createdAt`, `updatedAt` (Draft saved), `publishedAt` (first publish) and `lastPublishedAt`. A Post Type lists them as `builtInFields`.
- **Entries** keep two versions side by side in `entries.draft` and `entries.published` (null until the first publish). `status` is worked out: `draft` (never published), `published`, `changed` (the Draft differs). Each Entry the API answers also carries `problems` (what keeps its Draft from being published, see "Values and validation") and `linkedFrom` (see "Relationships").
- **The Draft is written in one place**: `changeDraft` in `content/entries.ts`, which `entries.create`, `entries.saveDraft` and deleting a linked Entry go through, with the Entry row locked. Co-editing (#71, ADR 0025) replaces it with changes to the Draft's shared document; nothing else writes `entries.draft`. The Globals' Draft is written only by `saveGlobalsDraft` in `content/globals.ts`.
- **Slugs**: made from the title when not given (accents dropped, `crème brûlée` gives `creme-brulee`), unique within the Post Type (`-2`, `-3`, …; for a Page, among the Pages under the same parent), and never changed by a new title, before or after publishing. A slug another Entry of the Post Type has, in its Draft or published, is refused (`ENTRY_SLUG_TAKEN`). `published_slugs` holds each Entry's published slug per language (and a Page's published parent), so the Site finds an Entry by URL with one indexed lookup.
- **Paths**: every Entry the API answers carries `path`, where visitors find it once published (`/blog/fresh-bread`, `/about/team`, `/` for the home page), null before.
- **Templates** (`content/templates.ts`) are `templates` rows holding element trees in `draft` and `published`, of two kinds so far: the **Site template** (`site`, one per Site, see "The Site template") and **Entry templates** (`entry`, one per Post Type). Saves and publishes check a tree against what its kind may hold (`TemplateTarget`, `rulesFor`). An Entry template may read the built-in Fields, the Post Type's Fields and their parts, and the Globals (see "What a binding reads"), and holds neither `<main>` nor `{{@outlet}}` (both belong to the Site template around it). The Page Post Type has no Entry template (`PAGES_HAVE_NO_ENTRY_TEMPLATE`): Pages are arranged with a Page layout. Archive templates become another kind.

### The Site template

Each Site has one Site template (Structure, `structure.edit`), which wraps every page: its header, its footer and, in between, the page's content at `{{@outlet}}`. Until the Site publishes one, every page gets the plain built-in one (`BUILT_IN_SITE_TEMPLATE`: `<main>{{@outlet}}</main>`).

- **What it holds** (`checkSiteTemplate`, `packages/renderer/src/page-structure.ts`): exactly one `<main>`, with only `<div>` elements around it (so it stays a landmark of its own) and no Template command (every page has it), without an `id` or `tabindex` (WebCraft writes those); inside it exactly one `{{@outlet}}`, not inside a Template command either (every page shows its content once). Each problem is reported where its node is (line and column in markup, `nodes[0].children[1]` in a tree).
- **What it reads**: the Globals as `site.x` (it wraps every page, the 404 page too, so no Entry's values). It is checked again on publish, since a Global it reads may have gone.
- **API**: `templates.getSiteTemplate`, `saveSiteTemplate` (a tree), `getSiteTemplateMarkup`, `saveSiteTemplateMarkup` (Template markup), each taking `siteId` and answering as their Entry template counterparts do; `templates.publish` publishes it. In core, `services.templates.siteTemplate`, `saveSiteTemplate`, `siteTemplateMarkup`, `saveSiteTemplateMarkup`.

### Pages

Pages (`content/pages.ts`) are the Entries of the built-in Page Post Type, which every Site gets when it is made (`addPagePostType`; a custom migration gave Sites made earlier theirs). Its key is `page`, its URL pattern is `/{path}` (not one Staff can write: a Page's path is its parent's path and its own slug) and it can't change; its name and Fields can. Its built-in Fields add `parent` (`PAGE_BUILT_IN_FIELDS`), a key its own Fields can't take.

- **Nesting**: `entries.create` and `entries.saveDraft` take `parentId` (null for the top level; only Pages have one). The parent is stored in each version beside `title` and `slug`, as one value shared by every language (`parentIn`, `withParent`), and shows as `parentId` in the Entry's Draft and published values. It must be another Page of the Site, never the Page itself or a Page under it, at most `MAX_PAGE_DEPTH` (10) deep (`ENTRY_INVALID` at `parentId`).
- **Publishing** moves a Page, with every Page under it: its published path becomes its published parent's path and its slug. The parent must be published (`PAGE_PARENT_UNPUBLISHED`, 409), the published Pages can't loop, the Pages under it still nest at most 10 deep, and no path may be one a URL pattern owns (`PATH_TAKEN`). A Draft move changes nothing visitors see.
- **Finding one**: the Site pipeline walks the path one part at a time through `published_slugs` (`findPublishedPage`).
- **Rendering**: a Page's content is its Page layout, the Components placed in its content area (#63, #75); until then it is empty, and a Page shows its title and the Site template around an empty `<main>`.
- **Deleting** a Page with Pages under it, in their Drafts or published, is refused (`PAGE_HAS_CHILDREN`, 409, `data.children`).
- **The home page and the 404 page** (`content/special-pages.ts`, table `special_pages`, one row per job): Staff choose them with `pages.setHomePage` and `pages.setNotFoundPage` (`structure.edit`; `pageId` null for none; anything but a Page of the Site is `PAGE_NOT_FOUND`); everyone who sees the Site reads them with `pages.settings`. A change applies at once (it clears the page cache) and is logged as `homePage.change` or `notFoundPage.change`. A Page that isn't published yet can be chosen and shows once it is. The home page answers at `/`, and its own path redirects there (301). Deleting a chosen Page gives its job up. Per-language 404 pages come with the Site's languages (#80).

### Field types

Every Field type lives in one registry, `FIELD_TYPE_SPECS` in `content/field-types.ts`: each type reads its own settings, checks and reads its values, and lists the rules a value breaks. Add a type there (#73 fills in the media Field's values, #78 adds the Body field); `content/fields.ts` checks definitions and `content/field-values.ts` walks values, both through the registry.

Every Field is `{ key, label, type, help, required, translatable, default }` plus its type's settings (the API answers every setting, null when unset):

| Type | Value (as the API gives it) | Settings |
| --- | --- | --- |
| `text` | text, trimmed (at most 2,000 characters) | `minLength`, `maxLength`, `pattern` |
| `richText` | HTML, cleaned on save (see "Rich text") | `maxLength` (characters of text) |
| `number` | a number | `min`, `max`, `integer` |
| `boolean` | `true` or `false` (unset reads `false`; can't be required) | |
| `date` | `2026-03-02`, `09:30` or `2026-03-02T09:30:00Z` (an offset is turned into UTC) | `mode` (`date`, `time`, `dateTime`), `min`, `max` |
| `select` | an option's value, or a list of them | `options` (`{ value, label }`), `multiple`, `min`, `max` (with `multiple`) |
| `media` | nothing until the Media library (#73) | |
| `link` | `{ url, text }`; the URL is an http, https, mailto or tel address, a path or an `#anchor` | |
| `email` | an address, in lower case | `pattern` |
| `relationship` | an Entry id, or a list of them | `postTypes` (keys), `multiple`, `twoWay` (default `true`), `min`, `max` (with `multiple`) |
| `group` | its Fields' values, by key | `fields` |
| `repeater` | a list of rows, each `{ id, …its Fields' values }` | `fields`, `min`, `max` (rows) |

- **Keys** start with a lower-case letter, then letters, digits and underscores, and never change, so values and bindings follow them. A Post Type's Field can't take a built-in Field's name, one Template markup reads from (`site`, `props`, `item`, `url`, …) or a word Conditions use (`and`, `or`, `not`, `true`, `false`); inside a Group or Repeater only `id` and those words are kept. A Field keeps its type, inside Groups and Repeaters too.
- **Groups and Repeaters** nest 3 deep at most, with at most 200 Fields in all. They hold no language and can't be translatable themselves: their Fields are, one by one.
- **Translatable**: text, rich text and link Fields are by default; number, true/false, date, select, media and email only when chosen; Relationships, Groups and Repeaters never (ADR 0003).
- **Defaults** fill a new Entry's Fields (and a new Repeater row's), and a Global added with one starts the Globals' Draft with it. Fields added to a Post Type later don't change existing Entries. Media, Relationship, Group and Repeater Fields have none (a Group's Fields have their own). A default must keep its Field's rules.
- **`pattern`** is a regular expression the whole value must match, as an HTML `pattern` attribute reads it (so the admin can use it as is). Patterns are Staff's input and run on every save, list and publish, so they run on a linear-time engine (RE2, through `re2js`): no pattern can keep the web process busy, whatever its shape (`(a+)+b` is as quick as `[a-z]+`). The engine has no look-around and no back-references, so patterns using them are refused when the Field is defined.

### Values and validation

Values are stored per key and per language, inside each version (ADR 0003): a leaf Field's values as `{ <language>: { value, by } }`, where `by` is who wrote it (a person; AI translation joins later); a Group's as `{ values: { … } }`; a Repeater's as `{ rows: [{ id, values: { … } }] }`, so rows are the same in every language and each Field in them falls back to the Default language one at a time. A shared Field keeps one value under the Default language. Sites have one language (`sites.default_language`, `en`) until #80, so only the Default language can be written yet.

- **Saving** (`create`, `saveDraft`, `globals.saveDraft`) gives Fields by key; only those given change. A Group's value is its Fields by key (again only those given change; `null` clears them all); a Repeater's is its whole list of rows: a row with an `id` it had keeps that row and its values in other languages, changing what is given; a row without one (or with a new one) is new and starts with the defaults; rows left out are removed. `null` or `""` clears a value.
- **The wrong kind of value is refused** with `ENTRY_INVALID` (`GLOBALS_INVALID`) and `data.problems`, each at its path: `fields.price`, `fields.address.city`, `fields.team[1].name`, `fields.team[1].id`. A Relationship pointing at an Entry that isn't one of its Post Types' on this Site is refused the same way.
- **Broken rules and empty required values are kept** in the Draft, so autosave and Co-editing never lose what someone typed, and are listed in the Entry's (or the Globals') `problems`, each with its `rule` (`required`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `integer`, `email`, `options`, `url`, `postTypes`) for the admin to word. `min` rules only apply to values that aren't empty; empty is `required`'s job. A required Group needs a value in one of its Fields; the required Fields of an optional Group count once it has a value; a required Repeater needs a row.
- **Publishing checks every value again** (Fields' rules may have changed since): `ENTRY_INVALID` with the same `problems` when a rule is broken, else `ENTRY_INCOMPLETE` with `data.missing` (`["title", "price", "address.city", "team[0].name"]`) when required values are empty. The Globals answer `GLOBALS_INVALID` and `GLOBALS_INCOMPLETE`.

### Relationships

A Relationship value is a list of Entry ids inside a version. `entry_links` also keeps every link per Entry, version (`draft`, `published`) and Field path (`categories`, `credits.person` inside a Repeater), written by `changeDraft` and `publish` (`content/relationships.ts`), so what points at an Entry is one indexed lookup. Categories and tags are ordinary Post Types joined by Relationships.

- **Two-way** (the default): the Entries pointed at show the link back, as `linkedFrom` (`{ entryId, postTypeId, field, title }`, from the linking Entries' Drafts). **One-way**: nothing shows on them. Loops over Relationships (#62) and the Content API (#108) read the same links.
- **Rendering** shows only published Entries pointed at (see "What a binding reads").
- **Deleting an Entry** (`entries.delete`, Permission `entry.delete`: Staff, Owners and Editors) takes two calls. The first deletes nothing and answers `{ deleted: false, links, confirmation: { id, expiresAt } }`, `links` being how many other Entries link to it; the second, with `confirmation`, deletes it, removes the links to it from those Entries' Drafts and published versions (their status doesn't change), clears the page cache and logs `entry.delete`. While another Entry must point at it through a required Relationship, both calls answer `ENTRY_LINKED` with `data.blockedBy`.
- **Globals** can't hold Relationships.

### Two-step confirmation

`askConfirmation` and `useConfirmation` (`packages/core/src/confirmations.ts`, table `confirmations`) are how destructive procedures confirm (spec › Management API): the first call works out a preview and asks; the second works it out again inside the transaction that goes ahead and uses the id. A confirmation is for one person, one action and one target, lasts 5 minutes (`CONFIRMATION_LIFETIME_MS`), works once, and only while the preview is unchanged. Otherwise the API answers `CONFIRMATION_INVALID` with `data.problem`: `unknown`, `expired` or `changed`. Publish all, emptying Trash and deleting Structure are to use the same two functions.

### Globals

The Globals (`content/globals.ts`, one `globals` row per Site, made the first time it is needed) are one set of Fields per Site, read by every Template as `site.x`.

- `globals.get` (`site.view`): the Fields, the Draft and published values, `status`, `problems` and dates.
- `globals.setFields` (`structure.edit`): the full list of Fields, in order. Like a Post Type's, it applies at once, keeps each Field's type, clears the page cache and logs `globals.update`. Keys can't be `name`, `url`, `language` or `languages`, kept for the Site's own values under `site.`.
- `globals.saveDraft` (`entry.edit`, so Authors too) and `globals.publish` (`entry.publish`), which goes through `publish` with `{ kind: "globals" }`.

### Publishing

`services.publishing.publish(scope, item)` (`content/publishing.ts`) is the one way anything is published. `item` is `{ kind: "entry" | "template", id }` or `{ kind: "globals" }`; Components, Forms and the Design system become more kinds. Open the Site with `publishPermission(item)` (`entry.publish` for Content: Entries and the Globals; `structure.edit` for Structure such as Templates); `publish` checks it again, so the worker's Scheduled publishes (#69) hold it too. In one transaction it:

1. locks the item and checks it can be published: an Entry's (or the Globals') values must keep their rules (`EntryInvalidError`, `GlobalsInvalidError`) and every required value must be there, the title and slug included (`EntryIncompleteError`, `GlobalsIncompleteError`); an Entry's slug must be free among published Entries of its Post Type (`EntrySlugTakenError`; for a Page, among the Pages under its parent); a Page's parent must be published (`PageParentUnpublishedError`) and its new path, and those of the Pages under it, free of URL patterns (`PathTakenError`); a Template must still fit what it renders: its Post Type, the Globals and what its Relationships point at (`ElementTreeInvalidError`);
2. copies the Draft over the published version and sets `publishedAt` (first time) and `lastPublishedAt` (an Entry's published links too);
3. clears the Site's page cache (`clearPageCache`: raises `sites.page_cache_generation`);
4. writes the Audit log (`entry.publish`, `template.publish`, `globals.publish`). `entry.publish` holds the Entry's `path` and `pathChanges`: every published path the publish changed (`{ entryId, language, from, to }`: an Entry's new slug, a Page that moved and every Page under it). The result (`Published`) carries the same `pathChanges`: Redirect rules (#94) follow them so old links keep working.

Revisions (#67), Publish all (#68), Scheduled publish (#69), Review (#70), Webhooks and the CDN purge hook in here.

## The Site pipeline and the page cache

`apps/server/src/site/pipeline.ts` answers every hostname other than the admin host (ADR 0004):

1. **Hostname → Site** (`services.sitePages.resolveHost`): a Staging address, `<site slug>.<WEBCRAFT_SITES_DOMAIN>`, compared in lower case without a trailing dot. Anything else gets the unbranded 404. Primary, Redirect and language domains (#82, #80) join here. The admin host never resolves to a Site, and no Site slug can make a Staging address equal to it (`reservedSlugs`).
2. **Only `GET` and `HEAD`** for now (405 otherwise); Form posts come with their reserved paths.
3. **Paths the Install keeps** (`isReservedPath`): every path whose first part starts with `_` (`/_webcraft/…`, `/_media/…`, `/_content/v1/…`, `/_wc/m/<module>/…`) and every path naming a file, with a dot in a part (`/sitemap.xml`, `/robots.txt`, `/llms.txt`, Markdown copies such as `/about.md`). No slug or URL pattern part can start with `_` or hold a dot, so no Page or Entry is ever there. Each feature answers its own (add its step here); until then they get the plain 404.
4. **Page cache lookup** by normalised URL (`canonicalPath`): decoded path segments, no trailing slash, no query parameters (none changes a page yet; Filters will keep theirs, sorted).
5. **Render on a miss** (`services.sitePages.render`): the published Entry whose Post Type's URL pattern and published slug match, through its published Entry template (an Entry whose Entry template isn't published has no page yet); else the published Page at that path; at `/`, the home page. Every page renders inside the Site template. The page is kept in the cache. The home page's own path answers a 301 to `/`.
6. **Answer** with `Content-Type: text/html`, `Cache-Control: public, max-age=0, must-revalidate` (browsers and proxies revalidate every time, since a publish must show at once), a strong `ETag` (SHA-256 of the HTML; `If-None-Match` gets 304), `X-Cache: HIT` or `MISS`, and on a Staging address `X-Robots-Tag: noindex`.
7. **A path with no page** gets the Site's **404 page** (`services.sitePages.notFound`): the Page Staff chose, once published, else the built-in one (`builtInNotFoundPage`: a heading and one sentence in the page's language), inside the Site template, with status 404 and `Cache-Control: no-store`. It is never kept in the page cache and has no ETag, so every miss reaches the Site (the 404 log, #94, hooks in here) and a page published at the path shows at once.

**The page cache** (`apps/server/src/site/page-cache.ts`) is in the web process's memory, 64 MiB by default, least recently used pages going first. Every page is kept under the Site's page cache generation, read with the hostname; `publish` raises the generation in Postgres in the publish's own transaction, so the whole Site's cache is cleared at once, in every web process, whichever process published (the worker too). A request that read an older generation never stores its page. The Content API (#108) and a CDN purge can key on the same generation and ETags.

Staging addresses show published pages for now; #68 makes them show Drafts, at which point Staging answers stop being cached.

### Element trees and the renderer

Templates are stored as element trees (`packages/renderer/src/tree.ts`, ADR 0002), the one canonical format the builder, Template markup and the renderer share:

```ts
{ version: 1, nodes: [
  { type: "element", id: "Xb3…", tag: "article", attributes: [], classes: ["<Class id>"], children: [
    { type: "element", id: "Q9z…", tag: "h1", attributes: [], classes: [], children: [{ type: "value", path: "title" }] },
    { type: "value", path: "publishedAt", format: { type: "date", style: "long" } },
    { type: "comment", text: " kept for Staff, never sent to visitors " },
    { type: "condition", branches: [{ test: { type: "value", path: "summary" }, children: [/* … */] }], otherwise: null },
    { type: "element", id: "k2P…", tag: "a", classes: [],
      attributes: [{ name: "href", value: [{ type: "text", text: "/blog/" }, { type: "value", path: "slug" }] }],
      children: [{ type: "text", text: "Read more" }] },
  ] },
] }
```

- Elements have a stable `id` (filled in when missing, kept when given), a lower-case `tag` from `TEMPLATE_ELEMENTS`, ordered `attributes` (a list: Postgres `jsonb` doesn't keep key order, and a round trip must lose nothing), `classes` (the ids of the Site's Classes, ADR 0009) and `children`. Text nodes are fixed text; value nodes and attribute value parts are **bindings**: a `path` (`title`, `address.city`, `category.url`, `site.phone`; later `props.x`, `item.x`) and an optional `format`, which Edit mode (#72) reads to tag editable regions. Comments are kept and never rendered. Template commands' nodes (a Condition so far) come from the command registry (see "Template markup").
- `parseElementTree(input, options)` checks a tree and answers its canonical form (text next to text joined, empty text dropped, line breaks in comments as `\n`), or throws `ElementTreeInvalidError` with every problem and where (`nodes[0].children[2].attributes[1]`): scripts, elements outside `TEMPLATE_ELEMENTS`, `on…`, `style`, `class`, `srcdoc` and `data-wc-…` attributes, unknown value names (`isKnownValue`), Class ids the Site doesn't have (`classIds`), nesting a browser would change (a block inside `<p>`, a link inside a link, table parts out of place, `<li>` inside `<li>`), duplicate ids, children of void elements, NUL and broken characters, more than 64 levels or 10,000 nodes. The API answers it as `TEMPLATE_INVALID` with `data.problems`. The element and attribute rules are functions (`elementProblem`, `attributeProblem`, `nestingProblem`) the markup parser calls too, so both refuse the same things with the same words.
- New node types join the `TreeNode` union; a change old trees can't be read as raises `ELEMENT_TREE_VERSION`.
- `renderPage` (`packages/renderer/src/page.ts`) writes a whole document: `<html lang dir>` (the direction from the language), the title (`<title> · <Site name>`), a skip link as the first thing in `<body>`, then the Site template (the built-in one when the Site has none published) with the page's content (an Entry template, a Page's layout, the 404 page's content) rendered at its `{{@outlet}}`. The Site template's one `<main>` gets the id the skip link points at and `tabindex="-1"`, so following the link moves focus there; WebCraft adds them through `extraAttributes`, the render option Edit mode's tags (#72) can use too. Landmarks (`<header>`, `<nav>`, `<footer>`) are the Site template's. The words WebCraft writes into pages (the skip link, the built-in 404 page) come from `pageWords(language)`: English and Italian so far, English for any other language until the Site's languages (#80). **Accessibility hooks** the Design system (#64) styles from its base layer are named in `PAGE_HOOKS`: the skip link's class `wc-skip-link` (out of sight until focused), the main id `wc-main`, and the custom properties the focus style reads (`--wc-focus-color`, `--wc-focus-width`, `--wc-focus-offset`), set from Design tokens; it can be restyled but not removed. Until then browsers show their own focus ring and the skip link stays visible. Values are typed (`TemplateValue`: text, numbers, true/false, dates, rich text, or a list of them); the Site pipeline hands dates over as dates and rich text marked with `richText(html)` (see "What a binding reads"). A list renders as its values joined with commas, each through the value's formatter. Text and values are escaped for text or double-quoted attributes; `href`, `src` and other URL attributes (each `srcset` candidate, each `ping` URL) keep only `http`, `https`, `mailto`, `tel`, relative paths and `#anchors`, anything else becoming `#`. A date without a formatter renders as `2026-03-02`. Rich text renders as its cleaned HTML in text and as its plain text in attributes and formatters. Comments are left out. No script, inline style or event handler is ever written.

## Template markup

Template markup (`packages/renderer/src/markup/`, ADR 0017) is the one written form of element trees, for Code mode, the builder's code view, files, MCP, the CLI and imports. It is never stored: `parseTemplateMarkup(markup, options)` reads it into a canonical tree and `printTemplateMarkup(tree, options)` writes a tree as markup. Printing then parsing gives the same tree, for every setting (`tests/markup/round-trip.test.ts` checks it by hand and over generated trees).

```html
<article class="card" aria-label="Post" data-wc-id="Xb3kP9a2Lm4Q">
  <h1 data-wc-id="Q9zT2b7Rk1Wd">{{ title | truncate: 80 }}</h1>
  <!-- Comments stay in the markup and the tree; visitors never get them. -->
  {{@if summary and status != "draft"}}<p data-wc-id="r5Hs8Kq0Zx3N">{{ summary }}</p>
  {{@else if author}}<p data-wc-id="m2Lp7Vd4Ty9C">By {{ author }}</p>
  {{@else}}<p data-wc-id="w8Bn1Fj6Gu5E">Write \{{ summary }} to show the summary.</p>{{/if}}
  <time datetime="{{ publishedAt | date: datetime }}" data-wc-id="c3Xr9Ma1Pq7S">{{ publishedAt | date: long }}</time>
</article>
```

- **Element ids** are written as `data-wc-id`, always last. An element written without one gets a new id; when two elements carry the same id (a copied element), the first keeps it and the copy gets a new one, with a notice. Other `data-wc-` attributes are WebCraft's.
- **Classes** are written by name in `class` (printed first) and stored by id; a name the Site doesn't have is refused. An inline `style` is read strictly (declarations only, safe `url()`s) and becomes a **generated Class** (`style-` and a hash of the canonical declarations, so the same style finds the same Class), with a notice; pages never carry inline styles. Generated Classes are rows of the `classes` Site table (`packages/core/src/design-system/classes.ts`); the Design system (#64) owns Classes from there: their editor, renaming, Draft and published styles and the stylesheet that makes them show.
- **Values**: `{{ path }}` or `{{ path | formatter }}`, in text and inside attribute values. Formatters are a fixed set (`packages/renderer/src/formatters.ts`): `date` (`short`, `medium` (the default), `long`, `full`, `time`, `iso`, `datetime`; in the page's language, in UTC until Sites have a time zone), `number` (optionally `number: 2` decimals) and `truncate: <length>` (cut at a word, then `…`). Which paths are known depends on the kind of Template (`isKnownValue`): an Entry template reads the built-in Fields, its Post Type's Fields and their parts, and the Globals (`site.x`; see "What a binding reads"); Loop items (`item.x`) and Props (`props.x`) become known where they exist.
- **Escaping**: text prints `&`, `<` and `>` as references; `\{{` is a literal `{{` (the printer writes `{{` in text that way), and a `{` or `\` at the end of text prints as `&#123;` / `&#92;` so it can't run into a following `{{`. Whitespace is kept exactly: the printer adds none, so a file pulled, edited and saved shows only your changes.
- **Strict HTML**: every element needs its end tag (`<br>` and other void elements have none, `<br/>` is fine), nothing a browser would repair is accepted, and doctypes, `<script>`, `<style>`, `<meta>`, `on…` attributes and values in tag names, attribute names, `style`, `class`, `srcdoc` and `on…` are refused. `media:<id>` (#73), PascalCase Component tags (#63) and the reserved commands are refused until their tickets.
- **Rules by kind of Template**: besides `isKnownValue` and `refuseElement`, a kind of Template gives `refuseCommand` (a command it can't hold: Entry templates refuse `{{@outlet}}`) and `checkTree` (rules about the whole tree once it is read, such as the Site template's one `<main>` and one outlet). Both parsers take them and report each problem where its node is.
- **Problems and notices**: `TemplateMarkupInvalidError` lists up to 20 problems, each `{ line, column, message }`; the API answers it as `TEMPLATE_MARKUP_INVALID` with `data.problems`. A save that works answers `notices` in the same shape.
- **API**: `templates.getEntryTemplateMarkup({ siteId, postTypeId })` answers `{ template, markup: { draft, published } }` (both null without a template); `templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup })` saves the Draft (creating the template) and answers `{ template, markup, notices }`, the markup as stored now. Both need `structure.edit`; `getSiteTemplateMarkup` and `saveSiteTemplateMarkup` do the same for the Site template. In core, `services.templates.entryTemplateMarkup` and `saveEntryTemplateMarkup` (`content/templates.ts`).

### Template commands and Conditions

`{{@name …}} … {{/name}}` blocks are **Template commands**, each one entry in `TEMPLATE_COMMANDS` (`packages/renderer/src/commands.ts`): its name, its node type, whether it is a block, the branch keywords allowed inside it (`else if`, `else`; a Loop's `empty`), and how it reads from markup, prints, is checked as a stored node, lists its children and renders. The parser and printer handle every command through the registry, so **adding a command** is: a node type in the `TreeNode` union, an entry in `TEMPLATE_COMMANDS`, and removing its name from `RESERVED_COMMANDS` (`loop`, `empty`, `pagination`, `form`, `filter`, `popup`, refused until their tickets). A kind of Template that can't hold a command refuses it with `refuseCommand`.

`{{@outlet}}` is the content outlet: where the Site template shows each page's content. It takes nothing, holds nothing, and renders the page's content, already rendered (`RenderOptions.outlet`); only the Site template holds it, once (see "The Site template").

`{{@if}}` / `{{@else if}}` / `{{@else}}` is a Condition. Its tests are stored as data (`Expression` in `packages/renderer/src/expressions.ts`) and run by WebCraft's own interpreter, never `eval`: a value on its own passes when it isn't empty (blank text, false and empty rich text are empty; 0 is a value), `==` and `!=` compare (a number as a number, true/false as yes or no, otherwise as text; empty equals `""`), with `not`, `and`, `or` and brackets, and literals `"text"`, numbers, `true` and `false`. #62 adds compare, contains, language, date window and Loop position as more operators and kinds there. A test nests at most 32 deep.

### Rich text

`cleanRichText(html)` (`packages/renderer/src/rich-text.ts`) parses with parse5 (the HTML standard's algorithm, in a `<div>`'s context, as a browser would) and writes back only the allowlist: `p`, `br`, `strong`, `b`, `em`, `i`, `u`, `s`, `sub`, `sup`, `code`, `mark`, `small`, `ul`, `ol`, `li`, `blockquote`, and `a` with `href` (safe schemes only) and `title`. Scripts, styles, embeds, SVG, MathML, forms and comments go with their content; other elements keep their text. Nothing is matched with regular expressions, and the output is the cleaner's own, so cleaning clean rich text changes nothing. The rich text Field type (`content/field-types.ts`) cleans values on save (rich text with no text left is empty; at most 20,000 characters of cleaned HTML), and the renderer cleans them again on render.

### What a binding reads

`content/render-values.ts` works out what a binding's path names on a page (`entryParts`, `resolvePath`), and which paths a template may hold (`knownValues`, checked on save and on publish):

- a built-in Field or a Field of the Post Type: `summary`, `price`;
- a part of a Field: a Group's Field (`address.city`), a Repeater's Field across its rows (`team.name`: each row's name, a list), a link's `url` or `text`, a select's `value` or `label`;
- what a Relationship points at, one level deep: the published Entries' `title`, `slug`, `url` (from their Post Type's URL pattern; a Page's path for a Page), dates (as dates, for the `date` formatter) and Fields (`category.title`, `category.url`, `authors.bio`); unpublished Entries are left out;
- `site.x`: the published Globals (`site.phone`, `site.address.city`).

On its own a select shows its label, a link its text (or its address), a Relationship its Entries' titles, rich text its cleaned HTML, true/false `true` or `false` (Conditions test them as they are); Groups, Repeater rows and media Fields show nothing. A list (a multi-select, a Repeater's Field, a multi-Relationship) shows its values joined with commas until Loops (#62) show them one by one.

## Migrations

Migrations are drizzle-kit files in `packages/db/src/migrations`, applied by their own `migrate` step (ADR 0031), never by web or worker at start-up.

- Change the schema in `packages/db/src/schema/` (one file per area, re-exported from `index.ts`), then `bun run db:generate`. Commit the generated folder.
- Hand-written SQL (functions, triggers, data fixes) goes in its own custom migration: `bun run db:generate --custom --name=<what-it-does>`. Keeping it separate means a regenerated schema migration never loses it.
- Every change keeps the previous version working on the new schema: add first, remove in a later release. There are no down-migrations.
- `webcraft admin migrate` applies pending migrations in one transaction, then installs or upgrades the job queue (pg-boss) schema. Web and worker check both at start-up and refuse to run on a database that is behind; `/readyz` reports the same check.
- When two branches both add migrations, keep the integration branch's and regenerate yours on top with `bun run db:generate`. Git often merges two such migrations without a conflict, but both were generated from the same parent, so the newer snapshot misses the other's tables and the next `db:generate` would write them again. `tests/db/migration-chain.test.ts` fails when that happens: delete your migration's folder and generate it again (a custom one: recreate it with `--custom` and paste its SQL back).

## Jobs

Jobs are defined with `defineJob({ name, payload, queue, run })` (in `packages/core/src/jobs/`, or next to their module, such as `email/outbox.ts`) and listed in `coreJobs` (`packages/core/src/jobs/index.ts`); the worker only works listed jobs. `sample-ping.ts` is the sample to copy.

- `name` is the queue name, `area.action` (`email.send`). Never rename one that has shipped.
- `payload` is a Zod schema; it is checked when the job is sent and again when it runs.
- `queue` holds retry and expiry settings (`retryLimit`, `retryDelay`, `retryBackoff`, ...).
- `run(payload, services)` gets the same `InstallServices` as the web process: use `services.clock`, `services.http` and `services.log`, never `Date.now()`, `fetch` or `console` directly. To email someone, send a System email (see "Email"); never call `services.mailer`.
- Enqueue with `services.jobs.send(job, payload, { startAfter })`.
- **Scheduled jobs**: `defineSchedule({ job, cron, payload })`, listed in `coreSchedules` (so far the daily `email.purge-log` and `rate-limits.purge`). `cron` is read in UTC (`17 3 * * *` is every day at 03:17). The worker registers every listed schedule when it starts (and removes ones no longer listed); when it was down at a due time, the job runs once when it is back. The test harness's `drainJobs()` sends each scheduled job whose time came by the test clock since the last drain.

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
- **Delivery and retries**: the `email.send` job sends it. A failed attempt is tried again after 1 minute, then a wait that doubles up to 4 hours, until 24 hours after it was queued; then it is Failed. An address the server refuses for good (a 5xx answer to `RCPT TO`) is Failed at once. Completed `email.send` jobs, which hold the body, are deleted after an hour. Delivery is at least once: if the server takes an email but recording that fails, the job is retried and the email can go out twice. Every attempt carries the same `Message-ID` (`<Email log line id@sender's domain>`), so mail clients can drop the copy; losing an email (a password reset, an invite) would be worse than a rare duplicate.
- **Failing**: 3 failed sends in a row make the SMTP Failing: logged as an error, shown in Install settings › Email (SMTP) and as a notice on every admin page for the Superadmin (an email about a failing Install SMTP would go through it). A send that goes through, or saving new settings, clears it. Test emails don't count.
- **Test email**: `services.email.sendTest` sends at once through settings that may not be saved yet, and answers the server's reply.
- **The Email log** keeps time, type, recipient, subject, SMTP, status (Queued, Retrying, Sent, Failed, Written to the log), attempts, the server's last answer and the related item, never the body. The `email.purge-log` job deletes lines older than 90 days every day.
- **The Mailer** (`email/mailer.ts`) is the edge: `send(email, smtp)` over SMTP with Nodemailer (`email/smtp-mailer.ts`), rejecting with `SmtpDeliveryError` (the server's answer, and whether it refused the recipient for good).
- **Who manages it**: the Install SMTP, Install branding and the Email log procedures (`packages/api/src/procedures/email.ts`) are for the Superadmin, through one gate at the top of that file (`emailAdmin`). Changing the SMTP is a Sensitive action (`installSmtp.change`, see "Sensitive actions") and is recorded in the Audit log, never with the password.

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
- **Passwords** need at least 12 characters (`assertNewPasswordAllowed`). Extra checks plug in as `passwordChecks` in `createAuth`; `createInstallServices` plugs in the leaked-password check.
- **The leaked-password check** (`leakedPasswordCheck` in `packages/auth/src/leaked-passwords.ts`) checks every new password (new accounts, password changes) with a partial-hash lookup through `services.http`: only the first 5 characters of the password's SHA-1 hash leave the server (`GET <range service>/range/<prefix>` with `Add-Padding: true`), and the password is refused (`PASSWORD_REFUSED`, `leaked`) when the answer lists the rest of its hash as seen at least once. It fails open: when the service can't be reached, times out (5 seconds) or answers with an error, the password is accepted and a warning is logged. The Superadmin switches it off in Install settings › Security (`install.security.update`, a Sensitive action), for an Install that is always offline.
- **Sessions** end after 7 days unused and 30 days after sign-in, by WebCraft's clock (`services.clock`), so tests move them with `install.clock.advance`. A session in use is renewed at most every 10 minutes, and records the client address it was used from. The cookie is `HttpOnly`, `SameSite=Lax` and `Secure` (except on a `.localhost` development host), signed with a key derived from the Master key: a new Master key signs everyone out.
- **Your sessions** (Your account › Sessions): `me.sessions.list` shows each session's browser and system (from its `User-Agent`), its network (the client address with the end hidden, `203.0.113.*`; no outside location lookup, which would send people's addresses to another company) and when it was last used. `me.sessions.revoke` signs one out at once (this browser's own one too, clearing its cookie), `me.sessions.revokeOthers` every other one. `me.changePassword` (a Sensitive action) signs out every other session in the same transaction; changing 2FA does the same with `auth.revokeOtherSessions`.
- **Lockout** (`packages/auth/src/lockout.ts`): 10 wrong passwords in a row, signing in or confirming who you are, lock the account for 15 minutes. While it is locked nothing is checked, not even the right password, and trying doesn't make the lock longer; a right password, or the lock, starts the count again. Addresses nobody signs in with never lock. The answer is `ACCOUNT_LOCKED` (423) with `retryAfterSeconds` and a `Retry-After` header. When an account locks, `onAccountLocked` sends the `account-locked` security email and writes `account.lock` to the Audit log with the address of the last attempt.
- **Rate limits** on the auth endpoints (signing in, confirming who you are, setup tokens, invite links): at most 10 requests a minute from one client address, counted in Postgres (`services.rateLimits`, `RATE_LIMITS` in `packages/core/src/rate-limits.ts`) so every web process shares the count; then `TOO_MANY_REQUESTS` (429) with `Retry-After` until the minute is over, and one warning in the log. Requests whose address the web process can't tell share one count. The `rate-limits.purge` job deletes ended counters every day. Better Auth's own rate limiter stays off: its endpoints aren't served.
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
- **Levels and the sidebar**: `ui/shell/levels.ts` holds each level's sidebar groups and items (`label`, `icon`, `to`, `requires`: the Permission that shows it). A group can carry `requires` too: the Site level's Structure group, when it comes, requires `structure.edit`, so Members see Content items only. The levels are the Install, a Workspace and a Site: pages under `routes/_admin/workspaces.$workspaceId.tsx` are at the Workspace level and pages under `routes/_admin/sites.$siteId.tsx` at the Site level. Those two routes load the Workspace or Site and the person's Permissions there, and set `place` in the route context; the sidebar, the breadcrumbs (the Workspace's and Site's names first) and the context switcher read it. A page reads `Route.useRouteContext().place.permissions` to decide what to offer, never a role name. A page sets its breadcrumb with `staticData: { crumb: "<message key>" }`.
- **Pages** inside the shell are routes under `routes/_admin/` (signed in only). Start a page with `PageHeader`; use the shadcn components from `@webcraft/ui/components/*`.
- **The setup wizard's steps** are the list in `ui/setup/steps.tsx`: each has a title, a hint, a stage and a panel. After `two-factor` comes `email` (the Install SMTP, which can be skipped); the Modules step goes after it, as a `continue` step. The last step finishes setup.
- **Times** are shown in UTC with `formatUtc`, and days with `formatUtcDate` (`ui/format.ts`), in one fixed form: the server renders pages first, and its date formatting differs from the browser's in small ways, which breaks hydration.
- **shadcn components** come from preset `b1Fk3bmIS` (`style: base-vega`, zinc, RTL on, see `packages/ui/components.json`). Add one with `bunx shadcn add <name>` in `packages/ui`, then run `bun run lint`: generated code sometimes fails the accessibility rules; fix the component (several are marked `WebCraft:`) rather than switching a rule off, and give every visible or screen-reader string a prop so it can be translated.

## Testing

Tests live in `tests/`, grouped by area, and run with `bun run test` from the repo root. They test at the spec's seams and check what a person, visitor or client would observe: HTTP responses, emails that went out, outgoing calls, job outcomes and later responses. They never import internal functions or read tables directly; refactoring without changing behaviour must not break a test.

**Seam 1** is the web process's handler, booted in-process against a real Postgres. `createTestInstall()` from `tests/harness/index.ts` gives each test file its own Install:

| Part | What it does |
| --- | --- |
| `install.secrets` | Every secret of the Install (`set`, `useWith`, `describe`, `remove`), for any owner, encrypted under its Master key: for tests of the secret store. WebCraft's own code reaches a Workspace's or Site's secrets through the data layer. |
| `install.env` | The environment a real process needs to run as this Install: `DATABASE_URL`, `WEBCRAFT_ADMIN_HOST` and `WEBCRAFT_SECRET_KEY`. |
| `install.request(url, init)` | Sends a standard `Request` through the handler, in process. Always use a full URL: the hostname decides where it goes. `install.adminUrl("/healthz")` builds admin-host URLs (`https://admin.test/...`); a Site's Staging address is `https://<slug>.sites.test` (`sites.get` answers it as `stagingUrl`). |
| `install.browser()` | A person's browser on the admin: it keeps cookies and sends the admin's origin. `browser.api` is the typed Management API client (`await browser.api.session.current()`); errors reject with their API `code`. `install.browser({ origin })` sends requests from another site's pages. Each browser comes from its own client address (`browser.address`, which a test can change); give `{ address }` to choose one (null: one the web process can't tell) and `{ userAgent }` for the browser it says it is. |
| `install.createSuperadmin(account?)` | Creates the Superadmin as `webcraft admin create-superadmin` does and answers the account (email, password `TEST_PASSWORD`). |
| `install.superadmin()` | A browser signed in as the Superadmin (made first when there is none). |
| `install.createWorkspace(name?)`, `install.createSite(workspaceId, { name?, slug? })` | A Workspace or Site, created by the Superadmin through the API. |
| `install.createStaff({ workspaces })` | A Staff member, the way people become one: invited, then accepting the link in the email. Answers `{ account, personId, browser }`. |
| `install.createMember({ workspaceId, role, sites? })` | A Member the way people become one: the Superadmin invites them and they accept the link with a new account, signed in. `install.addMembership` gives an existing person a Membership directly, for tests of what a Membership may never be. |
| `install.signIn(account, browser?)` | A new browser, signed in; `browser` takes the same options as `install.browser()`. |
| `install.setupToken()` | The setup token the web process printed when it last started (the harness starts like the web process, printing one while there's no Superadmin). |
| `install.jobs.send(job, payload)` | Enqueues a job as the web process would. |
| `install.drainJobs()` | Runs every job that is due by the test clock, including jobs those jobs enqueue and scheduled jobs whose time came, and returns `{ completed, failed }`. |
| `install.lastEmailTo(address)` | Runs the due jobs, then answers the newest email to the address: sent through the Install SMTP or, while it isn't set, written to the log (`{ to, subject, text }`). `inviteLinkIn(email)` finds an invite link in one. |
| `install.sendSystemEmail(email)` | Sends a System email as WebCraft's features do (`services.email.send`); drain the jobs to send it. |
| `install.mail` | The fake Mailer: `sent` holds every email the server took (with the `smtp` settings it went through, password included), `attempts` every try; `fail(response)` makes every send fail with that answer until `accept()`; `rejectRecipient(address)` refuses one address for good; `clear()` forgets them. |
| `install.http` | The fake outgoing HTTP: `respond(method, url or RegExp, { status, body, headers } or a function)`; `requests` holds every call. A request nobody prepared an answer for fails like an unreachable server. The leaked-password range service (`LEAKED_PASSWORD_RANGE`) answers that no password is leaked unless a test answers it otherwise; `reset()` forgets that answer too, so the lookup is then unreachable. |
| `install.clock` | Time stands still until `advance(ms)` or `set(date)`. The job queue reads the same time inside Postgres, so a job sent with `startAfter` in an hour runs only after `advance` passes it, and retries wait for their delay. `advance` jumps like a process that slept, so moving days ahead is quick. Sessions expire by this clock too. Starts at `2026-03-02T09:00:00Z` unless you pass `{ now }`. |
| `install.logs` | Every log entry the Install wrote. |
| `install.restart({ masterKey? })` | Starts the Install again, as web and worker do (with another Master key when given), running their start-up checks and printing a new setup token while there's no Superadmin. |
| `install.close()` | Stops the Install and drops its database. |

`createTestInstall({ database: "empty" })` gives an Install whose database nobody migrated, and `{ database: "unreachable" }` one whose database doesn't answer. Every test Install starts with the Master key `TEST_MASTER_KEY` unless you pass `{ masterKey }`; tests never use the key in `.env`. Its sites domain is `sites.test` (`TEST_SITES_DOMAIN`) unless you pass `{ sitesDomain }` (`null` for none), and its admin host `admin.test` unless you pass `{ adminHost }`.

`tests/harness/trees.ts` writes element trees briefly: `tree(element("article", [element("h1", [value("title")])]))`, `text("…")`, and attributes as `element("a", [text("More")], { href: [{ type: "text", text: "/blog/" }, value("slug")] })`; comments and Conditions are written as their stored shapes, and `outlet()` is the Site template's `{{@outlet}}`. `tests/sites/first-site.test.ts` shows a whole Site: Post Type, Entry template, Entry, publish, the rendered page and the page cache. Most Template tests write Template markup instead (`templates.saveEntryTemplateMarkup`), as `tests/sites/template-markup.test.ts` does. Property-based tests use fast-check (`tests/markup/round-trip.test.ts`): generate inputs, drive them through the API, and check what comes back.

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

**Seam 2** is a real browser, for accessibility (and later the editors). `tests/browser/harness.ts` starts a test Install served by the production web process (`bun run build` first) on `http://admin.localhost:<port>`, with Sites' Staging addresses on `http://<site slug>.sites.localhost:<port>` (`browserInstall.siteUrl(slug, path)`), and Chromium through Playwright; `tests/browser/checks.ts` holds the checks; files are named `*.browser.ts` so `bun test` leaves them out, and `bun run test:browser` runs them. Every check runs with the device set to light and to dark (the admin follows the device).

- `expectAccessibleScreen(page, where)`: axe-core finds no violation of WCAG 2.0, 2.1 or 2.2 at A or AA, nor of its best practices; the first Tab reaches "Skip to main content" and following it moves focus into the `<main>` it points at; Tab visits every link, button and field in page order, each with a visible focus indicator; no positive `tabindex`; Tab always moves on (no traps); the page logged no errors.
- `expectOverlayUsable(page, trigger, "menu" | "dialog", where)`: opens a menu or dialog from the keyboard, checks it with axe, and Escape closes it with focus back on the trigger.

`browserInstall.signIn(page, account)` signs in through the sign-in page the first time for an account and hands later pages the same session: the web process limits auth requests per client address, and every page comes from this machine. `browserInstall.signInWithOldIdentityCheck(page, account, minutesAgo)` signs a page in with a session whose identity check is old, so the next Sensitive action opens "Confirm it's you" (the web process runs on the real clock, so the test Install makes that session with its own clock set back). Real processes started by tests (the CLI, the web process here) do the real leaked-password lookup, or accept the password when offline, so their test passwords must not be on any leaked list.

`startBrowserInstall()` also gives the test Install behind the web process (`browserInstall.install`), to prepare data through the Management API, send System emails and drain jobs before the page opens (see `tests/browser/email.browser.ts`).

**Adding a screen** is one line in `tests/browser/screens.ts`: its name, its path and who looks at it (`superadmin`, `staff`, `owner` or `signed-out`). A screen inside a Workspace or Site gives its path as a function of the shared fixture (`({ siteId }) => `/sites/${siteId}``); prepare more data in `admin-screens.browser.ts` through `install.install`, the same Install in the test process. For a state a path can't reach (a wizard step, an error shown, an open menu), write a test like `tests/browser/setup-wizard.browser.ts`: drive the page there with Playwright, then call `expectAccessibleScreen` or `expectOverlayUsable`. Don't retest behaviour seam 1 covers.

**Site pages** are checked in `tests/browser/site-pages.browser.ts`: an Entry's page and the 404 page, inside a Site template with a header, navigation and footer, prepared through `install.install` and opened with `install.siteUrl`. Built-in Site output that later tickets add (Components, Forms, Popups, the Consent banner) gets its line there.

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
- **Before you finish**: `bun run lint`, `bun run typecheck` and `bun run test` all pass.

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
