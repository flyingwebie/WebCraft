/**
 * The Management API: oRPC procedures with Zod schemas. The admin calls them at `/api/rpc` on the
 * admin host; the public ones will also be served under `/api/v1` with an OpenAPI spec, and the
 * MCP server and the CLI are generated from them (ADR 0030).
 */
export { type ApiContext, procedure, signedIn, superadminOnly, withPerson } from "./context.ts";
export { type ApiClient, type ApiRouter, apiRouter } from "./router.ts";
export { ADMIN_API_PREFIX, createAdminApi } from "./rpc.ts";
