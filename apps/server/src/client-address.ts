import { isIP } from "node:net";

import {
	CDNS,
	type InstallConfig,
	type InstallServices,
	type IpRange,
	inIpRange,
	PRIVATE_RANGES,
	parseIpAddress,
	parseIpRange,
	type SiteHost,
	type TrustedProxies,
} from "@webcraft/core";

/** A request as the server hands it over: the address of the connection it came in on, when known. */
type ConnectedRequest = Request & { ip?: unknown; [VISITOR]?: string | null };

/** Where the Site pipeline records a Site visitor's address, once it has worked it out. */
const VISITOR = Symbol("webcraft.visitorAddress");

/**
 * The address of the client a request came from, or null when the web process can't tell. Rate
 * limits, lockout records, the sessions list, Consent records, Form posts and Modules' Site routes all
 * take it from here, and nowhere else.
 *
 * It starts from the address of the connection (`serve.ts` sets it from Bun's server, the
 * development server the same way: `request.ip`). When that connection comes from a proxy the
 * Install trusts (`WEBCRAFT_TRUSTED_PROXIES`), the proxy's word on whom it forwarded for counts:
 * `X-Forwarded-For` read from the right, past every trusted proxy, to the first address that isn't
 * one (Railway's edge: `X-Real-IP`). From any other connection those headers are ignored, since
 * anyone can send them.
 *
 * On a Site's hostname, the Site pipeline may have gone one step further, to the visitor's address
 * a CDN in front of the Site gives (`recordVisitorAddress`); that answer comes first. The admin and
 * the Install's own paths never read a Site's CDN.
 */
export function clientAddress(request: Request, config: InstallConfig): string | null {
	const recorded = (request as ConnectedRequest)[VISITOR];
	if (recorded !== undefined) return recorded;
	return proxiedAddress(request, config.trustedProxies);
}

/**
 * Gives `to`, a request the Site pipeline makes for one it is answering (a Filter's fragments are the
 * page's), the client address `from` came from, so rate limits count the same visitor.
 */
export function sameClient(from: Request, to: Request): void {
	const recorded = (from as ConnectedRequest)[VISITOR];
	const ip = (from as ConnectedRequest).ip;
	if (recorded !== undefined) Object.defineProperty(to, VISITOR, { value: recorded, configurable: true });
	if (typeof ip === "string") Object.defineProperty(to, "ip", { value: ip, enumerable: true });
}

/** Records the address of the connection a request came in on, as the server reports it. */
export function setConnectionAddress(request: Request, address: string | undefined): void {
	if (address) Object.defineProperty(request, "ip", { value: address, enumerable: true });
}

/**
 * Works out the address of a visitor to a Site and records it on the request, for `clientAddress` to
 * answer from then on. It is `clientAddress`'s, unless the Site has a CDN in front (`host.cdn`) and
 * that address is one of the CDN's servers (its published ranges): then it is the visitor's address
 * the CDN gives in its own header (`CF-Connecting-IP`, `Fastly-Client-IP`), when that is one. From
 * anywhere else such a header is ignored, since anyone can send it.
 */
export async function recordVisitorAddress(request: Request, services: InstallServices, host: SiteHost): Promise<void> {
	let address = clientAddress(request, services.config);
	if (host.cdn !== null && address !== null && inRanges(address, await services.cdns.ranges(host.cdn))) {
		address = normaliseAddress(request.headers.get(CDNS[host.cdn].header) ?? "") ?? address;
	}
	Object.defineProperty(request, VISITOR, { value: address, configurable: true });
}

/** The client's address as the trusted proxies in front of the web process tell it. */
function proxiedAddress(request: Request, trusted: TrustedProxies): string | null {
	const ip = (request as ConnectedRequest).ip;
	const connection = typeof ip === "string" ? normaliseAddress(ip) : null;
	if (connection === null) return null;
	if (trusted.kind === "railway") {
		// Railway's edge reaches the service from inside Railway's network; a connection from anywhere
		// else didn't come through it.
		if (!inRanges(connection, compiled(RAILWAY_NETWORK))) return connection;
		return normaliseAddress(request.headers.get("x-real-ip") ?? "") ?? connection;
	}
	const ranges = compiled(trusted.ranges);
	const isProxy = (address: string) => inRanges(address, ranges);
	let address = connection;
	if (!isProxy(address)) return address;
	const hops = (request.headers.get("x-forwarded-for") ?? "").split(",");
	for (let index = hops.length - 1; index >= 0; index--) {
		const hop = hops[index]?.trim() ?? "";
		if (hop === "") continue;
		const forwarded = normaliseAddress(hop);
		// Nothing to the left of a hop that isn't an address can be believed.
		if (forwarded === null) return address;
		address = forwarded;
		if (!isProxy(address)) return address;
	}
	return address;
}

/**
 * Where Railway's edge connects from: inside Railway's network, which publishes no ranges of its own;
 * so far the shared address space (`100.64.0.0/10`), or private addresses.
 */
const RAILWAY_NETWORK: readonly string[] = ["100.64.0.0/10", ...PRIVATE_RANGES];

function inRanges(address: string, ranges: readonly IpRange[]): boolean {
	const parsed = parseIpAddress(address);
	return parsed !== null && ranges.some((range) => inIpRange(parsed, range));
}

const compiledRanges = new WeakMap<readonly string[], IpRange[]>();

function compiled(ranges: readonly string[]): IpRange[] {
	let found = compiledRanges.get(ranges);
	if (!found) {
		found = ranges.flatMap((range) => parseIpRange(range) ?? []);
		compiledRanges.set(ranges, found);
	}
	return found;
}

/**
 * One spelling per address: IPv4 written plainly (not as `::ffff:203.0.113.7`), IPv6 in lower case,
 * without brackets or a port (`[2001:db8::1]:443`, `203.0.113.7:51234`, as some proxies write them).
 * Null for anything that isn't an IP address.
 */
function normaliseAddress(address: string): string | null {
	let text = address.trim().toLowerCase();
	const bracketed = text.match(/^\[([^\]]+)\](?::\d+)?$/);
	if (bracketed?.[1]) text = bracketed[1];
	else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
	const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mapped?.[1]) text = mapped[1];
	return isIP(text) === 0 ? null : text;
}
