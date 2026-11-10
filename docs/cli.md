# The `webcraft` CLI

`webcraft` is WebCraft's command line. On your own computer it runs an Install's remote commands (one for each public procedure of its Management API, the same actions its MCP tools offer AI clients), signs in to Installs, and syncs a Site's Structure with files (`structure pull/push`). On the server it runs the server commands (`webcraft admin …`).

## Getting it

- **A single file** for macOS (x64, arm64), Linux (x64, arm64) and Windows (x64), attached to each release on GitHub with its `SHA256SUMS`. It needs nothing else.
- **npm**: `npm install --global @webcraft/cli` installs the same file for your computer (the package `@webcraft/cli-<os>-<cpu>` that fits it) behind a small launcher.
- **The web image** has `webcraft` on its `PATH`, with the server commands: `docker compose exec web webcraft …`, or `docker compose run --rm migrate webcraft admin …` while web is stopped.
- **A checkout**: `bun apps/cli/src/main.ts …` (what the web image runs).

The single file and the npm package leave the server commands out: they read the Install's database and files, so they run where the Install runs, from the web image or a checkout of the same version.

## Signing in

```sh
webcraft login --install https://cms.agency.example
```

`login` uses a device code (the OAuth 2.0 device authorization grant): it shows a short code and an address, `https://cms.agency.example/oauth/device`. Open it in a browser where you are signed in to the admin, check that the code is the one in your terminal, and choose what `webcraft` may do there, as for an AI client: one Workspace, all its Sites or some, the Toolsets, read-only or not, and May publish. Approving is a Sensitive action, so the admin may ask for your password. `webcraft` waits (polling every 5 seconds, slower if the Install asks) and is signed in once you approve. A code works once, for 10 minutes. Approve only a sign-in you started yourself, just now: someone who sends you a code is trying to act as you.

The sign-in shows under Your account › AI clients, as "webcraft CLI on <computer>", where you can revoke it. Its changes are recorded as "<you> via webcraft CLI on <computer>". Its access token lasts an hour and is renewed by itself; its refresh token, 30 days and replaced each time it is used.

Where it is kept: in your system's keychain (the macOS Keychain, the Secret Service on Linux, the Windows Credential Manager); where there is none (a server without a Secret Service), in `credentials.json` in the config folder, readable only by you. `login` says which. `WEBCRAFT_CREDENTIALS=file` always uses the file. The config folder is `WEBCRAFT_CONFIG_DIR`, else `~/.config/webcraft` (`$XDG_CONFIG_HOME/webcraft`), or `%APPDATA%\webcraft` on Windows; it also holds `config.json` (the profiles, no secret) and copies of each Install's API document.

```sh
webcraft whoami     # the person, the Install and its version, the Workspace, Sites, Toolsets and access
webcraft logout     # revokes the sign-in on the Install and forgets it here
```

**Several Installs**: each sign-in is a profile, named after the Install's host unless you give `--name`. Commands use the one signed in to last; `--install <name or address>` (or `WEBCRAFT_INSTALL`) picks another for one command, `webcraft profiles` lists them and `webcraft profiles use <name>` changes the default.

**CI and scripts**: set `WEBCRAFT_TOKEN` to an API token (Your account › API tokens) and `WEBCRAFT_INSTALL` to the Install's admin address. Nothing is stored.

## The Install's commands

Each public procedure is a command: its operation id's words, each in kebab-case. `entries.saveDraft` is `webcraft entries save-draft`; a Module's procedure `m.redirects.rules.list` is `webcraft redirects rules list` (and always `webcraft m redirects rules list`); the operation id itself works too (`webcraft entries.saveDraft`). The commands come from the Install's own OpenAPI document, so they are exactly what that Install offers, Modules included.

```sh
webcraft help commands                 # the groups
webcraft entries --help                # a group's commands
webcraft entries save-draft --help     # a command's options
webcraft sites list --workspace-id 0b6c…
webcraft entries save-draft --site-id … --entry-id … --title "Opening hours" --seo '{"noindex": true}'
webcraft entries create --data @entry.json
```

