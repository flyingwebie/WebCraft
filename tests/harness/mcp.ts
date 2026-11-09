// An AI client talking to the MCP server at `/mcp`, through the official MCP client: with a bearer
// token it already holds (an API token, or an access token from `approveAiClient`), or through the
// whole OAuth flow (registration, the person's approval in the admin, PKCE, tokens).
//
//     const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId });
//     const client = await connectMcp(install, accessToken);
//     const { tools } = await client.listTools();
//
// Every request goes through the Install's handler in process; the client's fetch never leaves it.
import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthTokens,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { fromAddress, TEST_PASSWORD, type TestBrowser, type TestInstall } from "./index.ts";

/** The address an AI client on the person's own device is sent back to. */
export const LOOPBACK_REDIRECT = "http://127.0.0.1:33418/callback";

export type McpEra = "modern" | "legacy";

export type ConnectOptions = {
	/**
	 * `modern`: the 2026-07-28 revision (no handshake, every request carrying its version and the
	 * client's capabilities). `legacy` (default): the 2025 revisions, with `initialize`.
	 */
	era?: McpEra;
	/**
	 * Answers the server's questions (elicitation): what the person would answer. Without it the
	 * client says it can't ask anything.
	 */
	answer?: (question: { message: string; requestedSchema: unknown }) => Record<string, unknown> | null;
	/** The client address its requests come from. */
	address?: string;
};

let addresses = 0;

function clientFetch(install: TestInstall, address: string) {
	return (url: string | URL, init?: RequestInit) =>
		install.request(fromAddress(new Request(String(url), init), address));
}

