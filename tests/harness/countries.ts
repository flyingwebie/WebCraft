import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The countries a test Install places addresses in: a small file of address ranges in the format the
 * Install reads (`WEBCRAFT_COUNTRY_FILE`), over the documentation ranges, so tests can send requests
 * from an address in a known country. Every other address (such as the test browsers' `10.x.x.x`) is
 * in no country it knows.
 */
export const TEST_COUNTRIES = {
	"203.0.113.0/24": "IE",
	"198.51.100.0/24": "IT",
	"192.0.2.0/24": "FR",
	"2001:db8::/32": "DE",
} as const;

const LINES = [
	"range_start,range_end,country_code",
	"192.0.2.0,192.0.2.255,FR",
	"198.51.100.0,198.51.100.255,IT",
	"203.0.113.0,203.0.113.255,IE",
	"2001:db8::,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,DE",
];

let written: string | undefined;

/** The file, written once per test process. */
export function testCountryFile(): string {
	if (!written) {
		written = join(mkdtempSync(join(tmpdir(), "webcraft-countries-")), "countries.csv");
		writeFileSync(written, `${LINES.join("\n")}\n`);
	}
	return written;
}
