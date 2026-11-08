# Migrations run as a separate step, and every schema change keeps the previous version working

Database migrations run in their own one-off `migrate` step before the web process and the worker start: a short-lived service in Docker Compose, the pre-deploy command on Coolify and Railway. Web and worker refuse to start when the database is behind their version. When migrations are pending, `migrate` first takes a Backup (skippable with a flag), and each migration runs in a transaction, so a failure leaves the database as it was and the Superadmin goes back to the previous image tag.

There are no down-migrations. Every schema change is written so the previous WebCraft version still runs on the new schema: add first, remove in a later release. Going back one version is therefore always safe without touching the database.

## Considered Options

- **Migrate when the process starts**: rejected because the Bun web process and the Node worker start together and would race, and a half-started process could serve traffic on a schema it doesn't expect.
- **Down-migrations**: rejected because they are rarely tested, can lose data, and the add-first rule plus the automatic Backup covers rollback more safely.
- **Schema push without migration files**: rejected because it gives no reviewed, ordered history and can drop data silently.
