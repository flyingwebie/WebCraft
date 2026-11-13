// The CDNs a Site can sit behind with its visitors' addresses kept: each names the visitor in a
// header of its own and publishes the address ranges its servers connect from. Read by the admin too
// (`@webcraft/core/cdns`), so it imports nothing.

/** The CDNs WebCraft knows the header and published ranges of. */
export const CDN_KEYS = ["cloudflare", "fastly"] as const;

export type CdnKey = (typeof CDN_KEYS)[number];

export type CdnDefinition = {
	key: CdnKey;
	/** Its name, as people know it. */
	name: string;
	/** The header (lower case) its servers name the visitor's address in, replacing any a client sent. */
	header: string;
	/** Where it publishes the address ranges its servers connect from: an HTTPS address answering JSON. */
	list: string;
	/**
	 * The ranges in an answer from `list`, as written there (checked afterwards), or null when the
	 * answer isn't shaped as expected.
	 */
	read(answer: unknown): string[] | null;
};

export const CDNS: Readonly<Record<CdnKey, CdnDefinition>> = {
	cloudflare: {
		key: "cloudflare",
		name: "Cloudflare",
		header: "cf-connecting-ip",
		list: "https://api.cloudflare.com/client/v4/ips",
		read(answer) {
			const { success, result } = (answer ?? {}) as { success?: unknown; result?: Record<string, unknown> };
			if (success !== true || !result) return null;
			return strings(result.ipv4_cidrs, result.ipv6_cidrs);
		},
	},
	fastly: {
		key: "fastly",
		name: "Fastly",
		header: "fastly-client-ip",
		list: "https://api.fastly.com/public-ip-list",
		read(answer) {
			const { addresses, ipv6_addresses } = (answer ?? {}) as Record<string, unknown>;
			return strings(addresses, ipv6_addresses);
		},
	},
};

export function isCdnKey(value: unknown): value is CdnKey {
	return typeof value === "string" && (CDN_KEYS as readonly string[]).includes(value);
}

/** The strings of these lists together, or null when one isn't a list of strings. */
function strings(...lists: unknown[]): string[] | null {
	const found: string[] = [];
	for (const list of lists) {
		if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) return null;
		found.push(...list);
	}
	return found;
}
