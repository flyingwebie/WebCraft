# Modules

First-party Modules, one workspace package each: `modules/<id>` (Site analytics, Forms, Popups,
Redirects and 404 log, Extra blocks, WordPress import, as their tickets add them).

A Module imports nothing from WebCraft but `@webcraft/module-sdk` (ADR 0024). Its `package.json`
depends on `@webcraft/module-sdk` and its own outside packages only; Biome and
`tests/modules/boundary.test.ts` refuse anything else. Add its default export (a `defineModule(…)`)
to `FIRST_PARTY_MODULES` in `packages/core/src/modules/first-party.ts`.

See `docs/development.md` › "Modules" for the SDK, and `tests/modules/sample/` for a Module that
uses every extension point but those one Module of a build keeps (Form Submissions, Redirect rules
and the 404 log): `modules/forms` and `modules/redirects` show those.
