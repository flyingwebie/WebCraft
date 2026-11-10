/**
 * The Management API: oRPC procedures with Zod schemas. The admin calls them at `/api/rpc` on the
 * admin host; the public ones are also served to API tokens under `/api/v1` with an OpenAPI
 * document, and the MCP server and the CLI are generated from them (ADR 0030).
 */
export { type Exposure, exposureOf, PROCEDURES, type ProcedurePath } from "./catalogue.ts";
export {
	type ApiContext,
	authEndpoint,
	inAdminSession,
	onInstall,
	procedure,
	rateLimited,
	sensitive,
	signedIn,
	withPerson,
} from "./context.ts";
export { toApiError } from "./errors.ts";
export { adminRouter } from "./module-router.ts";
export {
	bearerToken,
	type ClientRefusal,
	clientRefusal,
	createProcedureCaller,
	createPublicApi,
	OPENAPI_DOCUMENT_PATH,
	openApiDocument,
	type ProcedureCall,
	PUBLIC_API_PREFIX,
	type PublicProcedure,
	publicProcedure,
	rateLimitHeaders,
	tokenRefusal,
	tooManyRequests,
} from "./public.ts";
export { type ApiClient, type ApiRouter, apiRouter } from "./router.ts";
export {
	ADMIN_API_PREFIX,
	createAdminApi,
	limitBody,
	MULTIPART_ALLOWANCE,
	type RequestFacts,
} from "./rpc.ts";
export { type PublicProcedurePath, TOOL_PLACES, type ToolPlace, toolPlaceOf } from "./toolsets.ts";
