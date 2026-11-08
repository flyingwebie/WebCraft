# Workspaces are kept apart by checks in our own data layer, not Postgres row-level security

All Workspaces share one Postgres database. Every query goes through one data layer in `packages/core` that cannot run without a Workspace (and a Site where it applies). Tests then confirm that each API procedure refuses another Workspace's data. Row-level security with Drizzle and pooled connections means setting the tenant on every transaction and debugging policies alongside the code. Every Workspace on an Install belongs to the same agency, so a leak would be serious but stays inside one agency.

## Considered Options

- **Row-level security as well as app checks**: deferred, not rejected. It is a later hardening step once the data layer is stable.
- **Row-level security only**: rejected because per-Site access and role rules still need app code, so the checks would be split across two places.
