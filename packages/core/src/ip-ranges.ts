import { isIP } from "node:net";

/** An IP address as a number, IPv4 or IPv6. An IPv4 address written inside IPv6 (`::ffff:a.b.c.d`) is IPv4. */
export type IpAddress = { family: 4 | 6; value: bigint };

/** A range of IP addresses (`198.51.100.0/24`, `2001:db8::/32`): its first address and prefix length. */
export type IpRange = { family: 4 | 6; network: bigint; prefix: number };

const BITS = { 4: 32, 6: 128 } as const;

/**
 * The ranges that never reach a server from the public internet, where a deployment's own proxies
 * sit: loopback, the private IPv4 ranges (RFC 1918, which Docker networks use) and IPv6 unique local
 * addresses. `WEBCRAFT_TRUSTED_PROXIES=private` names them.
 */
export const PRIVATE_RANGES = [
	"127.0.0.0/8",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"::1/128",
	"fc00::/7",
] as const;

/** Reads an IP address, or null when the text isn't one. IPv6 may be written in brackets. */
export function parseIpAddress(text: string): IpAddress | null {
	let address = text.trim();
	if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
	const family = isIP(address);
	if (family === 4) return { family: 4, value: ipv4Value(address) };
	if (family !== 6) return null;
	const words = ipv6Words(address);
	if (!words) return null;
	const value = words.reduce((total, word) => (total << 16n) | BigInt(word), 0n);
	// IPv4-mapped (::ffff:a.b.c.d): an IPv4 client on a dual-stack socket.
	if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
	return { family: 6, value };
}

/**
 * Reads an address or a range in CIDR notation (`10.0.0.0/8`, `2001:db8::/32`, `203.0.113.7`: a range
 * of one), or null. Bits after the prefix are cleared, so `10.1.2.3/8` is `10.0.0.0/8`.
 */
export function parseIpRange(text: string): IpRange | null {
	const [addressText = "", prefixText, extra] = text.trim().split("/");
	if (extra !== undefined) return null;
	const address = parseIpAddress(addressText);
	if (!address) return null;
	const bits = BITS[address.family];
	let prefix: number = bits;
	if (prefixText !== undefined) {
		if (!/^\d{1,3}$/.test(prefixText)) return null;
		prefix = Number(prefixText);
		if (prefix > bits) return null;
	}
	return { family: address.family, network: address.value & mask(address.family, prefix), prefix };
}

/** Whether an address is inside a range. */
export function inIpRange(address: IpAddress, range: IpRange): boolean {
	return address.family === range.family && (address.value & mask(range.family, range.prefix)) === range.network;
}

/** A range in CIDR notation, written one way: `10.0.0.0/8`, `2001:db8::/32`. */
export function ipRangeText(range: IpRange): string {
	return `${addressText(range.family, range.network)}/${range.prefix}`;
}

/**
 * The network a client address counts as where attempts are counted per network: an IPv4 address
 * itself, the /64 of an IPv6 address (one connection is given a whole /64, so its addresses are one
 * client), and `unknown` for no address or text that isn't one.
 */
export function clientNetwork(address: string | null): string {
	const parsed = address === null ? null : parseIpAddress(address);
	if (!parsed) return "unknown";
	if (parsed.family === 4) return addressText(4, parsed.value);
	return ipRangeText({ family: 6, network: parsed.value & mask(6, 64), prefix: 64 });
}

function mask(family: 4 | 6, prefix: number): bigint {
	const bits = BigInt(BITS[family]);
	const all = (1n << bits) - 1n;
	return (all << (bits - BigInt(prefix))) & all;
}

function ipv4Value(address: string): bigint {
	return address.split(".").reduce((total, part) => (total << 8n) | BigInt(Number(part)), 0n);
}

/** The eight 16-bit words of an IPv6 address (with any dotted IPv4 tail), or null. */
function ipv6Words(address: string): number[] | null {
	let text = address.toLowerCase().split("%")[0] ?? "";
	const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted?.[1]) {
		const [p = 0, q = 0, r = 0, s = 0] = dotted[1].split(".").map(Number);
		text = `${text.slice(0, -dotted[1].length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((word) =>
		Number.parseInt(word, 16),
	);
	return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
		? words
		: null;
}

function addressText(family: 4 | 6, value: bigint): string {
	if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
	const words = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) => Number((value >> shift) & 0xffffn));
	// The longest run of zero words (two or more) becomes `::`.
	let best = { start: -1, length: 0 };
	for (let start = 0; start < 8; start++) {
		let length = 0;
		while (start + length < 8 && words[start + length] === 0) length++;
		if (length > best.length) best = { start, length };
	}
	const hex = words.map((word) => word.toString(16));
	if (best.length < 2) return hex.join(":");
	return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.length).join(":")}`;
}
