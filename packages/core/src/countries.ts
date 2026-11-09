import { readFile } from "node:fs/promises";

import { parseAddress } from "@webcraft/module-sdk";

import type { Logger } from "./log.ts";

/**
 * Countries: the country an address is in, which Site analytics counts visits by (ADR 0020). The
 * address is used for that only: never kept, never logged. Tests answer it from a small file of
 * their own.
 */
export type Countries = {
	/** The country of `address` (ISO 3166-1 alpha-2, upper case, such as `IE`), or null when unknown. */
	country(address: string | null): Promise<string | null>;
};

/** No list of address ranges: every country is unknown. */
export const unknownCountries: Countries = { country: async () => null };

type Ranges = { starts: bigint[]; ends: bigint[]; codes: string[] };

/**
 * Countries from a file of address ranges (`WEBCRAFT_COUNTRY_FILE`): one range per line, its first
 * address, its last address and a country code, separated by commas or tabs, IPv4 and IPv6 mixed,
 * which is how the freely licensed IP-to-country lists are published. Lines that don't read so
 * (a header, a comment) are skipped. Read once, when the first address is looked up.
 */
export function countriesFromFile(path: string, log: Logger): Countries {
	let loaded: Promise<{ v4: Ranges; v6: Ranges } | null> | undefined;
	const load = async () => {
		try {
			const ranges = readRanges(await readFile(path, "utf8"));
			log.info("Read the list of address ranges' countries", {
				file: path,
				ranges: ranges.v4.starts.length + ranges.v6.starts.length,
			});
			return ranges;
		} catch (error) {
			log.error("The list of address ranges' countries can't be read: every country is unknown", {
				file: path,
				error,
			});
			return null;
		}
	};
	return {
		async country(address) {
			if (address === null) return null;
			const parsed = parseAddress(address);
			if (!parsed) return null;
			loaded ??= load();
			const ranges = await loaded;
			if (!ranges) return null;
			return lookup(parsed.version === 4 ? ranges.v4 : ranges.v6, parsed.value);
		},
	};
}

/** The ranges in a file's text, each version sorted by its first address. */
export function readRanges(text: string): { v4: Ranges; v6: Ranges } {
	const rows: Record<4 | 6, { start: bigint; end: bigint; code: string }[]> = { 4: [], 6: [] };
	for (const line of text.split(/\r?\n/)) {
		const [first = "", last = "", code = ""] = line.split(/[,\t]/).map((part) => part.trim().replace(/^"|"$/g, ""));
		if (!/^[A-Za-z]{2}$/.test(code)) continue;
		const start = parseAddress(first);
		const end = parseAddress(last);
		if (!start || !end || start.version !== end.version || start.value > end.value) continue;
		rows[start.version].push({ start: start.value, end: end.value, code: code.toUpperCase() });
	}
	const sorted = (list: { start: bigint; end: bigint; code: string }[]): Ranges => {
		list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
		return {
			starts: list.map((row) => row.start),
			ends: list.map((row) => row.end),
			codes: list.map((row) => row.code),
		};
	};
	return { v4: sorted(rows[4]), v6: sorted(rows[6]) };
}

/** The country of the last range starting at or before `value`, if it reaches `value`. */
function lookup(ranges: Ranges, value: bigint): string | null {
	let low = 0;
	let high = ranges.starts.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((ranges.starts[middle] ?? 0n) <= value) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (found < 0 || (ranges.ends[found] ?? -1n) < value) return null;
	const code = ranges.codes[found] ?? null;
	// Lists mark addresses they don't place with codes that aren't countries.
	return code === "ZZ" || code === "XX" ? null : code;
}
