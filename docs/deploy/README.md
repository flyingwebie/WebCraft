# Deploying WebCraft

An Install runs on one of three supported targets:

| Target | Guide | Files | What answers HTTPS (`WEBCRAFT_EDGE`) |
| --- | --- | --- | --- |
| A server of your own (a VPS) with Docker Compose | [compose.md](compose.md) | `deploy/compose/` | Caddy, in the Compose file (`caddy`) |
| Coolify | [coolify.md](coolify.md) | `deploy/coolify/` | Coolify's proxy (`coolify`) |
| Railway | [railway.md](railway.md) | `deploy/railway/` | Railway's edge (`railway`) |

The images are plain, so other hosts may work, but only these three are supported. A server with 2 vCPUs and 2 GB of memory is enough to start.

This page covers what every target shares: the images, the settings, the first start, the Master key, updates, backups, and how the Install tells visitors' addresses apart behind a proxy or a CDN.

## The images

Two images, published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

- `ghcr.io/flyingwebie/webcraft-web`: the web process (Bun): the admin, the APIs and every Site. It also holds the `webcraft` command for the server commands (`webcraft admin migrate`, `create-superadmin`, `rotate-key`), so `docker compose exec web webcraft admin …` works. Its health check asks `/readyz` on the admin host.
- `ghcr.io/flyingwebie/webcraft-worker`: the worker (Node LTS): jobs, image processing, email, Webhooks and Domain checks. It answers no HTTP, so it has no health check.

Tags: a release `v1.2.3` is published as `1.2.3`, `1.2`, `1` and `latest`; the `main` branch as `main` and `sha-<commit>`. Pin an exact release (`1.2.3`) in production, so an update happens only when you change it. Both images run as an unprivileged user (uid 1000) and keep files in `/var/lib/webcraft/storage`, a volume they share.

The images are built from this repository by `.github/workflows/images.yml` (`apps/server/Dockerfile`, `apps/worker/Dockerfile`). To build one yourself: `docker build -f apps/server/Dockerfile -t webcraft-web .` from the repo root.

## Settings

Every setting is an environment variable; web, worker and the migrate step get the same ones. The full list is in [`docs/development.md`](../development.md#environment-variables). Those an Install sets:

| Variable | What to put there |
| --- | --- |
| `DATABASE_URL` | The Postgres connection string. Each target's files fill it in. |
| `WEBCRAFT_ADMIN_HOST` | The admin's hostname, such as `admin.agency.example`: no scheme, port or path. Choose it before the first start: passkeys and the links in emails already sent are tied to it. |
| `WEBCRAFT_SITES_DOMAIN` | Optional: the domain Staging addresses sit under (`sites.agency.example` gives `bakery.sites.agency.example`), with a wildcard DNS record pointing at the Install. |
| `WEBCRAFT_SECRET_KEY` | The Master key (see below). |
| `WEBCRAFT_EDGE` | `caddy`, `coolify` or `railway`. Each target's files set it. |
| `WEBCRAFT_PUBLIC_ADDRESSES` | Optional: the Install's public IP addresses, separated by commas. Site domains point their A and AAAA records at them; without it, the Domains screen offers only a CNAME record to the admin host. |
| `WEBCRAFT_TRUSTED_PROXIES` | Optional: the proxies whose word on a visitor's address is believed (see "Visitors' addresses"). Each target's default is right unless you add a proxy of your own. |

Web and worker refuse to start when a setting is missing or malformed, when the database is behind (run the migrate step), or when `WEBCRAFT_SECRET_KEY` isn't the Install's Master key; the log says which and how to fix it.

## The first start

1. The migrate step runs first and creates the database's tables (each target's files run it before web and worker, on every deploy).
2. The web process prints a **setup link** in its log (`setupUrl`, with a one-time `setupToken`) while the Install has no Superadmin. Open it on the admin host to create the Superadmin. On a server without a browser, `webcraft admin create-superadmin <email>` does the same from the shell.
3. In the admin, confirm you have stored the Master key outside the server (a banner asks until you do), set up the Install SMTP, and approve the first-party Modules.

## The Master key

