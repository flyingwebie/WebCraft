# WebCraft on Coolify

`deploy/coolify/docker-compose.yml` runs the web process, the worker, the one-off migrate step and Postgres 18 as one Coolify resource. Coolify's own proxy answers HTTPS and issues every certificate, so there is no Caddy (ADR 0015): Staff add each Site domain in Coolify as well as in WebCraft. Read [the overview](README.md) first.

## Install

1. In Coolify, create a new resource from a **Docker Compose** file (an empty Compose service, or this repository with `deploy/coolify/docker-compose.yml` as the Compose file), on the server that should run the Install.
2. Coolify fills in its generated variables when it reads the file:
   - `SERVICE_FQDN_WEB_3000`: the web service's domain, routed to port 3000 of the web service. It becomes `WEBCRAFT_ADMIN_HOST`, so set the web service's domain to the admin host you want, such as `https://admin.agency.example:3000` (the `:3000` is the port inside the container; visitors use 443).
   - `SERVICE_USER_POSTGRES` and `SERVICE_PASSWORD_POSTGRES`: the database's user and password (letters and digits, safe in a connection string).
   - `SERVICE_REALBASE64_MASTERKEY`: the Master key, 32 random bytes in Base64. Copy it from Coolify's environment variables into your password manager now: it is never in a Backup.
3. Set, in the resource's environment variables:
   - `WEBCRAFT_VERSION`: the release to run, such as `1.0.0` (the file defaults to `main` until the first release).
   - Optionally `WEBCRAFT_PUBLIC_ADDRESSES` (the server's public IP addresses) and `WEBCRAFT_SITES_DOMAIN`. On Coolify each Staging address is a domain to add to the web service like a Site's (below), unless you set up Coolify's proxy for a wildcard certificate.
4. Deploy. The migrate step runs first (Coolify leaves it out of the resource's health, `exclude_from_hc`), then web and worker. Coolify waits for the web image's health check.
5. Open the web service's logs, find `setupUrl`, open it and create the Superadmin.

## Connecting a Site domain

Coolify's proxy only answers for domains it knows, so connecting a domain takes one step in each:

1. In WebCraft, add the domain on the Site's **Domains & Staging** screen; it shows the DNS records to create.
2. In Coolify, add the domain to the **web** service's domains, after the admin host (keep the admin host first: it is `WEBCRAFT_ADMIN_HOST`), with the same `:3000` port: `https://admin.agency.example:3000,https://bakery.example:3000`. Redeploy so the proxy picks it up.
3. Create the DNS records. Coolify's proxy issues the certificate; WebCraft verifies the domain with its HTTP self-check, following Coolify's redirect from plain HTTP to HTTPS, every few minutes for the first hour.

## Visitors' addresses

Coolify's proxy reaches the web process over a Docker network on the server, from a private address, so the default trusted proxies (`private`) are right: WebCraft reads `X-Forwarded-For` from the right, so it takes the address Coolify's proxy saw, whatever a client wrote to the left of it. If the server's Docker networks have no IPv6, visitors connecting over IPv6 reach the proxy through Docker's gateway and all share its address; giving Coolify's networks IPv6 fixes that.

## Updating, Backups and commands

- **Updating**: change `WEBCRAFT_VERSION` and redeploy. The migrate step runs before web and worker start on the new version, taking a Backup into the `backups` volume first when it has anything to do. Going back: see [the overview](README.md#going-back-a-version).
- **Backups**: the worker takes one every night into the `backups` volume (7 daily and 4 weekly are kept); Install settings › Backups can send them to an S3-compatible bucket instead, which also keeps them off the server. Coolify's own database backups of the Postgres service are a good extra copy, but they don't hold the local Media; WebCraft's Backups do. Keep the Master key apart from both.
- **Restoring**: stop the web and worker services, open a terminal in a container of the web image with the volumes mounted (or run `webcraft admin restore /var/lib/webcraft/backups/<archive>` as a one-off command of the web service), then start them again. See [the overview](README.md#restoring).
- **Server commands**: open a terminal in the web container in Coolify and run `webcraft admin …` (`backup`, `check-update`, `create-superadmin`, `rotate-key`).
