import type { OutgoingHttp } from "@webcraft/core";

/** An outgoing request as the fake received it, with the body already read. */
export type RecordedRequest = {
	method: string;
	url: string;
	headers: Headers;
	body: string;
};

/** How the fake answers: a status (200 unless given), a text body and headers. */
export type FakeAnswer = {
	status?: number;
	body?: string;
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

export function createFakeHttp(): FakeHttp {
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
		async fetch(request) {
			const recorded: RecordedRequest = {
				method: request.method,
				url: request.url,
				headers: new Headers(request.headers),
				body: await request.text(),
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
			return new Response(answer.body ?? null, { status: answer.status ?? 200, headers: answer.headers });
		},
	};
}
