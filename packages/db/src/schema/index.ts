// The Drizzle schema: every table WebCraft owns, re-exported from one file per area.
// `bun run db:generate` writes a migration for each change (see docs/development.md).
export * from "./api-tokens.ts";
export * from "./audit.ts";
export * from "./backups.ts";
export * from "./consent.ts";
export * from "./content.ts";
export * from "./dashboards.ts";
export * from "./design-system.ts";
export * from "./domains.ts";
export * from "./edit-mode.ts";
export * from "./email.ts";
export * from "./forms.ts";
export * from "./imports.ts";
export * from "./install.ts";
export * from "./languages.ts";
export * from "./media.ts";
export * from "./modules.ts";
export * from "./oauth.ts";
export * from "./people.ts";
export * from "./rate-limits.ts";
export * from "./search.ts";
export * from "./secrets.ts";
export * from "./seo.ts";
export * from "./site-scripts.ts";
export * from "./staging.ts";
export * from "./tenancy.ts";
export * from "./webhooks.ts";
