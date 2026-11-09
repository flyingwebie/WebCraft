# WebCraft on Railway

A Railway project runs the Install as three services: **web** and **worker** from WebCraft's images, and Railway's **Postgres**. Railway's edge answers HTTPS and issues every certificate (ADR 0015): Staff add each Site domain in Railway as well as in WebCraft. Railway allows only a limited number of custom domains per service (about 20 on Pro, 2 on Hobby), so it suits agencies with few Sites. Read [the overview](README.md) first.

## The template

The WebCraft template on Railway is made of these services and settings. To make it (or to set the project up by hand), create them as below; `deploy/railway/` holds each service's deploy settings in Railway's config-as-code format.

| Service | Source | Settings |
| --- | --- | --- |
| `Postgres` | Railway's Postgres | |
| `web` | Image `ghcr.io/flyingwebie/webcraft-web:<version>` | Public domain on port 3000. Pre-deploy command `webcraft admin migrate`. Health check path `/readyz` (timeout 120 s). Restart on failure. Settings as in `deploy/railway/web.railway.json`. |
| `worker` | Image `ghcr.io/flyingwebie/webcraft-worker:<version>` | No domain. Restart always. Settings as in `deploy/railway/worker.railway.json`. |

The web service's variables (Railway's own functions fill them in):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `WEBCRAFT_ADMIN_HOST` | `${{RAILWAY_PUBLIC_DOMAIN}}` (the service's Railway domain; change it to your own admin host once it is attached) |
| `WEBCRAFT_EDGE` | `railway` |
| `WEBCRAFT_SECRET_KEY` | `${{secret(48)}}`: 48 random characters, the Master key. Copy it into your password manager after the first deploy: it is never in a Backup. |
| `WEBCRAFT_SITES_DOMAIN` | Optional |
| `WEBCRAFT_PUBLIC_ADDRESSES` | Leave unset: Railway's addresses aren't fixed, so Site domains use a CNAME record. |
| `PORT` | `3000` |

The worker's variables are the web service's, by reference: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `WEBCRAFT_ADMIN_HOST=${{web.WEBCRAFT_ADMIN_HOST}}`, `WEBCRAFT_EDGE=railway`, `WEBCRAFT_SECRET_KEY=${{web.WEBCRAFT_SECRET_KEY}}`, `WEBCRAFT_SITES_DOMAIN=${{web.WEBCRAFT_SITES_DOMAIN}}`.

Deploying from a fork of the repository instead of the images: give each service the repository as its source and its file in `deploy/railway/` as its config file (`/deploy/railway/web.railway.json`, `/deploy/railway/worker.railway.json`); they build `apps/server/Dockerfile` and `apps/worker/Dockerfile`.

## Install

1. Deploy the template (or create the services above). The pre-deploy command runs the migrate step before every deploy of the web service, and Railway waits for `/readyz` before sending it traffic: on Railway, `/healthz` and `/readyz` also answer on `healthcheck.railway.app`, the hostname Railway's health checks use.
2. Open the web service's logs, find `setupUrl`, open it and create the Superadmin.
3. **Set up S3-compatible storage at once** (Install settings › Storage). A Railway volume belongs to one service, so web and worker can't share local storage: uploaded Media must go to a bucket both reach (Railway's buckets, or any S3-compatible service).

## Connecting a Site domain

1. In WebCraft, add the domain on the Site's **Domains & Staging** screen; it shows the CNAME record to the admin host.
2. In Railway, add the same domain to the **web** service (Settings › Networking › Custom domain). Railway asks for its own DNS records too (a CNAME and a TXT record); create those as Railway shows them.
3. Railway's edge issues the certificate; WebCraft verifies the domain with its HTTP self-check, following Railway's redirect from plain HTTP to HTTPS, every few minutes for the first hour.

## Visitors' addresses

Railway publishes no address ranges for its edge, and its hop count isn't fixed, so `X-Forwarded-For` can't be read safely by position. Railway's edge writes the client's address in `X-Real-IP` instead, replacing any a client sent; with `WEBCRAFT_EDGE=railway` the default trusted proxies are `railway`, which believes that header on connections from inside Railway's network (`100.64.0.0/10` and the private ranges) and ignores it on any other.

Known limits:

- Behind another proxy or CDN in front of Railway's edge, `X-Real-IP` holds that proxy's address, not the visitor's. For a CDN, choose it on the Site's Domains & Staging screen: the CDN's own header then names the visitor.
- Requests over Railway's private network (`*.railway.internal`) or a TCP proxy skip the edge, and anything there can write `X-Real-IP`. Don't add a TCP proxy to the web service, and run nothing else in the project that calls it privately.

## Updating, backups and commands

- **Updating**: change the image tag of web and worker to the new release and deploy; the pre-deploy command runs the migrate step first.
- **Backups**: Railway's Postgres has scheduled backups on paid plans; or run `pg_dump "$DATABASE_URL" -Fc` from a machine that reaches it. Media is in the S3-compatible bucket: use its versioning or replication. Keep the Master key apart.
- **Server commands**: `railway ssh` into the web service (or its shell in the Railway dashboard) and run `webcraft admin …`.
