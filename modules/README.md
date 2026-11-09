# Modules

First-party Modules, one workspace package each: `modules/<id>` (Site analytics, Forms, Popups,
Redirects and 404 log, Extra blocks, WordPress import, as their tickets add them).

A Module imports nothing from WebCraft but `@webcraft/module-sdk` (ADR 0024). Its `package.json`
depends on `@webcraft/module-sdk` and its own outside packages only; Biome and
`tests/modules/boundary.test.ts` refuse anything else. Add its default export (a `defineModule(…)`)
to `FIRST_PARTY_MODULES` in `packages/core/src/modules/first-party.ts`.

See `docs/development.md` › "Modules" for the SDK, `tests/modules/sample/` for a Module that uses
every extension point up to SDK 1.3, `modules/site-analytics/` for SDK 1.4's, and `modules/redirects/`
for SDK 1.5's (Redirect rules and the 404 log), `modules/wordpress-import/` for SDK 1.7's import
sources (a Module reads its file into items; WebCraft's Import pipeline does the rest), and
`modules/site-analytics/` again for SDK 1.8's Dashboard Widgets. One Module of
a build keeps Form Submissions, Redirect rules and the 404 log: `modules/forms` and
`modules/redirects` show those.
