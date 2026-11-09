import { isIP } from "node:net";

import type { Dns, OutgoingHttp } from "@webcraft/core";

/** An outgoing request as the fake received it, with the body already read. */
export type RecordedRequest = {
	method: string;
	url: string;
	headers: Headers;
	/** The body as text. */
	body: string;
	/** The body as it was sent, byte for byte (for binary bodies, such as files sent to storage). */
	bytes: Uint8Array;
	/**
	 * The address the call connected to: the one the caller pinned it to (`connectTo`), or else the
	 * first one DNS answers for the URL's host at that moment, as a runtime's own `fetch` resolves the
	 * name again when it connects. Null when the name doesn't resolve.
	 */
	address: string | null;
};

/** How the fake answers: a status (200 unless given), a body (text or bytes) and headers. */
export type FakeAnswer = {
	status?: number;
	body?: string | Uint8Array | null;
	headers?: Record<string, string>;
};

type Responder = (request: RecordedRequest) => FakeAnswer | Promise<FakeAnswer>;

/**
 * Outgoing HTTP that never touches the network. Tests say how each address answers; a request
 * nobody prepared an answer for fails, the way an unreachable server does.
 */
export type FakeHttp = {
	/** The function WebCraft code calls instead of `fetch`. */
	readonly fetch: OutgoingHttp;
	/**
	 * Answers requests whose method and URL match, with a fixed answer or one computed from the
	 * request. A URL given as a string must match exactly. The newest matching rule wins.
	 */
	respond(method: string, url: string | RegExp, answer: FakeAnswer | Responder): void;
	/** Every request made so far, oldest first. */
	readonly requests: readonly RecordedRequest[];
	/** Forgets the recorded requests and every rule. */
	reset(): void;
};

/** A request that no rule answers. */
export class UnexpectedRequestError extends TypeError {
	override name = "UnexpectedRequestError";
}

/** `dns` is the DNS a call that isn't pinned to an address resolves its host through. */
export function createFakeHttp(dns?: Dns): FakeHttp {
	const rules: { method: string; url: string | RegExp; answer: FakeAnswer | Responder }[] = [];
	const requests: RecordedRequest[] = [];

	return {
		requests,
		respond(method, url, answer) {
			rules.unshift({ method: method.toUpperCase(), url, answer });
		},
		reset() {
			rules.length = 0;
			requests.length = 0;
		},
		async fetch(request, options) {
			const bytes = new Uint8Array(await request.arrayBuffer());
			const recorded: RecordedRequest = {
				method: request.method,
				url: request.url,
				headers: new Headers(request.headers),
				body: new TextDecoder().decode(bytes),
				bytes,
				address: options?.connectTo ?? (await resolveHost(new URL(request.url).hostname, dns)),
			};
			requests.push(recorded);
			const rule = rules.find(
				(candidate) =>
					candidate.method === recorded.method &&
					(typeof candidate.url === "string" ? candidate.url === recorded.url : candidate.url.test(recorded.url)),
			);
			if (!rule) {
				throw new UnexpectedRequestError(
					`No fake answer for ${recorded.method} ${recorded.url}. Prepare one with install.http.respond().`,
				);
			}
			const answer = typeof rule.answer === "function" ? await rule.answer(recorded) : rule.answer;
			const body = answer.body instanceof Uint8Array ? new Uint8Array(answer.body) : (answer.body ?? null);
			return new Response(body, { status: answer.status ?? 200, headers: answer.headers });
		},
	};
}

/** The first address `hostname` resolves to (an IP address resolves to itself), or null. */
async function resolveHost(hostname: string, dns: Dns | undefined): Promise<string | null> {
	const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
	if (isIP(bare)) return bare;
	const addresses = await dns?.resolve(bare).catch(() => []);
	return addresses?.[0] ?? null;
}
