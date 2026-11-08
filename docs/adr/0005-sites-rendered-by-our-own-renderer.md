# Sites are rendered by WebCraft's own renderer, not a web framework

Sites are rendered by a small WebCraft module that turns stored Templates, Components and Entries into semantic HTML. It runs inside the Install's single web process, which sends each request to the admin or to the renderer by hostname. Templates are data (ADR 0002) and Sites render on request (ADR 0004), so a framework's file-based routing and build step add nothing. A renderer of our own ships no JavaScript by default, adds the Edit mode tags itself, and powers the visual builder's preview too.

## Considered Options

- **Astro for Sites**: rejected because serving many Sites by hostname from the database forces full server rendering, which drops the static builds that are Astro's main strength while keeping its build and routing model in the way.
- **Routes inside the admin's framework**: rejected because Site output would carry the admin's React runtime and conventions, and the renderer could no longer be split into its own process later.
- **A separate Site server process from day one**: rejected for v1 because it adds a service to deploy; the renderer stays a separate module so it can be split out without a rewrite.
