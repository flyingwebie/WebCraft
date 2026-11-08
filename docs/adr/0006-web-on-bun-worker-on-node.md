# The web process runs on Bun, the background worker on Node

An Install runs two processes from one codebase: the web process (admin, Site renderer, forms, MCP server) on Bun 1.4, and the background job worker on Node LTS. Bun officially supports the admin framework and is fast, but the job queue and Postgres drivers have little evidence of running for long periods under Bun, and job reliability (Webhooks, email, AI translation) matters more than speed there. Shared code therefore uses only standard Node and Web APIs and one Postgres driver (`pg`), so the worker can move to Bun later by changing only its image.

## Considered Options

- **Bun for both processes**: rejected for now because there is no record of the job queue running long-term on Bun, and the Postgres drivers have reported bugs on Bun.
- **Node for both processes**: rejected because the web process works on Bun and gains from it; Node stays the fallback if Bun causes trouble in production.
