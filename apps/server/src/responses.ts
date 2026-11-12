import { bodyOverflowed } from "@webcraft/core";

/** Answers every request the web process handles itself. */
export type Handler = (request: Request) => Promise<Response>;

/**
 * A plain-text response with nothing that names WebCraft: Site visitors and unknown hostnames
 * must not learn what serves them.
 */
export function plainText(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	});
}

export function notFound(): Response {
	return plainText(404, "Not Found");
}

/** The answer to a request whose body is larger than the web process reads. */
export function payloadTooLarge(): Response {
	return plainText(413, "Payload Too Large");
}

/**
 * A route's answer, or 413 in its place once the request's body passed the ceiling every request
 * comes under (`underBodyCeiling`): whatever the route made of a body cut short, or however it
 * failed on it, isn't an answer to what was sent.
 */
export async function withinBodyCeiling(
	request: Request,
	answer: () => Promise<Response>,
	refusal: () => Response = payloadTooLarge,
): Promise<Response> {
	try {
		const response = await answer();
		return bodyOverflowed(request) ? refusal() : response;
	} catch (error) {
		if (bodyOverflowed(request)) return refusal();
		throw error;
	}
}

export function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	});
}

/** Lets only GET and HEAD through, and drops the body of a HEAD answer. */
export async function readOnly(request: Request, answer: () => Promise<Response> | Response): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return plainText(405, "Method Not Allowed", { allow: "GET, HEAD" });
	}
	const response = await answer();
	if (request.method === "HEAD") {
		await response.body?.cancel();
		return new Response(null, { status: response.status, headers: response.headers });
	}
	return response;
}
