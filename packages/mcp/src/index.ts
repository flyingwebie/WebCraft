/**
 * The MCP server (ADR 0030): one tool per public Management API procedure, grouped in Toolsets,
 * served over Streamable HTTP at `/mcp` on the admin host, with WebCraft as the OAuth 2.1
 * authorization server of AI clients a person approves.
 */

export { templateMarkupReference } from "./guides.ts";
export { createOAuthEndpoints, protectedResourceMetadataUrl } from "./oauth-endpoints.ts";
export { createMcpEndpoint } from "./server.ts";
export { type GeneratedTool, generateTools, type JsonSchema, toolName } from "./tools.ts";
