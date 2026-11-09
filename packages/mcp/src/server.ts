import {
	type AuthInfo,
	acceptedContent,
	type CallToolResult,
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	createRequestStateCodec,
	inputRequired,
	McpServer,
	ProtocolError,
	ProtocolErrorCode,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { bearerToken, createProcedureCaller, PUBLIC_API_PREFIX, tokenRefusal, tooManyRequests } from "@webcraft/api";
import {
	API_TOKEN_LIMITS,
	type ApiClientUse,
	ApiTokenInvalidError,
	type InstallServices,
	MCP_PATH,
	OAUTH_PREFIXES,
	WEBCRAFT_VERSION,
} from "@webcraft/core";

import { corsHeaders, preflight } from "./cors.ts";
import { GUIDE_TOOL, guideResources, guideTemplates, readGuide, runGuide } from "./guides.ts";
import { protectedResourceMetadataUrl } from "./oauth-endpoints.ts";
import { listedTools } from "./session.ts";
import type { GeneratedTool } from "./tools.ts";

/** What the MCP server tells AI clients about itself and how to work with it. */
const INSTRUCTIONS = [
	"WebCraft, a CMS for agencies' client Sites. You act as the person who approved you, within the Workspace, Sites and Toolsets they chose, and never beyond what they may do.",
	"Start with `sites_list` (it takes the Workspace's id from `workspaces_list`). Every Site tool takes `siteId`; nothing is remembered between calls.",
	"Read `guide_get` with topic `site-schema` for a Site's Post Types, Fields, Components and Loops before writing, and with `template-markup` before writing Templates or Components.",
	"Saving changes Drafts; visitors see a Draft only once it is published. Publishing and deleting take two steps: show the person the preview, then call again with the confirmation id once they agree.",
].join("\n\n");

/** The state a question to the person carries between two calls: which tool, and the confirmation it confirms. */
type ConfirmationState = { tool: string; confirmation: string };

/**
 * The MCP server (ADR 0030), Streamable HTTP at `/mcp` on the admin host: every request carries an
 * access token of an AI client a person approved (OAuth 2.1, see `oauth-endpoints.ts`) or an API
 * token, and acts as its person within its limits. A session lists only the tools its Toolsets
 * and its person's Permissions allow (`listedTools`); a tool calls its procedure through the same
 * checks as `/api/v1`, recorded in the Audit log as "<person> via <client>".
 *
 * Stateless: the 2026-07-28 revision needs no session, and a client of the 2025 revisions is served
 * one request at a time. Tools that publish or delete take two steps: the first call answers a
 * preview and a confirmation id; a client of the 2026-07-28 revision that can ask its person a
 * question is asked instead, and the confirmation rides along, signed, until it answers.
 *
 * Answers null for paths other than `/mcp`.
 */
export function createMcpEndpoint(
	services: InstallServices,
): (request: Request, facts: { clientAddress: string | null }) => Promise<Response | null> {
	const call = createProcedureCaller(services);
	const codec = createRequestStateCodec<ConfirmationState>({
		key: services.mcpRequestStateKey,
		ttlSeconds: 5 * 60,
		bind: (ctx) => ctx.http?.authInfo?.clientId ?? "",
	});
	const handler = createMcpHandler(
		async ({ authInfo }) => {
			const { use, clientAddress } = (authInfo?.extra ?? {}) as { use: ApiClientUse; clientAddress: string | null };
			return serverFor(use, clientAddress);
		},
		{
			onerror: (error) => {
				services.log.warn("The MCP server refused or failed a request", { error });
			},
		},
	);

	const serverFor = async (use: ApiClientUse, clientAddress: string | null) => {
		const server = new McpServer(
			{ name: "webcraft", title: "WebCraft", version: WEBCRAFT_VERSION },
			{
				capabilities: { tools: {}, resources: {} },
				instructions: INSTRUCTIONS,
				requestState: { verify: (state, ctx) => codec.verify(state, ctx) },
			},
		);
		let tools: Promise<GeneratedTool[]> | undefined;
		const listed = () => {
			tools ??= listedTools(services, use);
			return tools;
		};
		const callProcedure = async (path: readonly string[], input: Record<string, unknown>, files: readonly string[]) =>
			answerOf(
				await call({ request: procedureRequest(services, path, input, files), path, client: use, clientAddress }),
			);

		server.server.setRequestHandler("tools/list", async () => ({
			tools: [GUIDE_TOOL, ...(await listed()).map(definitionOf)],
		}));

		server.server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
			const { name } = request.params;
			const args = (request.params.arguments ?? {}) as Record<string, unknown>;
			if (name === GUIDE_TOOL.name) return runGuide(services, use, args, callProcedure);
			const tool = (await listed()).find((each) => each.name === name);
			if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `There is no tool ${name} for this client.`);
			if (tool.access === "write") {
				const writes = await services.rateLimits.tally(`${limitKey(use)}:writes`, API_TOKEN_LIMITS.writes);
				if (!writes.within) {
					return refused({
						code: "TOO_MANY_REQUESTS",
						message: `This client made ${writes.limit} writes this minute: wait, then try again.`,
					});
				}
			}

			// The person's answer to a question this tool asked them (2026-07-28 clients).
			const state = ctx.mcpReq.requestState<ConfirmationState>();
			if (state !== undefined) {
				if (state.tool !== name || !tool.confirmation) {
					throw new ProtocolError(ProtocolErrorCode.InvalidParams, "This answer is for another tool.");
				}
				const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm");
				if (answer?.confirm !== true) {
					return {
						content: [{ type: "text", text: "Nothing was changed: the person didn't confirm." }],
						structuredContent: { confirmed: false },
					};
				}
				return resultOf(await callProcedure(tool.path, { ...args, confirmation: state.confirmation }, tool.files));
			}

			const outcome = await callProcedure(tool.path, args, tool.files);
			const asked = tool.confirmation && args.confirmation === undefined ? confirmationOf(outcome) : null;
			if (asked && canAsk(ctx)) {
				return inputRequired({
					inputRequests: {
						confirm: inputRequired.elicit({
							message: questionFor(tool, asked.preview),
							requestedSchema: {
								type: "object",
								properties: {
									confirm: {
										type: "boolean",
										title: "Go ahead",
										description: "Tick to go ahead with this change.",
									},
								},
								required: ["confirm"],
							},
						}),
					},
					requestState: await codec.mint({ tool: name, confirmation: asked.id }, ctx),
				}) as unknown as CallToolResult;
			}
			return resultOf(outcome);
		});

		server.server.setRequestHandler("resources/list", async () => ({
			resources: await guideResources(services, use),
		}));
		server.server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: guideTemplates() }));
		server.server.setRequestHandler("resources/read", async (request) =>
			readGuide(services, use, request.params.uri, callProcedure),
		);
		return server;
	};

	return async (request, { clientAddress }) => {
		const { pathname } = new URL(request.url);
		if (pathname !== MCP_PATH && pathname !== `${MCP_PATH}/`) return null;
		if (request.method === "OPTIONS") return preflight(request, "GET, POST, DELETE, OPTIONS");
		const challenge = `Bearer realm="WebCraft", resource_metadata="${protectedResourceMetadataUrl(services)}"`;
		let use: ApiClientUse;
		const secret = bearerToken(request.headers);
		try {
			use = secret?.startsWith(OAUTH_PREFIXES.access)
				? await services.oauth.use(secret)
				: await services.apiTokens.use(secret);
		} catch (error) {
			if (!(error instanceof ApiTokenInvalidError)) throw error;
			return withCors(request, tokenRefusal(error, challenge));
		}
		const count =
			use.client.kind === "grant"
				? await services.oauth.count(use.client.id, "read")
				: await services.apiTokens.count(use.client.id, "read");
		if (!count.requests.within) return withCors(request, tooManyRequests(services, count.requests, null));
		const authInfo: AuthInfo = {
			token: secret ?? "",
			clientId: `${use.client.kind}:${use.client.id}`,
			scopes: [],
			resource: new URL(services.oauth.resource),
			extra: { use, clientAddress },
		};
		const response = await handler.fetch(request, { authInfo });
		return withCors(request, response);
	};
}

