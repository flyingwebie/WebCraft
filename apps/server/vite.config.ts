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
	},
	environments: {
		ssr: {
			build: {
				rolldownOptions: {
					// @webcraft/db finds its migration files next to its own source, so the production
					// bundle loads it from there at run time instead of copying it into dist/server.
					external: ["@webcraft/db"],
				},
			},
		},
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
