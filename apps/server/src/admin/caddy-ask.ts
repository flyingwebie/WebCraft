import { domainName, type InstallServices } from "@webcraft/core";

import { plainText } from "../responses.ts";

/**
 * Where Caddy asks before it gets a certificate on demand (ADR 0015): `GET /caddy/ask?domain=<name>`
 * on the admin host. Point Caddy's `on_demand_tls { ask … }` here.
 */
export const CADDY_ASK_PATH = "/caddy/ask";

/**
 * Caddy's ask: 200 for a hostname a certificate may be issued for (the admin host, a Site's Staging
 * address, a verified domain), 404 for every other one, 400 for anything that isn't a hostname. It
 * reads at most one row and writes nothing (no rate limit, no log line), so anyone asking about many
 * names costs the Install almost nothing; it only tells what anyone can see from the certificates.
 */
export async function caddyAsk(services: InstallServices, request: Request): Promise<Response> {
	if (request.method !== "GET") return plainText(405, "Method Not Allowed", { allow: "GET" });
	const asked = new URL(request.url).searchParams.get("domain") ?? "";
	const name = asked.length <= 253 ? domainName(asked) : null;
	if (!name) return plainText(400, "Bad Request");
	return (await services.domains.approvesCertificate(name)) ? plainText(200, "OK") : plainText(404, "Not Found");
}
