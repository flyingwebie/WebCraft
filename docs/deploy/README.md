# Deploying WebCraft

An Install runs on one of three supported targets:

| Target | Guide | Files | What answers HTTPS (`WEBCRAFT_EDGE`) |
| --- | --- | --- | --- |
| A server of your own (a VPS) with Docker Compose | [compose.md](compose.md) | `deploy/compose/` | Caddy, in the Compose file (`caddy`) |
| Coolify | [coolify.md](coolify.md) | `deploy/coolify/` | Coolify's proxy (`coolify`) |
| Railway | [railway.md](railway.md) | `deploy/railway/` | Railway's edge (`railway`) |

The images are plain, so other hosts may work, but only these three are supported. A server with 2 vCPUs and 2 GB of memory is enough to start.

This page covers what every target shares: the images, the settings, the first start, the Master key, updates and going back a version, Backups and restoring them, the update check, and how the Install tells visitors' addresses apart behind a proxy or a CDN.

## The images

Two images, published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

- `ghcr.io/flyingwebie/webcraft-web`: the web process (Bun): the admin, the APIs and every Site. It also holds the `webcraft` command for the server commands (`webcraft admin migrate`, `backup`, `restore`, `check-update`, `create-superadmin`, `rotate-key`, `reset-2fa`, `setup`, `doctor`, `health`, `media move`; see [`docs/cli.md`](../cli.md)), so `docker compose exec web webcraft admin …` works. `webcraft admin doctor` checks the whole Install and says what is Failing. Its health check asks `/readyz` on the admin host.
- `ghcr.io/flyingwebie/webcraft-worker`: the worker (Node LTS): jobs, image processing, email, Webhooks, Domain checks and the daily Backup. It answers no HTTP, so it has no health check.

Tags: a release `v1.2.3` is published as `1.2.3`, `1.2`, `1` and `latest`; the `main` branch as `main` and `sha-<commit>`. Pin an exact release (`1.2.3`) in production, so an update happens only when you change it. Both images run as an unprivileged user (uid 1000) and keep files in `/var/lib/webcraft/storage` and Backups in `/var/lib/webcraft/backups`, two volumes they share (with the migrate step, which runs the web image). Neither image needs `pg_dump`: WebCraft writes and reads a Backup's database dump itself.

The images are built from this repository by `.github/workflows/images.yml` (`apps/server/Dockerfile`, `apps/worker/Dockerfile`). To build one yourself: `docker build -f apps/server/Dockerfile -t webcraft-web .` from the repo root.

## Settings

Every setting is an environment variable; web, worker and the migrate step get the same ones. The full list is in [`docs/development.md`](../development.md#environment-variables). Those an Install sets:

| Variable | What to put there |
| --- | --- |
| `DATABASE_URL` | The Postgres connection string. Each target's files fill it in. |
| `WEBCRAFT_ADMIN_HOST` | The admin's hostname, such as `admin.agency.example`: no scheme, port or path. Choose it before the first start: passkeys and the links in emails already sent are tied to it. |
| `WEBCRAFT_SITES_DOMAIN` | Optional: the domain Staging addresses sit under (`sites.agency.example` gives `bakery.sites.agency.example`), with a wildcard DNS record pointing at the Install. Share links are served under it too (`share.sites.agency.example`); without it there are none. |
| `WEBCRAFT_SECRET_KEY` | The Master key (see below). |
| `WEBCRAFT_EDGE` | `caddy`, `coolify` or `railway`. Each target's files set it. |
| `WEBCRAFT_PUBLIC_ADDRESSES` | Optional: the Install's public IP addresses, separated by commas. Site domains point their A and AAAA records at them; without it, the Domains screen offers only a CNAME record to the admin host. |
| `WEBCRAFT_TRUSTED_PROXIES` | Optional: the proxies whose word on a visitor's address is believed (see "Visitors' addresses"). Each target's default is right unless you add a proxy of your own. |
| `WEBCRAFT_BACKUP_DIR` | The Backups folder. The images set it to `/var/lib/webcraft/backups`; mount a volume there in the worker, the migrate step and the web container (see "Backups"). |
| `WEBCRAFT_UPDATE_FEED` | Optional: where the update check reads the newest release (an `https` address), or `off`. Unset, the project's own feed (see "The update check"). |

Web and worker refuse to start when a setting is missing or malformed, when the database is behind (run the migrate step), or when `WEBCRAFT_SECRET_KEY` isn't the Install's Master key; the log says which and how to fix it.

## The first start

1. The migrate step runs first and creates the database's tables (each target's files run it before web and worker, on every deploy).
2. The web process prints a **setup link** in its log (`setupUrl`, with a one-time `setupToken`) while the Install has no Superadmin. Open it on the admin host to create the Superadmin. On a server without a browser, `webcraft admin create-superadmin <email>` does the same from the shell; `webcraft admin setup` prints a new setup link if the log is out of reach.
3. In the admin, confirm you have stored the Master key outside the server (a banner asks until you do), set up the Install SMTP, and approve the first-party Modules.