/** The rate limit counters of a client: shared with `/api/v1` for an API token. */
function limitKey(use: ApiClientUse): string {
	return use.client.kind === "grant" ? `oauth-grant:${use.client.id}` : `api-token:${use.client.id}`;
}

/** A tool as `tools/list` describes it. */
function definitionOf(tool: GeneratedTool) {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
		annotations:
			tool.access === "read"
				? { title: tool.title, readOnlyHint: true, openWorldHint: false }
				: { title: tool.title, readOnlyHint: false, destructiveHint: tool.confirmation, openWorldHint: false },
		_meta: { "webcraft/operation": tool.operationId, "webcraft/toolsets": tool.toolsets },
	};
}

/** A procedure's call, as `/api/v1` takes it: JSON, or multipart form data when it carries files. */
function procedureRequest(
	services: InstallServices,
	path: readonly string[],
	input: Record<string, unknown>,
	files: readonly string[],
): Request {
	const url = `${services.config.adminOrigin}${PUBLIC_API_PREFIX}/${path.join("/")}`;
	if (!files.some((name) => input[name] !== undefined)) {
		return new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	}
	const form = new FormData();
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		if (files.includes(key)) {
			const file = value as { name?: unknown; type?: unknown; base64?: unknown };
			const bytes = Buffer.from(typeof file.base64 === "string" ? file.base64 : "", "base64");
			form.append(
				key,
				new File([bytes], typeof file.name === "string" ? file.name : "file", {
					type: typeof file.type === "string" ? file.type : "application/octet-stream",
				}),
			);
		} else {
			form.append(key, typeof value === "string" ? value : JSON.stringify(value));
		}
	}
	return new Request(url, { method: "POST", body: form });
}

