// Client addresses of IPv6 connections. A connection has a whole /64 of its own (2^64 addresses) and
// may send each request from another one, so everything WebCraft counts per client address counts an
// IPv6 client by its /64. Tests of a per-address limit send its requests from addresses of one /64.

let networks = 0;

/**
 * A new IPv6 connection's /64 (under the documentation prefix `2001:db8::/32`): answers its address
 * number `host` (1, 2, …), each written differently from the next beyond the first 64 bits.
 */
export function ipv6Network(): (host: number) => string {
	const network = ++networks;
	return (host) =>
		`2001:db8:${(network >> 16).toString(16)}:${(network & 0xffff).toString(16)}:${host.toString(16)}::${host.toString(16)}`;
}
