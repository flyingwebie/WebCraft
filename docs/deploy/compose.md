# WebCraft with Docker Compose

One server of your own (2 vCPUs and 2 GB of memory to start) runs the whole Install: `deploy/compose/docker-compose.yml` has the web process, the worker, a one-off migrate step, Postgres 18 and Caddy. Caddy answers HTTPS for every hostname and issues each certificate on demand, after asking the Install whether the hostname is its own (ADR 0015), so Site domains connect with no step on the server. Read [the overview](README.md) first.

## What you need

- A server with Docker and the Compose plugin, ports 80 and 443 open to the internet (443 over UDP too, for HTTP/3), and nothing else listening on them.
- DNS records pointing at the server: the admin host (`admin.agency.example`), and, for Staging addresses, a wildcard under the sites domain (`*.sites.agency.example`).

## Install

1. Copy `deploy/compose/docker-compose.yml`, `deploy/compose/Caddyfile` and `deploy/compose/.env.example` into one folder on the server, and rename `.env.example` to `.env`.
2. Fill in `.env`:
   - `WEBCRAFT_VERSION`: the release to run, such as `1.0.0`.
   - `WEBCRAFT_ADMIN_HOST` and, optionally, `WEBCRAFT_SITES_DOMAIN`.
   - `WEBCRAFT_PUBLIC_ADDRESSES`: the server's public IPv4 and IPv6 addresses, so the Domains screen can show Staff the A and AAAA records to create.
   - `WEBCRAFT_SECRET_KEY`: `openssl rand -base64 32`. Store a copy in your password manager now.
   - `POSTGRES_PASSWORD`: `openssl rand -hex 32` (it goes in a connection string, so no symbols).
   - Optionally `WEBCRAFT_CADDY_OPTIONS=email you@agency.example`, an address the certificate authority may write to.
3. Start it: `docker compose up -d`. The migrate step runs, then web and worker start, then Caddy.
4. Find the setup link: `docker compose logs web | grep setupUrl`, open it, and create the Superadmin.

## How the pieces connect

- **Caddy** publishes ports 80 and 443 and passes every request to the web process, which tells the admin and every Site apart by hostname. Before it issues a certificate it asks `http://<admin host>:3000/caddy/ask?domain=<name>`: the web process says yes for the admin host, the Staging address of an existing Site and every verified Site domain. Every other hostname gets no certificate. Inside the Compose file the admin host is a network alias of the web service, on a network only Caddy and the web process share, so the ask reaches it with the admin host as its `Host`.
- **Plain HTTP** goes on to HTTPS, except `/_webcraft/verify/…`: a new domain's verification request comes over plain HTTP, since the domain has no certificate until it is verified.
- **The web process** publishes no port of its own: Caddy is its only way in, which is why the private ranges are its trusted proxies (`WEBCRAFT_TRUSTED_PROXIES` unset). If you put a load balancer of your own in front, add its addresses (see the overview).
- **Web and worker** share the `storage` volume (Media on local disk) and reach Postgres over the Compose network; Postgres publishes no port.

To use other host ports for Caddy (another proxy on the server has 80 and 443), set `WEBCRAFT_HTTP_PORT` and `WEBCRAFT_HTTPS_PORT`; certificates on demand then need that proxy to pass ports 80 and 443 through to Caddy unchanged.

An external Postgres works too: replace `DATABASE_URL` in the Compose file's shared settings and remove the `postgres` service.

## Server commands

The `webcraft` command is in the web image:

```sh
docker compose exec web webcraft admin create-superadmin you@agency.example
docker compose run --rm migrate                       # the migrate step on its own
```

Rotating the Master key: stop web and worker (`docker compose stop web worker`), put the new key in `.env`, run `docker compose run --rm -e WEBCRAFT_OLD_SECRET_KEY='<old key>' web webcraft admin rotate-key`, then `docker compose up -d`.

## Updating

```sh
# set WEBCRAFT_VERSION in .env to the new release
docker compose pull
docker compose up -d
```

The migrate step runs before web and worker start on the new version. To go back, set the previous version and run the same two commands.

## Backups

```sh
# The database (custom format; restore with pg_restore)
docker compose exec -T postgres pg_dump -U webcraft -Fc webcraft > webcraft-$(date +%F).dump

# Uploaded Media, while the Install's storage is local disk
docker run --rm -v webcraft_storage:/storage:ro -v "$PWD":/backup alpine \
  tar czf /backup/webcraft-storage-$(date +%F).tar.gz -C /storage .
```

(`webcraft_storage` is the volume's name with the default project name, `webcraft`.) Copy both off the server, and keep the Master key somewhere else again. To restore, with the same Master key in `.env`:

```sh
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U webcraft -d webcraft --clean --if-exists < webcraft-2026-11-09.dump
docker run --rm -v webcraft_storage:/storage -v "$PWD":/backup alpine \
  tar xzf /backup/webcraft-storage-2026-11-09.tar.gz -C /storage
docker compose up -d
```

## Testing the files

`bun run test:deploy` (in a checkout of the repository, with Docker running) builds both images, starts this Compose file under a project of its own on free local ports, and checks that the migrate step finishes, `/readyz` answers through Caddy over HTTPS with a certificate issued on demand (from Caddy's own local authority, since there is no public DNS), plain HTTP goes on to HTTPS except domain verification, an unknown hostname gets no certificate, the admin renders, the setup link is logged, the worker works, and the `webcraft` command runs. It removes its own project when it ends (`--keep` leaves it running). CI runs it on every pull request.
