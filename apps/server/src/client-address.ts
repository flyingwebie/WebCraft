import type { InstallConfig } from "@webcraft/core";

/** A request as the server hands it over: the address of the connection it came in on, when known. */
type ConnectedRequest = Request & { ip?: unknown };

/**
 * The address of the client a request came from, or null when the web process can't tell. Rate
 * limits, lockout records and the sessions list all take it from here, and nowhere else.
 *
 * For now it is the address of the connection itself: `serve.ts` sets it from Bun's server, and
 * the development server sets it the same way (`request.ip`). Headers such as `X-Forwarded-For`
 * are ignored, since any client can send them; trusting them from known proxies is the job of
 * `WEBCRAFT_TRUSTED_PROXIES` (it changes only this function).
 */
export function clientAddress(request: Request, _config: InstallConfig): string | null {
	const ip = (request as ConnectedRequest).ip;
	return typeof ip === "string" ? normaliseAddress(ip) : null;
}

/** Records the address of the connection a request came in on, as the server reports it. */
export function setConnectionAddress(request: Request, address: string | undefined): void {
	if (address) Object.defineProperty(request, "ip", { value: address, enumerable: true });
}

/** One spelling per address: IPv4 written plainly (not as `::ffff:203.0.113.7`), IPv6 in lower case. */
function normaliseAddress(address: string): string | null {
	const trimmed = address.trim().toLowerCase();
	if (trimmed === "") return null;
	const mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	return mapped?.[1] ?? trimmed;
}
