import { isIP } from "node:net";

/** Where a call pinned to an address goes. */
export type PinnedTarget = {
	/** The request's URL with the address in place of its host name (in brackets for IPv6). */
	url: URL;
	/** The URL's host name, without brackets: for SNI and the certificate check. */
	hostname: string;
	/** The URL's host name and port as the `Host` header carries them (`example.com`, `example.com:8080`). */
	host: string;
	secure: boolean;
	/** The port to connect to. */
	port: number;
};

/** Where a call to `url`, pinned to `address`, connects; refuses anything but http(s) and an IP address. */
export function pinnedTarget(url: string, address: string): PinnedTarget {
	const original = new URL(url);
	if (original.protocol !== "http:" && original.protocol !== "https:") {
		throw new TypeError(`Only http and https addresses are called, not ${original.protocol}`);
	}
	const family = isIP(address);
	if (family === 0) throw new TypeError(`A call is pinned to an IP address, not to ${address}.`);
	const pinned = new URL(original);
	pinned.hostname = family === 6 ? `[${address}]` : address;
	const secure = original.protocol === "https:";
	return {
		url: pinned,
		hostname: original.hostname.startsWith("[") ? original.hostname.slice(1, -1) : original.hostname,
		host: original.host,
		secure,
		port: original.port ? Number(original.port) : secure ? 443 : 80,
	};
}