- **Options** come from the procedure's input: `siteId` is `--site-id`. Text, numbers and choices are written as they are, `null` where null is allowed; true/false inputs are switches (`--trash`, `--no-trash`); lists of text repeat the option or take a JSON array; anything else takes JSON, or `@file` to read it from a file; uploads take a path (`webcraft media upload --site-id … --file loaf.jpg`). `--data <json | @file | ->` gives the whole input, which options then change. Wrong values, unknown options and missing required ones are refused before anything is sent. Every `webcraft` command reads its flags the same way, wherever they're written: `--flag`, `--flag=value`, `--flag value` (the value in the next argument), and, for the options every command has (`--yes`, `--help`, `--version`), their short forms `-y`, `-h`, `-V`. A bare `--` ends flag reading for any command: everything after it is taken as plain arguments, flags included. A value given as an explicit empty string (`--dir ""`) is accepted like any other value; only a missing one is refused.
- **Answers** print as indented keys and values for people; `--json` prints them as the Install sent them. Messages and refusals go to standard error (as JSON with `--json`).
- **Two steps**: procedures that publish or delete (marked `x-webcraft-confirmation`) first answer what they would do. `webcraft` shows it and asks "Go ahead? [y/N]" on a terminal; `--yes` goes ahead without asking; without a terminal and without `--yes`, nothing changes and it exits 4 (`--confirmation <id>` sends an id you already have).
- **Sensitive actions** (changing secrets, members' access, tokens…) are never commands: they need a fresh identity check in the admin.
- **Limits**: past the client's 300 requests or 30 writes a minute, `webcraft` waits as the Install's `Retry-After` says (a minute at most) and goes on.
- **Versions**: every answer to a signed-in client carries the Install's version (`WebCraft-Version`). A `webcraft` older than its Install says so, once per run, on standard error. A command this `webcraft` knows but the Install doesn't offer (it runs another version, or not the Module) is refused saying so, with exit code 7.

## Structure as files

`structure pull` writes a Site's Structure (its Drafts) into a folder you can keep in git and edit in your own editor; `structure push` sends your changes back, as Drafts.

```sh
webcraft structure pull --site-id 0b6c… --dir bakery-site
# edit, commit…
webcraft structure push --dir bakery-site
```

| File | Holds |
| --- | --- |
| `templates/site.wc.html`, `templates/search.wc.html` | The Site template and the Search results template, as Template markup. |
| `templates/entry/<post type>.wc.html`, `templates/archive/<post type>.wc.html` | Each Post Type's Entry and Archive template. |
| `components/<Name>.wc.html`, `components/<Name>.json` | Each Component's markup, and its Props. |
| `design-system/tokens.json` | The Design tokens, as DTCG (with WebCraft's details under `$extensions.webcraft`). |
| `design-system/classes/<name>.css` | One Class: `.name { its styles }`, then `@media (--<breakpoint>) { .name { … } }` for each breakpoint (by the breakpoint token's name), then a second `.name { its own CSS }`. |
| `design-system/base.css`, `design-system/site.css` | The base styles (one block per element) and the Site's own CSS. |
| `design-system/design-system.json` | Dark mode, and the Classes' order. |
| `post-types/<key>.json`, `loops/<name>.json`, `forms/<key>.json`, `filters/<name>.json` | Post Types, Loops (not their Loop items, which are Content), Forms (not their emails) and Filters, as their saves take them. |
| `webcraft.json` | The manifest: the Install, the Site, and for each file a hash of what was pulled and its Draft's version. |

Template markup keeps every element's id (`data-wc-id`): keep it on the elements you change, and leave it off new ones (the Install gives them one, which `push` writes back).

`push` compares each file with the manifest and lists what you changed (`~` changed, `+` new, `!` changed on the Install too), then sends it once you confirm (`--yes` without asking, `--dry-run` to only look). New files make new Templates, Components, Classes, Post Types, Loops, Forms and Filters; files you delete are never deleted on the Install. Nothing is published: publish in the admin, or with `webcraft … publish`. Post Types have no Draft, so a change to one applies at once (the preview says so).

**Stale pushes**: when something you changed was also changed on the Install since your pull (by someone in the admin, say), `push` sends nothing and exits 5. Pull again (it refuses to overwrite files you changed, unless `--force`) and redo your change, or push with `--force` to overwrite what changed there. Template markup is also sent with the version it was based on, so a save made in the moment between is refused too. After a push, each file sent holds what the Install stored, and the manifest is its new base: pulling then pushing without edits changes nothing.

## Server commands

Run on the server with the Install's environment (`DATABASE_URL`, `WEBCRAFT_ADMIN_HOST`, `WEBCRAFT_SECRET_KEY`, …). `webcraft admin --help` lists them:

| Command | What it does |
| --- | --- |
| `admin setup` | Prints a new one-time link to the setup wizard while the Install has no Superadmin. |
| `admin create-superadmin <email>` | Creates the Superadmin without the wizard. |
| `admin migrate [--no-backup]` | The migrate step (ADR 0031): a Backup first when anything is pending, then the migrations. |
| `admin backup [--to …]`, `admin restore <archive>` | Backups (ADR 0032). |
| `admin rotate-key` | Re-encrypts every secret under a new Master key. |
| `admin reset-2fa <email>` | Resets a person's two-factor authentication. |
| `admin check-update` | Reads the release feed now. |
| `admin doctor [--json]` | Checks the settings, database, Master key, storage, mail, worker, Backups and the update check: OK, Warning or Failing, and what to do. Exits 1 when anything is Failing. |
| `admin health [--worker]` | For health checks: the web process here answers `/readyz` (on `PORT`), or with `--worker` a worker checked in within 2 minutes. Exits 0 or 1. |
| `admin media move --to s3\|disk [--keep-source]` | Moves every stored Media file to the bucket or to local disk without changing an address. Switch Install settings › Storage there first. Run it again after a stop: it goes on. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | It worked. |
| 1 | The Install refused or failed the call, or something else went wrong. |
| 2 | The command or its options are wrong: nothing was sent. |
| 3 | Not signed in, or the sign-in or API token no longer works: run `webcraft login`. |
| 4 | A change waits for a confirmation that wasn't given (`--yes`), or you said no. |
| 5 | Changed on the Install meanwhile: a stale `structure push`, or `CHANGED_MEANWHILE`. |
| 6 | The Install couldn't be reached. |
| 7 | The Install's API doesn't offer this command (another WebCraft version, a Module it doesn't run, or a Sensitive action). |
