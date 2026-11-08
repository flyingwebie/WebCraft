import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// Run from the repo root: `bun run db:generate` (new migration from schema changes),
// `bun run db:generate --custom --name=<name>` (an empty migration for hand-written SQL).
export default defineConfig({
	dialect: "postgresql",
	schema: fileURLToPath(new URL("./src/schema/index.ts", import.meta.url)),
	out: fileURLToPath(new URL("./src/migrations", import.meta.url)),
	schemaFilter: ["public"],
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
});
