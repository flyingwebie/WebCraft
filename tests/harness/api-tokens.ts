// A script calling the public Management API (`/api/v1`) with an API token, as agencies' own
// scripts, the MCP server and the CLI do:
//
//     const { secret } = await createApiToken(browser, { workspaceId, name: "Deploy" });
//     const script = tokenClient(install, secret);
//     await script.api.sites.list({ workspaceId });
//
// `api` is typed like the admin's client; the calls go to `POST /api/v1/<path>` as plain JSON
// (multipart form data when the input holds a file), so dates come back as ISO strings.
import { type ClientLink, createORPCClient, ORPCError } from "@orpc/client";
import type { ApiClient } from "@webcraft/api";

import { fromAddress, TEST_PASSWORD, type TestBrowser, type TestInstall } from "./index.ts";

/** A script holding an API token. */
export type TokenClient = {
	/** The public procedures, called with the token. */
	api: ApiClient;
	/** Sends a request to `/api/v1/<path>` with the token (unless `init` sets `authorization`). */
	request(path: string, init?: RequestInit): Promise<Response>;
};

let addresses = 0;

/** A script's client, from its own client address, sending `secret` as its bearer token (none for null). */
export function tokenClient(install: TestInstall, secret: string | null): TokenClient {
	const address = `10.200.${(++addresses >> 8) & 255}.${addresses & 255}`;
	const request = (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		if (secret !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${secret}`);
		const url = install.adminUrl(`/api/v1/${path.replace(/^\/+/, "")}`);
		return install.request(fromAddress(new Request(url, { method: "POST", ...init, headers }), address));
	};
	const link: ClientLink<Record<never, never>> = {
		async call(path, input) {
			const response = await request(path.join("/"), bodyOf(input));
			const text = await response.text();
			const answer = text === "" ? undefined : JSON.parse(text);
			if (!response.ok) {
				const { code, status, message, data } = (answer ?? {}) as {
					code?: string;
					status?: number;
					message?: string;
					data?: unknown;
				};
				throw new ORPCError(code ?? "UNKNOWN", { status: status ?? response.status, message, data });
			}
			return answer;
		},
	};
	return { api: createORPCClient(link) as ApiClient, request };
}

/** A procedure's input as a request body: JSON, or multipart form data when it holds a file. */
function bodyOf(input: unknown): RequestInit {
	if (input === undefined) return {};
	const values = typeof input === "object" && input !== null ? Object.entries(input) : [];
	if (!values.some(([, value]) => value instanceof Blob)) {
		return { body: JSON.stringify(input), headers: { "content-type": "application/json" } };
	}
	const form = new FormData();
	for (const [key, value] of values) {
		if (value === undefined || value === null) continue;
		form.append(key, value instanceof Blob ? value : String(value));
	}
	return { body: form };
}

/**
 * Makes an API token as `browser`'s person does in the admin (a Sensitive action: they confirm
 * their password, `TEST_PASSWORD`, when asked), and answers it with the token itself.
 */
export async function createApiToken(
	browser: TestBrowser,
	input: Parameters<ApiClient["apiTokens"]["create"]>[0],
): Promise<{ secret: string; tokenId: string }> {
	const create = () => browser.api.apiTokens.create(input);
	const created = await create().catch(async (error: { code?: string }) => {
		if (error.code !== "IDENTITY_CHECK_REQUIRED") throw error;
		await browser.api.session.confirmIdentity({ password: TEST_PASSWORD });
		return create();
	});
	return { secret: created.secret, tokenId: created.token.id };
}
