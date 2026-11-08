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

export function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
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
