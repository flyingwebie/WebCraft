// The Management API on a Site's own address (ADR 0037), as the building area's shell calls it: the
// oRPC protocol the admin uses, at `/_webcraft/build/api/rpc/<path>`, from the Site's own page, with
// the edit cookie, the building-area cookie and the session's header token.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { BuildingAreaApiClient } from "@webcraft/api";

import type { BuildingAreaBrowser } from "./building-area.ts";
import { EDIT_TOKEN_HEADER } from "./edit-mode.ts";
import type { TestInstall } from "./index.ts";

/** Where the Site's address serves the Management API to the building area. */
export const BUILDING_AREA_API_PATH = "/_webcraft/build/api/rpc";

/** What a raw call carries, changed to test refusals. Unless given, it carries what the shell's does. */
export type RawCallOptions = {
	/** The header token sent; null sends none. */
	headerToken?: string | null;
	/** The `Origin` sent; null sends none. */
	origin?: string | null;
	/** The `Sec-Fetch-Site` sent; null sends none. */
	fetchSite?: string | null;
	method?: string;
	/** The body as sent; the input as the oRPC protocol sends it (`{ json: input }`) unless given. */
	body?: BodyInit;
	contentType?: string | null;
	/** Cookies left out of the request, by name. */
	withoutCookies?: readonly string[];
};

export type BuildingAreaApi = {
	/** The listed procedures, called the way the shell calls them. */
	api: BuildingAreaApiClient;
	/** One call of any path (dotted, `entries.create`) with its input, as the oRPC protocol sends it. */
	call(path: string, input?: unknown, options?: RawCallOptions): Promise<Response>;
};

/** The Management API on the Site's address for a browser in the building area. */
export function buildingAreaApi(install: TestInstall, area: BuildingAreaBrowser): BuildingAreaApi {
	const base = `${area.origin}${BUILDING_AREA_API_PATH}`;
	const api = createORPCClient(
		new RPCLink({
			url: base,
			fetch: async (outgoing) => {
				const headers = new Headers(outgoing.headers);
				headers.set(EDIT_TOKEN_HEADER, await area.headerToken());
				return area.browser.request(new Request(outgoing, { headers }));
			},
		}),
	) as BuildingAreaApiClient;

	return {
		api,
		async call(path, input = {}, options = {}) {
			const headers = new Headers();
			const contentType = options.contentType === undefined ? "application/json" : options.contentType;
			if (contentType !== null) headers.set("content-type", contentType);
			const token = options.headerToken === undefined ? await area.headerToken() : options.headerToken;
			if (token !== null) headers.set(EDIT_TOKEN_HEADER, token);
			const cookies = Array.from(area.browser.cookies)
				.filter(([name]) => !options.withoutCookies?.includes(name))
				.map(([name, value]) => `${name}=${value}`)
				.join("; ");
			if (cookies) headers.set("cookie", cookies);
			const origin = options.origin === undefined ? area.origin : options.origin;
			if (origin !== null) headers.set("origin", origin);
			const fetchSite = options.fetchSite === undefined ? "same-origin" : options.fetchSite;
			if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
			const method = options.method ?? "POST";
			const body =
				method === "GET" || method === "HEAD" ? undefined : (options.body ?? JSON.stringify({ json: input }));
			return install.request(new Request(`${base}/${path.replaceAll(".", "/")}`, { method, headers, body }));
		},
	};
}

/** A refusal as the Site's address answers it: the oRPC protocol's `{ json: { code, status, message, data } }`. */
export async function refusalOf(
	response: Response,
): Promise<{ status: number; code?: string; data?: Record<string, unknown> }> {
	const text = await response.text();
	let body: { json?: { code?: string; data?: Record<string, unknown> } } = {};
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		// Not JSON: only the status says anything.
	}
	return { status: response.status, code: body.json?.code, data: body.json?.data };
}
