import type { Dns } from "@webcraft/core";

/**
 * DNS that never leaves the test: names resolve to the addresses a test gives them, and every other
 * name doesn't resolve, as an unknown name doesn't.
 */
export type FakeDns = {
	readonly resolver: Dns;
	/** Makes `hostname` resolve to `addresses` (an empty list: it doesn't resolve). */
	answer(hostname: string, addresses: readonly string[]): void;
	/**
	 * Makes `hostname` give each answer in turn, one per lookup, then keep giving the last: a DNS server
	 * that changes its answer between two lookups of the same name, as in DNS rebinding.
	 */
	answerInTurn(hostname: string, answers: readonly (readonly string[])[]): void;
	/** Every name looked up so far, oldest first. */
	readonly lookups: readonly string[];
};

export function createFakeDns(): FakeDns {
	const answers = new Map<string, (readonly string[])[]>();
	const lookups: string[] = [];
	return {
		lookups,
		answer(hostname, addresses) {
			answers.set(hostname.toLowerCase(), [addresses]);
		},
		answerInTurn(hostname, inTurn) {
			answers.set(hostname.toLowerCase(), [...inTurn]);
		},
		resolver: {
			async resolve(hostname) {
				lookups.push(hostname);
				const queue = answers.get(hostname.toLowerCase());
				const addresses = queue && queue.length > 1 ? queue.shift() : queue?.[0];
				if (!addresses?.length)
					throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
				return [...addresses];
			},
		},
	};
}
