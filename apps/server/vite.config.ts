import { connect } from "node:net";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

import { ADMIN_DRAFTS_PREFIX, EDIT_DRAFTS_PREFIX } from "./src/co-editing/paths.ts";

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
					external: [/^@webcraft\/db(\/|$)/, /^drizzle-orm(\/|$)/, /^@tailwindcss\/(node|oxide)$/],
				},
			},
		},
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact(), draftSockets()],
});

/**
 * Co-editing's WebSockets in development (ADR 0025): the dev server hands the upgrades of Drafts'
 * sockets to a Bun server on the loopback interface that answers them with the same code as
 * production (`src/socket-serving.ts` and the handler's `upgrade`), keeping the request's own Host and
 * Origin, and pipes the connection through. Vite's own sockets are left alone.
 */
function draftSockets(): Plugin {
	let internal: Promise<number> | null = null;
	const start = async (server: ViteDevServer): Promise<number> => {
		const serving = await server.ssrLoadModule("/src/socket-serving.ts");
		const entry = async () => (await server.ssrLoadModule("/src/server.ts")).default;
		const bun = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request, at) => serving.answerUpgrade((await entry()).upgrade, request, at),
			websocket: serving.socketHandlers,
		});
		return Number(bun.port);
	};
	return {
		name: "webcraft-draft-sockets",
		apply: "serve",
		configureServer(server) {
			server.httpServer?.on("upgrade", (request, socket, head: Buffer) => {
				const path = request.url ?? "";
				if (!path.startsWith(ADMIN_DRAFTS_PREFIX) && !path.startsWith(EDIT_DRAFTS_PREFIX)) return;
				internal ??= start(server);
				internal.then(
					(port) => {
						const upstream = connect(port, "127.0.0.1", () => {
							const lines = [`${request.method} ${path} HTTP/1.1`];
							for (let index = 0; index < request.rawHeaders.length; index += 2) {
								lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
							}
							upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
							if (head.length > 0) upstream.write(head);
							upstream.pipe(socket);
							socket.pipe(upstream);
						});
						upstream.on("error", () => socket.destroy());
						socket.on("error", () => upstream.destroy());
					},
					() => socket.destroy(),
				);
			});
		},
	};
}
