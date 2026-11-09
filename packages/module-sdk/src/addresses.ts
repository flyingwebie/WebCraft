/**
 * Address ranges (SDK 1.4): a Site setting such as "leave out our office's addresses" is a list of
 * ranges a Module keeps and hands back to WebCraft (`visitor.inRanges`), which compares the visitor's
 * address with them itself, so a Module never sees the address. A range is one address
 * (`203.0.113.7`, `2001:db8::1`) or a block in CIDR notation (`203.0.113.0/24`, `2001:db8::/32`).
 */

/** An address range, read: its IP version, its first address and the number of fixed leading bits. */
export type AddressRange = { version: 4 | 6; start: bigint; bits: number };

const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

/** An IPv4 address as a number, or null when `text` isn't one (four dotted decimals, no leading zeros). */
function ipv4(text: string): bigint | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	let value = 0n;
	for (const part of parts) {
		if (!IPV4_PART.test(part)) return null;
		const number = Number(part);
		if (number > 255) return null;
		value = (value << 8n) | BigInt(number);
	}
	return value;
}

/** An IPv6 address as a number, or null when `text` isn't one (`::` once at most, an IPv4 tail allowed). */
function ipv6(text: string): bigint | null {
	if (text.includes("%") || text.split("::").length > 2) return null;
	let groups: string[];
	const tail: bigint[] = [];
	let source = text;
	const lastColon = source.lastIndexOf(":");
	if (lastColon >= 0 && source.slice(lastColon + 1).includes(".")) {
		const four = ipv4(source.slice(lastColon + 1));
		if (four === null) return null;
		tail.push(four >> 16n, four & 0xffffn);
		source = source.slice(0, lastColon + 1);
		if (source.endsWith(":") && !source.endsWith("::")) source = source.slice(0, -1);
	}
	const [head = "", rest] = source.split("::");
	const split = (part: string) => (part === "" ? [] : part.split(":"));
	if (rest === undefined) {
		groups = split(head);
		if (groups.length + tail.length !== 8) return null;
	} else {
		const before = split(head);
		const after = split(rest);
		const missing = 8 - tail.length - before.length - after.length;
		if (missing < 1) return null;
		groups = [...before, ...Array<string>(missing).fill("0"), ...after];
	}
	let value = 0n;
	for (const group of groups) {
		if (!IPV6_GROUP.test(group)) return null;
		value = (value << 16n) | BigInt(Number.parseInt(group, 16));
	}
	for (const group of tail) value = (value << 16n) | group;
	return value;
}

/** An address, read: IPv4 written plainly or mapped into IPv6 (`::ffff:203.0.113.7`), or IPv6. */
export function parseAddress(text: string): { version: 4 | 6; value: bigint } | null {
	const trimmed = text.trim().toLowerCase();
	const four = ipv4(trimmed);
	if (four !== null) return { version: 4, value: four };
	const six = ipv6(trimmed);
	if (six === null) return null;
	// An IPv4 address mapped into IPv6 is the IPv4 address.
	if (six >> 32n === 0xffffn) return { version: 4, value: six & 0xffffffffn };
	return { version: 6, value: six };
}

/** A range, read, or null when `text` is neither an address nor a CIDR block. */
export function parseAddressRange(text: string): AddressRange | null {
	const [address = "", prefix, extra] = text.trim().split("/");
	if (extra !== undefined) return null;
	const parsed = parseAddress(address);
	if (!parsed) return null;
	const width = parsed.version === 4 ? 32 : 128;
	let bits = width;
	if (prefix !== undefined) {
		if (!/^(?:0|[1-9]\d{0,2})$/.test(prefix)) return null;
		bits = Number(prefix);
		if (bits > width) return null;
	}
	const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
	return { version: parsed.version, start: parsed.value & mask, bits };
}

/** Whether `text` is an address range: one address, or a CIDR block. */
export function isAddressRange(text: string): boolean {
	return parseAddressRange(text) !== null;
}

/** Whether `address` is in one of `ranges` (ranges that can't be read never match). */
export function addressInRanges(address: string, ranges: readonly string[]): boolean {
	const parsed = parseAddress(address);
	if (!parsed) return false;
	const width = parsed.version === 4 ? 32 : 128;
	return ranges.some((text) => {
		const range = parseAddressRange(text);
		if (!range || range.version !== parsed.version) return false;
		const mask = range.bits === 0 ? 0n : ((1n << BigInt(range.bits)) - 1n) << BigInt(width - range.bits);
		return (parsed.value & mask) === range.start;
	});
}
