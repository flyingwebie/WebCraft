import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiClient } from "@webcraft/api";

/**
 * One person's browser on the admin: it keeps the cookies answers set and sends them back, and
 * sends the admin's origin with every request, as a browser on the admin's own pages does. Give it
 * another `origin` for a browser on another site's pages (a Site in Edit mode, or an attacker's).
 */
export type TestBrowser = {
	/** The Management API, called the way the admin calls it, with this browser's cookies. */
	api: ApiClient;
	/**
	 * The address the web process sees this browser's requests come from (null: it can't tell).
	 * Change it to move the browser to another network.
	 */
	address: string | null;
	/** Sends a request with this browser's cookies and keeps the cookies the answer sets. */
	request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	/** The cookies this browser holds, by name. */
	readonly cookies: ReadonlyMap<string, string>;
};

/** Where the admin calls the Management API. */
export const API_PATH = "/api/rpc";

export type TestBrowserOptions = {
	/** The origin requests come from; another site's origin to test that they are refused. */
	origin?: string;
	/** The client address of the browser's connection; a new one for each browser unless given. */
	address?: string | null;
	/** The `User-Agent` the browser sends, if any. */
	userAgent?: string;
	/**
	 * Headers every request carries, such as those a proxy in front of the Install adds
	 * (`X-Forwarded-For`, `X-Real-IP`) or a client sends to pass itself off as someone else.
	 */
	headers?: Record<string, string>;
};

let addresses = 0;

/** A client address no other test browser in this process has: `10.0.0.1`, `10.0.0.2`, … */
function nextAddress(): string {
	const n = ++addresses;
	return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/**
 * Gives a request the client address its connection came from, as the web process's server does
 * (`request.ip`, read by `clientAddress` in `apps/server/src/client-address.ts`).
 */
export function fromAddress(request: Request, address: string | null): Request {
	if (address !== null) Object.defineProperty(request, "ip", { value: address, enumerable: true });
	return request;
}

export function createTestBrowser(
	options: TestBrowserOptions & {
		send: (request: Request) => Promise<Response>;
		adminOrigin: string;
	},
): TestBrowser {
	const cookies = new Map<string, string>();
	const origin = options.origin ?? options.adminOrigin;

	const request = async (input: string | URL | Request, init?: RequestInit) => {
		const outgoing = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const headers = new Headers(outgoing.headers);
		for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
		if (cookies.size > 0) {
			headers.set("cookie", Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "));
		}
		if (outgoing.method !== "GET" && outgoing.method !== "HEAD") headers.set("origin", origin);
		// Browsers say whether a request goes to the origin of the page that makes it.
		headers.set("sec-fetch-site", new URL(outgoing.url).origin === origin ? "same-origin" : "cross-site");
		if (options.userAgent !== undefined) headers.set("user-agent", options.userAgent);
		const response = await options.send(fromAddress(new Request(outgoing, { headers }), browser.address));
		for (const line of response.headers.getSetCookie()) keepCookie(cookies, line);
		return response;
	};

	const api: ApiClient = createORPCClient(
		new RPCLink({ url: new URL(API_PATH, options.adminOrigin).toString(), fetch: (outgoing) => request(outgoing) }),
	);
	const browser: TestBrowser = {
		api,
		request,
		cookies,
		address: options.address === undefined ? nextAddress() : options.address,
	};
	return browser;
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
