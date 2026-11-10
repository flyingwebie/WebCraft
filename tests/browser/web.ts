// The production web process (apps/server/src/serve.ts), started with the test suite's Modules so
// the browser tests see the Module screens with Modules on them. The web process loads the Modules
// a program hands it in its own process before it starts (`webModules()` in web-services.ts).

import { type OpenInstallOptions, systemDns } from "@webcraft/core";
import { createBunHttp } from "../../apps/server/src/outgoing-http.ts";
import { TEST_MODULES } from "../harness/modules.ts";
import { liveWordpressReply } from "./live-wordpress.ts";

(globalThis as { webcraftModules?: unknown }).webcraftModules = TEST_MODULES;
const http = createBunHttp();
(globalThis as { webcraftWebPorts?: Pick<OpenInstallOptions, "http" | "dns"> }).webcraftWebPorts = {
	dns: {
		resolve: (host) => (host === "live-browser.example" ? Promise.resolve(["93.184.216.80"]) : systemDns.resolve(host)),
	},
	http: async (request, options) => {
		const url = new URL(request.url);
		if (url.hostname !== "live-browser.example") return http(request, options);
		const reply = liveWordpressReply(url);
		return new Response(reply.body, { headers: reply.headers });
	},
};
await import("../../apps/server/src/serve.ts");
