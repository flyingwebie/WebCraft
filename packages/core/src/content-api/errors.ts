/**
 * The Content API's refusals (ADR 0029): each answers as JSON, `{ code, status, message, data }`, the
 * shape the Management API answers in, with a stable `code` frontends can rely on. `CONTENT_API_ERRORS`
 * lists every code with its status and what it means; the Content API's OpenAPI document and
 * `docs/development.md` list the same.
 */
export const CONTENT_API_ERRORS = {
	CONTENT_API_OFF: { status: 404, meaning: "The Site's Content API is switched off (the default)." },
	NOT_FOUND: { status: 404, meaning: "No such path in the Content API." },
	METHOD_NOT_ALLOWED: { status: 405, meaning: "Only GET, HEAD and OPTIONS (a CORS preflight) are answered." },
	CONTENT_KEY_INVALID: {
		status: 401,
		meaning:
			"The request carries no Content key (`data.problem`: `missing`), or one that isn't this Site's (`unknown`) or was revoked (`revoked`).",
	},
	CONTENT_KEY_IN_QUERY: {
		status: 400,
		meaning: "A key was sent in the query string, where logs keep it: send it in the `Authorization` header.",
	},
	ORIGIN_NOT_ALLOWED: {
		status: 403,
		meaning: "A browser on another site sent the request, and the key doesn't list its origin (`data.origin`).",
	},
	TOO_MANY_REQUESTS: {
		status: 429,
		meaning:
			"Past a limit (`data.limit`: `key`, 600 a minute per Content key, or `address`, 120 a minute per client address); wait `Retry-After` seconds.",
	},
	QUERY_INVALID: {
		status: 400,
		meaning:
			"The query string asks for something the API can't answer: `data.problems`, each with its `parameter` and `problem`.",
	},
	POST_TYPE_NOT_FOUND: { status: 404, meaning: "The Site exposes no Post Type with that key." },
	ENTRY_NOT_FOUND: { status: 404, meaning: "No published Entry of that Post Type, shown in the language, is there." },
	ENTRY_GONE: { status: 410, meaning: "The Entry was published, then unpublished." },
	MEDIA_NOT_FOUND: { status: 404, meaning: "The Site has no ready Media item with that id (or it is in the Trash)." },
} as const;

export type ContentApiErrorCode = keyof typeof CONTENT_API_ERRORS;

/** A refusal of the Content API, answered as `{ code, status, message, data }`. */
export class ContentApiError extends Error {
	override name = "ContentApiError";
	readonly code: ContentApiErrorCode;
	readonly status: number;
	readonly data: Record<string, unknown> | undefined;
	/** Headers the answer carries besides (`Allow`, `Retry-After`). */
	readonly headers: Record<string, string>;
	constructor(
		code: ContentApiErrorCode,
		message: string,
		data?: Record<string, unknown>,
		headers: Record<string, string> = {},
	) {
		super(message);
		this.code = code;
		this.status = CONTENT_API_ERRORS[code].status;
		this.data = data;
		this.headers = headers;
	}

	/** The JSON body it answers with. */
	body(): { code: string; status: number; message: string; data?: Record<string, unknown> } {
		return {
			code: this.code,
			status: this.status,
			message: this.message,
			...(this.data === undefined ? {} : { data: this.data }),
		};
	}
}
