# TanStack Start vs Astro — admin app vs Site rendering

**Date:** 2026-11-05

## Summary (3-5 lines)

TanStack Start (1.0, stable since late 2025, on top of TanStack Router) is a React SSR-first framework built for interactive apps: it has first-class server functions and typed server routes, deploys to Node/Docker and to Cloudflare Workers, and is the natural fit for the **admin**. Astro is a content/SSG-first, multi-framework "islands" meta-framework with per-page static/on-demand rendering, mature Cloudflare Workers + Node/Docker adapters, built-in i18n routing, and minimal JS by default — it is the natural fit for **Sites**. Neither framework has a built-in incremental/on-demand *rebuild* system like Next's ISR; both would need bespoke caching/invalidation for a DB-driven, per-tenant templating model. shadcn/ui has official install guides for both Astro and TanStack Router (Start rides on Router), so shadcn is usable on either surface. Better-T-Stack can scaffold either framework (`--frontend astro` or `--frontend tanstack-start`), so it doesn't force the admin/Sites decision by itself.

## Comparison table

| Dimension | TanStack Start | Astro |
|---|---|---|
| Rendering model | SSR-by-default React app (client-rendered SPA shell + server rendering via Nitro/Vite); no static-site generation mode | Static (SSG) by default per-page; `export const prerender = false` or `output: 'server'` flips to on-demand SSR per route; "hybrid" = mixing both in one project |
| Islands / partial hydration | No — it's a full React app, framework-native (whole-page client JS) | Yes — "islands architecture" is the core model; components hydrate independently via `client:*` directives, zero JS by default |
| Server functions | `createServerFn()` — type-safe RPC callable from loaders/components; same-origin only, CSRF-protected via Start's middleware | No direct equivalent; closest is Astro Actions (typed server mutations) or API endpoints in `src/pages/api/*.ts` |
| API / server routes | `server` property on `createFileRoute` (file-based, method-keyed handlers, supports middleware) — same-origin and cross-origin clients | File-based API routes under `src/pages/**/*.ts` exporting HTTP-method functions; requires `output: 'server'` or per-route `prerender = false` |
| Maturity/stability | 1.0 declared stable (TanStack blog, after RC in Sep 2025); active 2026 releases (Rsbuild 2 support added, security patch Oct 2026); still young relative to Next/Astro | Astro is older/more mature (v6 shipped in 2026 with a Rust-based compiler beta and queued rendering engine; v7 alpha in progress); large existing production install base |
| Docker/VPS deploy | Vite build → Nitro output run via `node .output/server/index.mjs`; or Rsbuild → serve `dist/client` + custom Node server (e.g. `srvx`); no official Dockerfile template shown in docs, but "works with any Node host" | `@astrojs/node` adapter; official docs give a sample Dockerfile (Node LTS base, `npm run build`, `node ./dist/server/entry.mjs`); env vars must be supplied by the host/compose file |
| Cloudflare deploy | Official Cloudflare Workers partner integration via `@cloudflare/vite-plugin` + Wrangler (`wrangler deploy`); docs don't mention Cloudflare Pages, only Workers | Official `@astrojs/cloudflare` adapter (`astro add cloudflare`), targets Cloudflare Workers (Pages migration path documented separately); known gotchas: Node-API incompatibilities, Auto-Minify hydration-mismatch bug |
| i18n routing | No built-in i18n; relies on TanStack Router's generic path/param routing plus a userland i18n library (e.g. i18next) and manual locale segments | Built-in `i18n` config: `locales`/`defaultLocale`, per-locale folders under `src/pages/`, `prefixDefaultLocale`, domain-per-locale (`i18n.domains`, SSR+adapter only), fallback + `routing: "manual"` escape hatch, `Astro.preferredLocale` browser-language detection |
| Light/dark theming | Plain React app — any theming approach (CSS vars + `next-themes`-style context, Tailwind `dark:` classes) works unmodified | Works the same way per-island; dark-mode toggle needs a tiny client island (inline script or hydrated component) since most of the page has no JS by default |
| shadcn/ui support | Official shadcn docs ship a TanStack Router installer path: `pnpm create tsrouter-app@latest --template file-router --tailwind --add-ons shadcn`; a dedicated "tanstack-start" install page returned 404 at research time — Start rides on Router's install path | Official dedicated Astro guide (`shadcn init -t astro`); requires the Astro React integration + Tailwind; components still render/hydrate as React islands inside `.astro` files |
| DB-rendered content, per-Site templates, multi-tenant by hostname | Every request already hits a server (SSR-by-default), so per-hostname template resolution + DB fetch is a normal server-function/loader concern — straightforward, no extra adapter needed | Requires `output: 'server'` (or per-route `prerender=false`) to read the `Host` header and resolve per-tenant content/templates at request time; Astro's default SSG mindset works against a "render from DB at runtime" model unless this mode is set project/route-wide |
| Incremental / on-demand rebuilds | None built-in; it's a server-rendered app, so there's no "rebuild" step at all — every request is live, which sidesteps the ISR problem but means no edge-cached static output unless you add your own HTTP caching | None built-in either; Astro's model is build-time SSG + optional per-route on-demand SSR, but there's no ISR/stale-while-revalidate primitive shipped by the framework — Cloudflare/Netlify adapters can add CDN caching with custom cache headers, but true incremental rebuild-on-change is not a first-class Astro feature |