## The Master key

`WEBCRAFT_SECRET_KEY` encrypts every stored secret (SMTP passwords, AI keys, Webhook and CDN secrets). It is at least 32 characters; `openssl rand -base64 32` makes one (Coolify and Railway generate it). Keep a copy outside the server, in a password manager: it is never in the database or in a Backup (ADR 0032), and without it the stored secrets can't be read (content and Media are not affected). To change it, use `webcraft admin rotate-key` (see [`docs/development.md`](../development.md#rotating-the-master-key)), never just a new value.

## Updates

Change the image tag (`WEBCRAFT_VERSION`) and deploy again. The migrate step runs first (ADR 0031): when anything is pending (WebCraft's migrations, a Module's, the job queue's schema) it **takes a Backup** of the Install, where Install settings › Backups says, then applies each migration in its own transaction, makes or updates every job queue and records the version. Web and worker start only once it has finished, and refuse to start on a database that is behind. There is no one-click update: it would need the Docker socket.

`webcraft admin migrate --no-backup` skips the Backup (and says so). Each target's files run the step with its Backup; on Railway, send Backups to a bucket first (see [railway.md](railway.md)), since the pre-deploy container keeps nothing.

### Upgrade notes

- **Reports and Share links** (#104) gave the Share link address the slug `share` (`share.<sites domain>`), reserved from then on so no Site may take it. If a Site already had that slug, the migrate step moves it to the first free `share-<n>` the moment you upgrade past this version, and the Audit log records it as WebCraft itself (`site.slugChanged`, with the old and new slug). Nobody loses access: the Site's Staging address and everything that links to it (bookmarks aside) just move to the new slug, visible on the Site's page in the admin.

### Going back a version

Every migration keeps the previous version working (add first, remove in a later release), so going back one version is changing the tag back: the previous version's migrate step accepts the newer database and changes nothing, and web and worker start on it.

One thing can't go back: **the job queue's schema**. When an update upgraded it, the migrate step says so ("The job queue schema went from version 46 to version 47"), and the previous version refuses to start on it (`/readyz` answers `job-queue-newer`). Going back then means restoring the Backup the migrate step took before that update, with the previous version (see "Restoring"): changes made since are lost.

A migration that fails is rolled back and stops the step; the ones before it stay applied, and the previous version runs on them. Fix the cause (or go back to the previous tag), then run the step again.

## Backups

A **Backup** (ADR 0032) is one archive of the whole Install, `webcraft-backup-<date>-<time>-<why>-<id>.tar`: a plain tar file holding

- `manifest.json`: when and why it was taken, the WebCraft version that wrote the data and the one that took it, the Module SDK version, the Modules and their versions, the migration level (every migration the database had), and the **Master key's fingerprint**, never the key;
- `database/*.copy.gz`: every row of WebCraft's tables and every Module's (partitioned tables included), and every sequence, as of one moment. The job queue isn't in it (jobs waiting at that moment are lost; see "Restoring"), nor the day's salts of Site analytics, which must not outlive their day;
- `files/…`: the files kept on local disk: Media originals and uploads waiting for the worker, Library files, files waiting for an Import and Form uploads. Media's resized copies (variants) aren't: a restore makes them again.

While the Install's storage is an **S3-compatible bucket**, its files stay there: a Backup doesn't copy them (the manifest says how many there are). Turn on the bucket's versioning or replication instead; a bucket is usually the safer copy.

**Taking one**:

- **Every day** at 01:11 UTC the worker takes one, while Install settings › Backups has scheduled Backups on (the default). It keeps the newest Backup of each of the last 7 days and of each of the last 4 weeks (Monday to Sunday, UTC), 7 to 11 archives, and removes older scheduled ones.
- **By the migrate step**, before it changes anything (see "Updates").
- **By command**: `webcraft admin backup` writes one where Install settings › Backups says, or `webcraft admin backup --to <file or folder>`.

**Where they go** (Install settings › Backups, the Superadmin): the **Backups folder** (`WEBCRAFT_BACKUP_DIR`, a volume on the server; copy its archives off the server too), or an **S3-compatible bucket**, under a `backups/` folder after the bucket's prefix, uploaded in parts. Use another bucket than Media's. The bucket's secret access key is stored encrypted under the Master key, like every secret; WebCraft writes, reads and removes a small file there before saving. Backups taken by command or by the migrate step are never removed by the keep rules.

A Backup that fails is in the Backup log on Install settings › Backups with why, in the log, and on a notice on every admin page for the Superadmin until one succeeds.

Every archive holds every local file, so each is about as big as the database plus local storage. Keep that in mind for the Backups volume's disk.

## Restoring

`webcraft admin restore <archive>` restores a whole Install (never one Site of it: Sites move by Site export, ADR 0033) into an empty database:

1. **Stop web and worker.** The command refuses to run while either is connected to the database.
2. Make sure the environment has the **Master key the Install had** when the Backup was taken: the command refuses another one (the manifest's fingerprint must match). The key is never in a Backup.
3. Run it with the Install's environment, the storage volume mounted, and the archive where the command can read it (a Backup in a bucket: download it first). It refuses a database that holds anything (`--force` replaces everything in it, once you type the database's name, or pass `--confirm <name>`), a Backup a newer WebCraft wrote or with migrations this version doesn't have, and a file that isn't a Backup.
4. It rebuilds the schema the Backup was taken at, loads every row in one transaction, writes the files back into local storage, then runs the migrate step: a Backup of an older version comes back up to the running one. It queues every image's variants to be made again (pages show the originals until the worker has made them), uploads still waiting to be cleaned and Import runs that were under way, and starts every Site's page cache and search index over.
5. Start web and worker.

Jobs that were waiting in the queue when the Backup was taken (emails being retried, Webhook deliveries) are not in it: their lines in the Email log and the delivery log stay as they were.

## The update check

Once a day the worker reads a public release feed for the newest WebCraft release, and the Superadmin sees "Update available" on the Install's pages (with a link to the release notes), and the version on Install settings › General. `webcraft admin check-update` reads it at once.

- The feed is the project's latest-release JSON on GitHub unless `WEBCRAFT_UPDATE_FEED` names another `https` address (an agency's own static file of `{ "version", "url", "notes" }`, or GitHub's release JSON of a fork); `WEBCRAFT_UPDATE_FEED=off` turns the check off.
- The request sends nothing about the Install: a plain `User-Agent: WebCraft`, no id, no version, no query added. It goes through the guarded fetcher (public addresses only, a timeout and a size limit), at most once a day, and the result is kept in the database: the admin never calls out itself.

## Visitors' addresses

Rate limits, lockouts, the sessions list, Consent records and Form spam limits count requests by the client's address. Behind a proxy, every connection comes from the proxy, so the Install believes what a **trusted proxy** says about whom it forwarded a request for, and nobody else:

- `X-Forwarded-For` is read from the right, past every trusted proxy, to the first address that isn't one. Anything to its left was written by the client and is ignored. From a connection that isn't a trusted proxy, the header is ignored altogether.
- `WEBCRAFT_TRUSTED_PROXIES` names the trusted proxies: IP addresses and ranges (`172.18.0.0/16`) separated by commas, where `private` stands for loopback and the private ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`); or `none`; or `railway`. A value that doesn't read stops web and worker at start, and so does a range covering every address.
- **Defaults**: behind Caddy (Compose) and Coolify's proxy, `private`: the proxy reaches the web process over a private Docker network, and the web process publishes no port of its own. On Railway, `railway`: Railway's edge publishes no address ranges and writes the client's address in `X-Real-IP`, replacing any a client sent, so that header is believed on connections from inside Railway's network (`100.64.0.0/10` and the private ranges).
- **A proxy of your own** in front (a load balancer): add its addresses, such as `WEBCRAFT_TRUSTED_PROXIES=private,198.51.100.0/24`. Never publish the web process's port directly to the internet while `private` is trusted.

### A CDN in front of a Site

A Site can sit behind a CDN. Connect each domain with the CDN's proxy off, wait until WebCraft has verified it and its certificate is issued, then turn the proxy on with full, strict TLS to the Install. Then choose the CDN on the Site's **Domains & Staging** screen (Staff): from then on, a request to that Site from one of the CDN's servers counts as coming from the visitor the CDN names in its own header (Cloudflare: `CF-Connecting-IP`; Fastly: `Fastly-Client-IP`).

The header is believed only on connections from the CDN's published address ranges (after the trusted proxies); from anywhere else it is ignored, so nobody can choose their address by sending it. A CDN's servers carry every customer's traffic, though, so someone with an account of their own at the same CDN could still send requests through it naming any address: the header keeps visitors apart for rate limits, but is no proof of who they are. The admin and the Install's own paths never read a Site's CDN header. The ranges ship with WebCraft, and the worker fetches the current list of each CDN that a Site uses once a day (`cdn.refresh-ranges`), keeping a list only when it reads as a sensible set of ranges; the web process picks up a new list within 5 minutes.

On Railway, Railway's edge may put the CDN's server in `X-Real-IP` rather than the visitor: choosing the CDN on the Site takes care of that too.

## Outgoing calls

WebCraft calls other servers directly. It has no outgoing proxy in v1: web and worker ignore `HTTP_PROXY` and `HTTPS_PROXY`. A server that may only reach the internet through a proxy isn't supported yet.

## Health checks

`/healthz` (the web process is up) and `/readyz` (the database answers and has every migration this version expects; 503 otherwise) answer on the admin host only, so a check must send `Host: <admin host>`; the web image's own health check does. On Railway they also answer on the hostname Railway's checks use.