`WEBCRAFT_SECRET_KEY` encrypts every stored secret (SMTP passwords, AI keys, Webhook and CDN secrets). It is at least 32 characters; `openssl rand -base64 32` makes one (Coolify and Railway generate it). Keep a copy outside the server, in a password manager: it is never in the database or in a Backup (ADR 0032), and without it the stored secrets can't be read (content and Media are not affected). To change it, use `webcraft admin rotate-key` (see [`docs/development.md`](../development.md#rotating-the-master-key)), never just a new value.

## Updates

Change the image tag (`WEBCRAFT_VERSION`) and deploy again. The migrate step applies the new version's migrations first; web and worker start only once it has finished, and refuse to start on a database that is behind (ADR 0031). Every migration keeps the previous version working, so going back one version is changing the tag back. There is no one-click update: it would need the Docker socket.

## Backups

Until `webcraft admin backup` comes (with scheduled Backups), back up the two things that hold an Install's data, and keep the Master key apart from both:

- **The database**, with `pg_dump` (each guide has the command for its target).
- **The storage volume** (`/var/lib/webcraft/storage`): uploaded Media while the Install's storage is local disk (Install settings › Storage). With an S3-compatible bucket, use the bucket's own versioning or replication instead.

Restore into an empty database of the same or a newer WebCraft version, with the same Master key, then run the migrate step.

## Visitors' addresses

Rate limits, lockouts, the sessions list, Consent records and Form spam limits count requests by the client's address. Behind a proxy, every connection comes from the proxy, so the Install believes what a **trusted proxy** says about whom it forwarded a request for, and nobody else:

- `X-Forwarded-For` is read from the right, past every trusted proxy, to the first address that isn't one. Anything to its left was written by the client and is ignored. From a connection that isn't a trusted proxy, the header is ignored altogether.
- `WEBCRAFT_TRUSTED_PROXIES` names the trusted proxies: IP addresses and ranges (`172.18.0.0/16`) separated by commas, where `private` stands for loopback and the private ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`); or `none`; or `railway`. A value that doesn't read stops web and worker at start, and so does a range covering every address.
- **Defaults**: behind Caddy (Compose) and Coolify's proxy, `private`: the proxy reaches the web process over a private Docker network, and the web process publishes no port of its own. On Railway, `railway`: Railway's edge publishes no address ranges and writes the client's address in `X-Real-IP`, replacing any a client sent, so that header is believed on connections from inside Railway's network (`100.64.0.0/10` and the private ranges).
- **A proxy of your own** in front (a load balancer): add its addresses, such as `WEBCRAFT_TRUSTED_PROXIES=private,198.51.100.0/24`. Never publish the web process's port directly to the internet while `private` is trusted.

### A CDN in front of a Site

A Site can sit behind a CDN. Connect each domain with the CDN's proxy off, wait until WebCraft has verified it and its certificate is issued, then turn the proxy on with full, strict TLS to the Install. Then choose the CDN on the Site's **Domains & Staging** screen (Staff): from then on, a request to that Site from one of the CDN's servers counts as coming from the visitor the CDN names in its own header (Cloudflare: `CF-Connecting-IP`; Fastly: `Fastly-Client-IP`).

The header is believed only on connections from the CDN's published address ranges (after the trusted proxies); from anywhere else it is ignored, so nobody can choose their address by sending it. The admin and the Install's own paths never read a Site's CDN header. The ranges ship with WebCraft, and the worker fetches the current list of each CDN that a Site uses once a day (`cdn.refresh-ranges`), keeping a list only when it reads as a sensible set of ranges; the web process picks up a new list within 5 minutes.

On Railway, Railway's edge may put the CDN's server in `X-Real-IP` rather than the visitor: choosing the CDN on the Site takes care of that too.

## Outgoing calls

WebCraft calls other servers directly. It has no outgoing proxy in v1: web and worker ignore `HTTP_PROXY` and `HTTPS_PROXY`. A server that may only reach the internet through a proxy isn't supported yet.

## Health checks

`/healthz` (the web process is up) and `/readyz` (the database answers and has every migration this version expects; 503 otherwise) answer on the admin host only, so a check must send `Host: <admin host>`; the web image's own health check does. On Railway they also answer on the hostname Railway's checks use.
