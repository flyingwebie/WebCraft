// The web process's server entry, as TanStack Start expects it: a default export with `fetch`.
// `vite dev` loads it for every request Vite doesn't serve itself; `vite build` bundles it into
// dist/server/server.js, which src/serve.ts serves with Bun in production.
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

import { serveStaticFiles } from "./admin/static-files.ts";
import { createWebHandler } from "./handler.ts";
import { startWebServices } from "./web-services.ts";

const renderAdmin = createStartHandler(defaultStreamHandler);

const adminApp = import.meta.env.PROD
	? serveStaticFiles(new URL("../client/", import.meta.url), renderAdmin)
	: async (request: Request) => renderAdmin(request);

export default createServerEntry({
	fetch: createWebHandler({ services: await startWebServices(), adminApp }),
});
