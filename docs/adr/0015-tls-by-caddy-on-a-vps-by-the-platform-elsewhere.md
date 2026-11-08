# Caddy issues certificates on a VPS; on Coolify and Railway the platform does

The plain Docker Compose setup ships Caddy with on-demand TLS: Caddy asks the Install whether a hostname belongs to a verified Site domain, so domains connect with no manual step. Coolify and Railway put their own proxy on ports 80 and 443, so Caddy can't run there. On those platforms Staff add each domain in the platform's panel as well, and the Install only verifies it with its HTTP self-check (`WEBCRAFT_EDGE=caddy|coolify|railway`). Railway allows about 20 custom domains per service, so it suits agencies with few Sites.

## Considered Options

- **Adding domains through the Coolify or Railway API**: left for later, because the Coolify API for this isn't confirmed and the Railway API has reported bugs.
- **Running our own Caddy behind the platform's proxy**: rejected because the platform proxy terminates TLS first, so Caddy never sees the handshake or the certificate challenge.
- **Cloudflare (or another CDN) issuing every Site's certificate**: rejected as the default because it charges per hostname and ties self-hosting to one vendor. A CDN can still sit in front of a Site.
