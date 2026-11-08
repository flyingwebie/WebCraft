import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiClient } from "@webcraft/api";

/**
 * One person's browser on the admin: it keeps the cookies answers set and sends them back, and
 * sends the admin's origin with every request, as a browser on the admin's own pages does.
 */
export type TestBrowser = {
	/** The Management API, called the way the admin calls it, with this browser's cookies. */
	api: ApiClient;
	/** Sends a request with this browser's cookies and keeps the cookies the answer sets. */
	request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	/** The cookies this browser holds, by name. */
	readonly cookies: ReadonlyMap<string, string>;
};

/** Where the admin calls the Management API. */
export const API_PATH = "/api/rpc";

export function createTestBrowser(options: {
	send: (request: Request) => Promise<Response>;
	adminOrigin: string;
	/** The origin requests come from; another site's origin to test that they are refused. */
	origin?: string;
}): TestBrowser {
	const cookies = new Map<string, string>();
	const origin = options.origin ?? options.adminOrigin;

	const request = async (input: string | URL | Request, init?: RequestInit) => {
		const outgoing = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const headers = new Headers(outgoing.headers);
		if (cookies.size > 0) {
			headers.set("cookie", Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "));
		}
		if (outgoing.method !== "GET" && outgoing.method !== "HEAD") headers.set("origin", origin);
		headers.set("sec-fetch-site", origin === options.adminOrigin ? "same-origin" : "cross-site");
		const response = await options.send(new Request(outgoing, { headers }));
		for (const line of response.headers.getSetCookie()) keepCookie(cookies, line);
		return response;
	};

	const api: ApiClient = createORPCClient(
		new RPCLink({ url: new URL(API_PATH, options.adminOrigin).toString(), fetch: (outgoing) => request(outgoing) }),
	);
	return { api, request, cookies };
}

/** Applies one `Set-Cookie` line: stores the cookie, or forgets it when the line expires it. */
function keepCookie(cookies: Map<string, string>, line: string): void {
	const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
	const separator = pair.indexOf("=");
	if (separator <= 0) return;
	const name = pair.slice(0, separator);
	const value = pair.slice(separator + 1);
	const expired = attributes.some((attribute) => {
		const [key = "", setting = ""] = attribute.split("=");
		if (key.toLowerCase() === "max-age") return Number(setting) <= 0;
		if (key.toLowerCase() === "expires") return new Date(setting).getTime() <= Date.now();
		return false;
	});
	if (expired || value === "") cookies.delete(name);
	else cookies.set(name, value);
}
