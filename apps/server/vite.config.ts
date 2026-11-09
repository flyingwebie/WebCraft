import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite dev` is the web process in development: TanStack Start sends every request Vite doesn't
// serve itself to src/server.ts, which routes it by hostname. `vite build` bundles the same entry
// for production (see src/serve.ts).
export default defineConfig({
	server: {
		port: Number(process.env.PORT ?? 3000),
		strictPort: true,
	},
	resolve: {
		tsconfigPaths: true,
		// css-tree (the Design system's CSS parser) loads its syntax data from JSON files at run time,
		// which a bundle can't follow; its own prebuilt bundle has the data inside.
		alias: [{ find: /^css-tree$/, replacement: "css-tree/dist/csstree.esm" }],
	},
	environments: {
		ssr: {
			build: {
				rolldownOptions: {
					// @webcraft/db finds its migration files next to its own source, so the production
					// bundle loads it (and its schema) from there at run time instead of copying it into
					// dist/server. Drizzle stays outside too, so the bundle and @webcraft/db share one copy.
					external: [/^@webcraft\/db(\/|$)/, /^drizzle-orm(\/|$)/],
				},
			},
		},
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
