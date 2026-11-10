import { DEVICE_CODE_GRANT, type InstallServices, MCP_PATH, OAuthRequestError } from "@webcraft/core";

import { corsHeaders, preflight } from "./cors.ts";

/**
 * WebCraft as the OAuth 2.1 authorization server of its own MCP server, on the admin host:
 *
 * - `GET /.well-known/oauth-protected-resource/mcp` (and at the root): the MCP server's metadata
 *   (RFC 9728), naming the admin as its authorization server;
 * - `GET /.well-known/oauth-authorization-server`: the authorization server's metadata (RFC 8414);
 * - `POST /oauth/register`: Dynamic Client Registration (RFC 7591);
 * - `GET /oauth/authorize`: the admin's approval page (`routes/oauth.authorize.tsx`), where a
 *   signed-in person approves the client;
 * - `POST /oauth/device_authorization`: a device code and a user code (RFC 8628) for a client on a
 *   device without a browser (`webcraft login`), approved at `/oauth/device`;
 * - `POST /oauth/token`: codes (with PKCE), device codes and refresh tokens for tokens;
 * - `POST /oauth/revoke`: a client ends its grant (RFC 7009).
 *
 * Answers null for every other path.
 */
export function createOAuthEndpoints(
	services: InstallServices,
): (request: Request, facts: { clientAddress: string | null }) => Promise<Response | null> {
	return async (request, { clientAddress }) => {
		const { pathname } = new URL(request.url);
		const endpoint = ENDPOINTS[pathname];
		if (!endpoint) return null;
		if (request.method === "OPTIONS") return preflight(request, `${endpoint.method}, OPTIONS`);
		if (request.method !== endpoint.method && !(endpoint.method === "GET" && request.method === "HEAD")) {
			return answer(
				request,
				405,
				{ error: "invalid_request", error_description: `Use ${endpoint.method}.` },
				{
					allow: endpoint.method,
				},
			);
		}
		try {
			return await endpoint.handle(services, request, clientAddress);
		} catch (error) {
			if (!(error instanceof OAuthRequestError)) throw error;
			const headers: Record<string, string> =
				error.error === "invalid_client" && request.headers.get("authorization")?.toLowerCase().startsWith("basic")
					? { "www-authenticate": 'Basic realm="WebCraft"' }
					: {};
			return answer(request, error.status, { error: error.error, error_description: error.message }, headers);
		}
	};
}

/** Where the MCP server's own metadata is (RFC 9728): named in every 401 from `/mcp`. */
export function protectedResourceMetadataUrl(services: InstallServices): string {
	return `${services.config.adminOrigin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
}

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** The largest body the OAuth endpoints read. */
const MAX_BODY_BYTES = 64 * 1024;

type Endpoint = {
	method: "GET" | "POST";
	handle(services: InstallServices, request: Request, clientAddress: string | null): Promise<Response>;
};

const protectedResource: Endpoint = {
	method: "GET",
	async handle(services, request) {
		return answer(
			request,
			200,
			{
				resource: services.oauth.resource,
				authorization_servers: [services.oauth.issuer],
				bearer_methods_supported: ["header"],
				resource_name: "WebCraft",
			},
			{ "cache-control": "max-age=300" },
		);
	},
};

const ENDPOINTS: Record<string, Endpoint> = {
	[PROTECTED_RESOURCE_PATH]: protectedResource,
	[`${PROTECTED_RESOURCE_PATH}${MCP_PATH}`]: protectedResource,
	"/.well-known/oauth-authorization-server": {
		method: "GET",
		async handle(services, request) {
			const issuer = services.oauth.issuer;
			const authMethods = ["none", "client_secret_basic", "client_secret_post"];
			return answer(
				request,
				200,
				{
					issuer,
					authorization_endpoint: `${issuer}/oauth/authorize`,
					token_endpoint: `${issuer}/oauth/token`,
					registration_endpoint: `${issuer}/oauth/register`,
					revocation_endpoint: `${issuer}/oauth/revoke`,
					device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
					response_types_supported: ["code"],
					response_modes_supported: ["query"],
					grant_types_supported: ["authorization_code", DEVICE_CODE_GRANT, "refresh_token"],
					token_endpoint_auth_methods_supported: authMethods,
					revocation_endpoint_auth_methods_supported: authMethods,
					code_challenge_methods_supported: ["S256"],
					authorization_response_iss_parameter_supported: true,
				},
				{ "cache-control": "max-age=300" },
			);
		},
	},
	"/oauth/register": {
		method: "POST",
		async handle(services, request, clientAddress) {
			const text = await bodyText(request);
			let metadata: unknown;
			try {
				metadata = JSON.parse(text);
			} catch {
				throw new OAuthRequestError("invalid_client_metadata", "Send the client's metadata as JSON.");
			}
			return answer(request, 201, await services.oauth.register(metadata, clientAddress));
		},
	},
	"/oauth/device_authorization": {
		method: "POST",
		async handle(services, request, clientAddress) {
			const form = new URLSearchParams(await bodyText(request));
			const answered = await services.oauth.deviceAuthorization(
				form,
				request.headers.get("authorization"),
				clientAddress,
			);
			return answer(request, 200, answered);
		},
	},
	"/oauth/token": {
		method: "POST",
		async handle(services, request) {
			const form = new URLSearchParams(await bodyText(request));
			const tokens = await services.oauth.token(form, request.headers.get("authorization"));
			return answer(request, 200, tokens, { pragma: "no-cache" });
		},
	},
	"/oauth/revoke": {
		method: "POST",
		async handle(services, request) {
			const form = new URLSearchParams(await bodyText(request));
			await services.oauth.revokeToken(form, request.headers.get("authorization"));
			return new Response(null, { status: 200, headers: { ...corsHeaders(request), "cache-control": "no-store" } });
		},
	},
};

/** A JSON answer that is never cached unless `headers` says otherwise, readable from any origin. */
function answer(request: Request, status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store", ...corsHeaders(request), ...headers } });
}

/** The request's body as text, refused past `MAX_BODY_BYTES`. */
async function bodyText(request: Request): Promise<string> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new OAuthRequestError("invalid_request", "The request is too large.", 413);
	}
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
		throw new OAuthRequestError("invalid_request", "The request is too large.", 413);
	}
	return text;
}
