// One outgoing call, described as data so the same call runs on Bun (in the test) and on Node (in
// `node-calls.ts`), and its outcome as data a test can compare. Runs on both runtimes: it imports
// nothing of Bun's.
import { createGuardedFetch, type Dns, type GuardedFetchOptions, type OutgoingHttp } from "@webcraft/core";

export type Call = {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** The address to connect to, handed to outgoing HTTP as the guarded fetcher does. */
	connectTo?: string;
	/** Made through the guarded fetcher instead, with a DNS that answers these names only. */
	guarded?: { dns: Record<string, string[]>; options: GuardedFetchOptions };
};

export type Outcome =
	| { status: number; headers: Record<string, string>; body: string }
	| { error: { name: string; message: string; code?: string; problem?: string } };

export async function runCall(http: OutgoingHttp, call: Call): Promise<Outcome> {
	try {
		const request = new Request(call.url, { method: call.method, headers: call.headers, body: call.body });
		const response = call.guarded
			? await createGuardedFetch({ http, dns: answering(call.guarded.dns) })(request, call.guarded.options)
			: await http(request, call.connectTo === undefined ? undefined : { connectTo: call.connectTo });
		return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
	} catch (error) {
		const { name = "Error", message = String(error), code, problem } = error as Record<string, string | undefined>;
		return { error: { name, message, ...(code ? { code } : {}), ...(problem ? { problem } : {}) } };
	}
}

function answering(answers: Record<string, string[]>): Dns {
	return {
		async resolve(hostname) {
			const addresses = answers[hostname];
			if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
			return addresses;
		},
	};
}
