// Refreshes the CDNs' address ranges WebCraft ships with (packages/core/src/cdns/bundled-ranges.ts),
// from the lists each CDN publishes, checked the way the worker's daily refresh checks them. Run it
// before a release: `bun run refresh:cdn-ranges`, then commit the file if it changed.
import { CDN_KEYS, CDN_LIST_MAX_BYTES, CDNS, checkCdnList } from "@webcraft/core";

const target = new URL("../packages/core/src/cdns/bundled-ranges.ts", import.meta.url);

const lists: Record<string, string[]> = {};
for (const cdn of CDN_KEYS) {
	const response = await fetch(CDNS[cdn].list, { headers: { accept: "application/json" }, redirect: "error" });
	if (!response.ok) throw new Error(`${CDNS[cdn].name}'s list answered ${response.status}.`);
	const text = await response.text();
	if (text.length > CDN_LIST_MAX_BYTES) throw new Error(`${CDNS[cdn].name}'s list is larger than expected.`);
	lists[cdn] = checkCdnList(cdn, JSON.parse(text));
}

const body = Object.entries(lists)
	.map(([cdn, ranges]) => `\t${cdn}: [\n${ranges.map((range) => `\t\t"${range}",`).join("\n")}\n\t],`)
	.join("\n");
await Bun.write(
	target,
	`// The address ranges each CDN published when this file was made, checked as the worker checks them:
// used until the worker's daily refresh has fetched a CDN's current list. Made by
// \`bun run refresh:cdn-ranges\` (scripts/refresh-cdn-ranges.ts); don't edit it by hand.
import type { CdnKey } from "./registry.ts";

export const BUNDLED_CDN_RANGES: Readonly<Record<CdnKey, readonly string[]>> = {
${body}
};
`,
);
console.log(
	`Wrote ${Object.values(lists).reduce((total, ranges) => total + ranges.length, 0)} ranges to ${target.pathname}.`,
);
