# A read-only Content API on the Site's domain, separate from the management API

WebCraft has two public APIs. The management API is the oRPC API that the admin, MCP server and CLI already use. It is documented with a generated OpenAPI spec and acts as a person through an API token. The Content API is a separate, read-only API for frontends built elsewhere. It is served from each Site's own domain at `/_content/v1/…`, is off by default, returns published content only, and is opened with a per-Site Content key that grants nothing else.

Both are versioned by a major version in the path. Changes within a major version are additive only. A breaking change ships as a new major version served next to the old one for at least 12 months, with a `Deprecation` header in that time.

## Considered Options

- **Only the management API, read with API tokens**: rejected because a token acts as a person and can change content, so it must never ship in an app or browser code. It also lives on the admin's domain, away from the Site's page cache and rate limits.
- **No delivery API in v1** (Markdown copies, sitemaps and Webhooks only): rejected because agencies routinely feed apps and partner widgets from the same content, and the renderer already resolves everything the API returns.
- **GraphQL or a free-form query language**: rejected because fixed filters, one sort and cursor pagination can be cached and rate limited predictably, and they reuse the Loop query engine.
- **Date-based version headers**: rejected because a path version is visible in logs, caches and docs, and an Install serves only a few majors at once.
- **Draft preview with a secret key**: left out of v1. Outside frontends preview from their own staging.