/** A procedure's outcome: what it answered, or its refusal. */
export type ProcedureOutcome =
	| { ok: true; answer: unknown }
	| { ok: false; refusal: { code: string; message: string; data?: unknown } };

async function answerOf(response: Response): Promise<ProcedureOutcome> {
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text === "" ? null : JSON.parse(text);
	} catch {
		body = text;
	}
	if (response.ok) return { ok: true, answer: body };
	const { code, message, data } = (body ?? {}) as { code?: string; message?: string; data?: unknown };
	return {
		ok: false,
		refusal: {
			code: code ?? `HTTP_${response.status}`,
			message: message ?? response.statusText,
			...(data === undefined ? {} : { data }),
		},
	};
}

/** A procedure's outcome as a tool's result: its answer as JSON, or its refusal as an error. */
export function resultOf(outcome: ProcedureOutcome): CallToolResult {
	if (!outcome.ok) return refused(outcome.refusal);
	const { answer } = outcome;
	return {
		content: [{ type: "text", text: JSON.stringify(answer ?? null, null, 2) }],
		...(isPlainObject(answer) ? { structuredContent: answer } : {}),
	};
}

function refused(refusal: { code: string; message: string; data?: unknown }): CallToolResult {
	return { isError: true, content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }] };
}

/** The confirmation a first call of a two-step tool answered, with its preview; null when it answered something else. */
function confirmationOf(outcome: ProcedureOutcome): { id: string; preview: unknown } | null {
	if (!outcome.ok || !isPlainObject(outcome.answer)) return null;
	const { confirmation, preview } = outcome.answer as { confirmation?: { id?: unknown }; preview?: unknown };
	return typeof confirmation?.id === "string" ? { id: confirmation.id, preview } : null;
}

/** Whether the client can ask its person a question in this request (a 2026-07-28 client that says it can). */
function canAsk(ctx: ServerContext): boolean {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
	const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { form?: unknown } } | undefined;
	return capabilities?.elicitation !== undefined;
}

/** What the person is asked before a two-step change goes ahead: what it does, and the preview. */
function questionFor(tool: GeneratedTool, preview: unknown): string {
	return `${tool.title}?\n\nWhat it would do:\n${JSON.stringify(preview, null, 2)}`;
}

function withCors(request: Request, response: Response): Response {
	for (const [name, value] of Object.entries(corsHeaders(request))) response.headers.set(name, value);
	return response;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
