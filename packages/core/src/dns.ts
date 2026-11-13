import { lookup } from "node:dns/promises";

/**
 * DNS: the addresses a host name resolves to, A and AAAA records both. The guarded fetcher checks
 * them before WebCraft calls a host. Tests answer it with a fake.
 */
export type Dns = { resolve(hostname: string): Promise<string[]> };

/** DNS through the operating system's resolver, as `fetch` itself resolves names. */
export const systemDns: Dns = {
	async resolve(hostname) {
		const answers = await lookup(hostname, { all: true, verbatim: true });
		return answers.map((answer) => answer.address);
	},
};
