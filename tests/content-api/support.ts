// The Content API as frontends built elsewhere use it (ADR 0029): `GET /_content/v1/…` on a Site's
// domains and its Staging address, with a Content key in the `Authorization` header, from a server
// (no `Origin`) or from a browser on another site (`Origin`, after a CORS preflight).
import { fromAddress, type TestInstall } from "../harness/index.ts";

/** A frontend reading one Site's Content API from one client address. */
export type ContentClient = {
	/** Sends `GET <origin>/_content/v1<path>` with the key (unless `init` sets `authorization`). */
	get(path: string, init?: RequestInit): Promise<Response>;
	/** `get`, then the answer's JSON (and the response). */
	json<Body = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ response: Response; body: Body }>;
	/** Sends any request to `<origin>/_content/v1<path>`, without the key unless `init` sets one. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** The client address it sends from. */
	address: string;
};

let addresses = 0;

/** A frontend's client for the Content API at `origin`, sending `key` (none for null), from an address of its own. */
export function contentClient(
	install: TestInstall,
	origin: string,
	key: string | null,
	options: { address?: string } = {},
): ContentClient {
	const address = options.address ?? `198.18.${(++addresses >> 8) & 255}.${addresses & 255}`;
	const request = (path: string, init: RequestInit = {}) =>
		install.request(fromAddress(new Request(`${origin}/_content/v1${path}`, init), address));
	const get = (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		if (key !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
		return request(path, { ...init, headers });
	};
	return {
		get,
		request,
		address,
		async json<Body>(path: string, init?: RequestInit) {
			const response = await get(path, init);
			const text = await response.text();
			return { response, body: (text === "" ? undefined : JSON.parse(text)) as Body };
		},
	};
}