## (a) The Better-T-Stack command

`bun create better-t-stack@latest my-better-t-app --frontend astro --backend self --runtime none --api orpc --auth better-auth --payments none --database postgres --orm drizzle --db-setup docker --package-manager bun --git --web-deploy docker --server-deploy none --install --addons biome fumadocs mcp opentui vite-plus --examples none`

What each flag/addon does, per the official CLI options reference (better-t-stack.dev/docs/cli/options):

- `--frontend astro`: scaffolds an Astro frontend app (one of several valid values — `tanstack-router`, `react-router`, `tanstack-start`, `next`, `nuxt`, `svelte`, `solid`, `astro`, or native options — confirming **TanStack Start is a first-class alternative** to Astro in this CLI).
- `--backend self`: a self-hosted/custom backend rather than one of the stack's managed backend templates; documented as incompatible with Tauri/Electrobun addons, and Clerk auth only works with `self` when paired with Next.js or TanStack Start (not Astro) — a relevant constraint if auth = Clerk were chosen later.
- `--runtime none`: no managed JS runtime wrapper selected (paired with `--backend self`).
- `--api orpc`: wires an oRPC (OpenAPI-compatible, typed) API layer as the client↔server contract, as an alternative to tRPC.
- `--auth better-auth`: wires Better Auth into the generated backend.
- `--payments none`, `--database postgres`, `--orm drizzle`, `--db-setup docker` (Postgres via Docker Compose), `--package-manager bun`, `--git` (init a repo), `--install` (run package installs).
- `--web-deploy docker`: generates a Dockerfile + root `docker-compose.yml` for self-hosted deployment of the web app — directly relevant to WebCraft's "Docker on a VPS" requirement.
- `--server-deploy none`: no managed server-deploy target configured (consistent with self-hosting via Docker instead).
- Addons:
  - `biome`: linting + formatting (Biome) instead of ESLint/Prettier.
  - `fumadocs`: adds a `apps/fumadocs` documentation site to the generated monorepo — a docs site generator, not a CMS feature.
  - `mcp`: installs an MCP server (including Better-T-Stack's own `bts_plan_project`/`bts_create_project` tools) for agent-driven project scaffolding — a developer-tooling addon, not app code.
  - `opentui`: adds OpenTUI (terminal UI) components — for building CLI/TUI tooling, irrelevant to a web CMS.
  - `vite-plus`: adds the "Vite+" unified toolchain (workspace task runner, lint/format, optional native git hooks) layered on top of Vite.
- Confirmed: **Better-T-Stack does offer a `tanstack-start` frontend option**, so it can scaffold the direct A/B comparison the ticket asks about by swapping only `--frontend`.
- **Addons that look unnecessary for a CMS**: `fumadocs` (a separate docs site generator — WebCraft doesn't need a docs site bundled into the product monorepo), `opentui` (terminal UI widgets — no obvious use for a web CMS's admin or Sites), and `mcp` (agent-authoring tooling for *generating more Better-T-Stack projects*, not a runtime dependency WebCraft would ship). `biome` and `vite-plus` are plausibly useful generic tooling choices, not CMS-specific bloat.

## (b) `bunx --bun shadcn@latest apply --preset b1Fk3bmIS`

Per shadcn's official changelog entries (`2026-04-shadcn-apply`, `2026-04-partial-preset-apply` on ui.shadcn.com):

- `shadcn apply` applies a **preset** (a shareable, encoded bundle of theme/base/RTL/font/icon choices, normally built visually at `ui.shadcn.com/create`) to an **existing** project.
- Running it with `--preset <code>` (here `b1Fk3bmIS`) re-applies that specific preset's theme: it reinstalls the project's existing components against the new preset and updates theme, colors, CSS variables, fonts, and icon set.
- It preserves the project's current **base** style and **RTL** setting even if the preset itself was generated with different values for those.
- A partial-apply flag, `--only theme,font`, can restrict the operation to just theme and/or font changes while leaving components untouched (documented as currently supporting `theme` and `font` as the `--only` values).
- If no preset code is given, the CLI offers to open the interactive preset builder in a browser instead.
- One third-party doc (ui.full.dev) cautions that `apply` only reinstalls components that come from the official shadcn/ui registry — components pulled from other/custom registries need a separate `add --overwrite` pass, and running a full `apply` in a project using a different base registry can add unwanted packages.
- The specific preset id `b1Fk3bmIS` is an opaque, generated code; it cannot be decoded from documentation alone (shadcn's preset-builder tool or a `preset decode <code>` command, per community docs, would be needed to inspect what look/choices it encodes).

## Implications for WebCraft (options, not decisions)

- **Split-framework option**: use TanStack Start for the admin (interactive SSR React app, server functions for CRUD against Workspaces/Sites/Members, typed API/server routes for webhooks) and Astro for Sites (static-by-default marketing/content pages, per-route `prerender=false` for dynamic forms and Inline-editing-aware pages). This matches each framework's design center but means two frameworks, two deployment pipelines, and two shadcn install paths to keep in sync for a consistent design system.
- **Single-framework option (Astro only)**: run the admin as Astro `output: 'server'` React islands too, accepting less SPA-like interactivity in the admin but a single build/deploy pipeline and one shadcn setup.
- **Single-framework option (TanStack Start only)**: render Sites through TanStack Start's SSR instead of static generation, accepting no build-time HTML for Sites (every Site request is live-rendered from the DB) and giving up static/CDN-only hosting for simple Sites, in exchange for one codebase/framework for both surfaces and simpler per-hostname, per-Site DB-template resolution (since Start has no SSG mode to fight against).
- **Multi-tenant-by-hostname rendering**: for Astro, this requires committing Sites to `output: 'server'` (or `prerender=false` everywhere Host-based resolution is needed) since SSG can't branch per-request on a hostname; for TanStack Start, hostname-based resolution is just normal server-function/loader logic since every request is already server-rendered.
- **Incremental/on-demand rebuilds**: neither framework ships Next-style ISR. If WebCraft needs "edit in admin → Site updates without a full rebuild," both options point toward SSR/on-demand rendering (reading straight from the DB per request, with WebCraft's own HTTP/CDN caching and cache-busting) rather than relying on a framework-level incremental static regen feature; a build-and-redeploy-per-Site pipeline (e.g., triggering a Cloudflare Pages build per Site) remains possible with Astro but adds build-queue infrastructure WebCraft would have to own either way.
- **Better-T-Stack as scaffolder**: could be used as a one-time scaffold (either `--frontend astro` or `--frontend tanstack-start`) to bootstrap the chosen stack's wiring (oRPC, Better Auth, Drizzle/Postgres, Docker Compose), then stripped of the CMS-irrelevant addons (`fumadocs`, `opentui`, `mcp`) — or skipped entirely in favor of hand-rolling the same pieces, since none of its addons are CMS-specific.
- **shadcn presets** (`apply --preset <code>`) could standardize Workspace-level or agency-level white-label theming (colors/fonts/icons) for the admin, but the mechanism is React/Tailwind-CSS-variable based and preset codes are opaque — WebCraft would need to decide whether per-Workspace branding is implemented via shadcn presets specifically or via its own theme-token system that both the admin and Sites can read from the DB.

## Sources

- TanStack Start hosting guide — https://tanstack.com/start/latest/docs/framework/react/guide/hosting
- TanStack Start server functions guide — https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
- TanStack Start server routes guide — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes (and `.md` variant)
- TanStack Start blog / 1.0 stability + 2026 changes (via search of tanstack.com/blog and GitHub releases, e.g. https://github.com/TanStack/router/releases/tag/release-2026-08-03-2216)
- Astro on-demand rendering guide — https://docs.astro.build/en/guides/on-demand-rendering/
- Astro Node adapter / Docker guide — https://docs.astro.build/en/guides/integrations-guide/node/
- Astro internationalization guide — https://docs.astro.build/en/guides/internationalization/
- Astro Cloudflare deployment guide — https://docs.astro.build/en/guides/deploy/cloudflare/
- Astro version history (third-party mirror of official changelog, used only for recency signal) — https://www.gitclear.com/open_repos/withastro/astro/release/astro@6.2.0 and astro@7.0.0-alpha.2
- shadcn/ui Astro installation guide — https://ui.shadcn.com/docs/installation/astro
- shadcn/ui TanStack Router installation guide — https://ui.shadcn.com/docs/installation/tanstack-router
- shadcn `apply` command changelog — https://ui.shadcn.com/docs/changelog/2026-04-shadcn-apply
- shadcn partial preset apply changelog — https://ui.shadcn.com/docs/changelog/2026-04-partial-preset-apply
- Better-T-Stack CLI options reference — https://www.better-t-stack.dev/docs/cli/options
- Better-T-Stack agent workflows (MCP addon) — https://www.better-t-stack.dev/docs/cli/agent-workflows
- Better-T-Stack project structure (Vite+/Fumadocs addon details) — https://better-t-stack.dev/docs/project-structure
