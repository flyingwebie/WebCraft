import { ipRangeText, parseIpRange } from "../ip-ranges.ts";
import { CDNS, type CdnKey } from "./registry.ts";

/** The most ranges a CDN's list may hold (the CDNs publish a few dozen). */
export const CDN_LIST_MAX_RANGES = 1000;

/** The largest answer a CDN's list may be. */
export const CDN_LIST_MAX_BYTES = 256 * 1024;

/**
 * The widest range a CDN's list may hold, by prefix length: no CDN connects from a whole `/8` of IPv4
 * or `/16` of IPv6, and a list that says so would let anyone in it choose their visitors' addresses.
 */
const WIDEST_PREFIX = { 4: 8, 6: 16 } as const;

/** A CDN's published list that can't be used; the Install keeps the ranges it had. */
export class CdnListInvalidError extends Error {
	override name = "CdnListInvalidError";
}

/**
 * The ranges in a CDN's published list, written one way (`ipRangeText`), or `CdnListInvalidError`
 * when the answer isn't the list's shape, holds something that isn't a range, a range wider than
 * `WIDEST_PREFIX`, no range at all, or more than `CDN_LIST_MAX_RANGES`.
 */
export function checkCdnList(cdn: CdnKey, answer: unknown): string[] {
	const entries = CDNS[cdn].read(answer);
	if (entries === null) throw new CdnListInvalidError(`The answer isn't ${CDNS[cdn].name}'s list of address ranges.`);
	if (entries.length === 0) throw new CdnListInvalidError("The list holds no address range.");
	if (entries.length > CDN_LIST_MAX_RANGES) {
		throw new CdnListInvalidError(`The list holds more than ${CDN_LIST_MAX_RANGES} address ranges.`);
	}
	const ranges = new Set<string>();
	for (const entry of entries) {
		const range = parseIpRange(entry);
		if (!range) throw new CdnListInvalidError(`"${entry.slice(0, 60)}" isn't an address range.`);
		if (range.prefix < WIDEST_PREFIX[range.family]) {
			throw new CdnListInvalidError(`${ipRangeText(range)} is wider than any CDN's servers.`);
		}
		ranges.add(ipRangeText(range));
	}
	return [...ranges];
}