/** An MCP client connected to the Install's `/mcp` with `token` as its bearer token. */
export async function connectMcp(install: TestInstall, token: string, options: ConnectOptions = {}): Promise<Client> {
	const address = options.address ?? `10.210.${(++addresses >> 8) & 255}.${addresses & 255}`;
	const transport = new StreamableHTTPClientTransport(new URL(install.adminUrl("/mcp")), {
		fetch: clientFetch(install, address),
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	return connect(transport, options);
}

async function connect(transport: StreamableHTTPClientTransport, options: ConnectOptions): Promise<Client> {
	const answer = options.answer;
	const client = new Client(
		{ name: "Test AI client", version: "1.0.0" },
		{
			capabilities: answer ? { elicitation: { form: {} } } : {},
			versionNegotiation: { mode: options.era === "modern" ? { pin: "2026-07-28" } : "legacy" },
		},
	);
	if (answer) {
		client.setRequestHandler("elicitation/create", async (request) => {
			const params = request.params as { message: string; requestedSchema: unknown };
			const content = answer(params);
			return content === null ? { action: "decline" } : { action: "accept", content: content as never };
		});
	}
	await client.connect(transport);
	return client;
}

/** What the person chooses on the approval page; everything but Submissions unless given. */
export type Approval = {
	workspaceId: string;
	sites?: "all" | string[];
	readOnly?: boolean;
	mayPublish?: boolean;
	toolsets?: string[];
};

/** What a registered AI client holds after the person approved it. */
export type ApprovedClient = {
	clientId: string;
	accessToken: string;
	refreshToken: string;
	redirectUri: string;
};

/** Registers an AI client as a client does (RFC 7591): answers the registration. */
export async function registerClient(
	install: TestInstall,
	metadata: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await install.request(
		fromAddress(
			new Request(install.adminUrl("/oauth/register"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					client_name: "Test AI client",
					redirect_uris: [LOOPBACK_REDIRECT],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					application_type: "native",
					...metadata,
				}),
			}),
			`10.211.0.${(++addresses % 250) + 1}`,
		),
	);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A PKCE verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/** The authorization request parameters a client sends the person's browser to `/oauth/authorize` with. */
export function authorizationParameters(
	install: TestInstall,
	clientId: string,
	challenge: string,
	more: Record<string, string> = {},
): Record<string, string> {
	return {
		response_type: "code",
		client_id: clientId,
		redirect_uri: LOOPBACK_REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "state-123",
		resource: install.adminUrl("/mcp"),
		...more,
	};
}

/** Calls the token endpoint with a form body, as a client does. */
export async function tokenRequest(
	install: TestInstall,
	form: Record<string, string>,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await install.request(
		new Request(install.adminUrl("/oauth/token"), {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
			body: new URLSearchParams(form).toString(),
		}),
	);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/**
 * The person approves an authorization request in the admin, as the approval page does (a Sensitive
 * action: they confirm their password, `TEST_PASSWORD`, when asked), and answers where they are sent
 * back to.
 */
export async function approveInAdmin(
	browser: TestBrowser,
	parameters: Record<string, string>,
	approval: Approval,
): Promise<URL> {
	const approve = () =>
		browser.api.oauth.approve({
			parameters,
			workspaceId: approval.workspaceId,
			sites: approval.sites ?? "all",
			readOnly: approval.readOnly ?? false,
			mayPublish: approval.mayPublish ?? false,
			...(approval.toolsets ? { toolsets: approval.toolsets } : {}),
		});
	const approved = await approve().catch(async (error: { code?: string }) => {
		if (error.code !== "IDENTITY_CHECK_REQUIRED") throw error;
		await browser.api.session.confirmIdentity({ password: TEST_PASSWORD });
		return approve();
	});
	return new URL(approved.redirectTo);
}

/**
 * The whole flow by hand: registration, the person's approval, the code for tokens. Answers the
 * client's id and its tokens.
 */
export async function approveAiClient(
	install: TestInstall,
	browser: TestBrowser,
	approval: Approval,
	metadata: Record<string, unknown> = {},
): Promise<ApprovedClient> {
	const registered = await registerClient(install, metadata);
	if (registered.status !== 201) throw new Error(`Registration failed: ${JSON.stringify(registered.body)}`);
	const clientId = String(registered.body.client_id);
	const { verifier, challenge } = await pkcePair();
	const parameters = authorizationParameters(install, clientId, challenge);
	const back = await approveInAdmin(browser, parameters, approval);
	const code = back.searchParams.get("code");
	if (!code) throw new Error(`No code came back: ${back}`);
	const tokens = await tokenRequest(install, {
		grant_type: "authorization_code",
		code,
		redirect_uri: LOOPBACK_REDIRECT,
		client_id: clientId,
		code_verifier: verifier,
		resource: install.adminUrl("/mcp"),
	});
	if (tokens.status !== 200) throw new Error(`The token exchange failed: ${JSON.stringify(tokens.body)}`);
	return {
		clientId,
		accessToken: String(tokens.body.access_token),
		refreshToken: String(tokens.body.refresh_token),
		redirectUri: LOOPBACK_REDIRECT,
	};
}

/**
 * An MCP client that finds its way in by itself, as a real one does: it is refused, discovers the
 * authorization server, registers, sends the person to approve it (here: the person approves in
 * the admin at once), exchanges the code with PKCE and connects.
 */
export async function connectMcpWithOAuth(
	install: TestInstall,
	browser: TestBrowser,
	approval: Approval,
	options: ConnectOptions = {},
): Promise<{ client: Client; provider: TestOAuthProvider }> {
	const address = options.address ?? `10.212.${(++addresses >> 8) & 255}.${addresses & 255}`;
	const provider = new TestOAuthProvider(async (url) => {
		const parameters = Object.fromEntries(url.searchParams);
		const back = await approveInAdmin(browser, parameters, approval);
		provider.callback = back.searchParams;
		provider.code = back.searchParams.get("code") ?? undefined;
		provider.issuer = back.searchParams.get("iss") ?? undefined;
	});
	const transportFor = () =>
		new StreamableHTTPClientTransport(new URL(install.adminUrl("/mcp")), {
			fetch: clientFetch(install, address),
			authProvider: provider,
		});
	const first = transportFor();
	try {
		await connect(first, options);
		throw new Error("The client connected without approval.");
	} catch (error) {
		if (!provider.code) throw error;
	}
	await first.finishAuth(provider.callback ?? new URLSearchParams());
	return { client: await connect(transportFor(), options), provider };
}

/** An OAuth client provider keeping everything in memory, as a client on the person's device would. */
export class TestOAuthProvider implements OAuthClientProvider {
	code: string | undefined;
	issuer: string | undefined;
	/** The parameters the person was sent back to the client with. */
	callback: URLSearchParams | undefined;
	private discovery: OAuthDiscoveryState | undefined;
	private information: OAuthClientInformationMixed | undefined;
	private saved: OAuthTokens | undefined;
	private verifier = "";
	private readonly approve: (url: URL) => Promise<void>;
	constructor(approve: (url: URL) => Promise<void>) {
		this.approve = approve;
	}
	get redirectUrl() {
		return LOOPBACK_REDIRECT;
	}
	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Test AI client",
			redirect_uris: [LOOPBACK_REDIRECT],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			application_type: "native",
		} as OAuthClientMetadata;
	}
	clientInformation() {
		return this.information;
	}
	saveClientInformation(information: OAuthClientInformationMixed) {
		this.information = information;
	}
	tokens() {
		return this.saved;
	}
	saveTokens(tokens: OAuthTokens) {
		this.saved = tokens;
	}
	async redirectToAuthorization(url: URL) {
		await this.approve(url);
	}
	saveDiscoveryState(state: OAuthDiscoveryState) {
		this.discovery = state;
	}
	discoveryState() {
		return this.discovery;
	}
	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
}

/** The structured answer of a tool call that worked; throws with its text when it didn't. */
export function answerOf<T = Record<string, unknown>>(result: unknown): T {
	const { isError, content, structuredContent } = result as {
		isError?: boolean;
		content?: { type: string; text?: string }[];
		structuredContent?: unknown;
	};
	if (isError) throw new Error(`The tool refused: ${content?.map((part) => part.text).join("\n")}`);
	if (structuredContent !== undefined) return structuredContent as T;
	return JSON.parse(content?.find((part) => part.type === "text")?.text ?? "null") as T;
}

/** The refusal of a tool call that didn't work: `{ code, message, data }`; throws when it worked. */
export function refusalOf(result: unknown): { code: string; message: string; data?: unknown } {
	const { isError, content } = result as { isError?: boolean; content?: { type: string; text?: string }[] };
	if (!isError) throw new Error(`The tool worked: ${JSON.stringify(result)}`);
	return JSON.parse(content?.find((part) => part.type === "text")?.text ?? "{}");
}
