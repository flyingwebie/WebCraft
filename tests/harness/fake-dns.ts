import type { Dns } from "@webcraft/core";

/**
 * DNS that never leaves the test: names resolve to the addresses a test gives them, and every other
 * name doesn't resolve, as an unknown name doesn't.
 */
export type FakeDns = {
	readonly resolver: Dns;
	/** Makes `hostname` resolve to `addresses` (an empty list: it doesn't resolve). */
	answer(hostname: string, addresses: readonly string[]): void;
	/** Every name looked up so far, oldest first. */
	readonly lookups: readonly string[];
};

export function createFakeDns(): FakeDns {
	const answers = new Map<string, readonly string[]>();
	const lookups: string[] = [];
	return {
		lookups,
		answer(hostname, addresses) {
			answers.set(hostname.toLowerCase(), addresses);
		},
		resolver: {
			async resolve(hostname) {
				lookups.push(hostname);
				const addresses = answers.get(hostname.toLowerCase());
				if (!addresses?.length)
					throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
				return [...addresses];
			},
		},
	};
}
