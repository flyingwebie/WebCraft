import { os } from "@orpc/server";

/**
 * The Management API: oRPC procedures with Zod schemas. The admin host serves the public ones under
 * `/api/v1` (with an OpenAPI spec); the MCP server and the CLI are generated from them (ADR 0030).
 * Every procedure checks `can()` before it reads or changes anything.
 */

/** What every procedure receives. It grows with the actor (person, token, grant) and services. */
export type ApiContext = Record<string, never>;

/** The builder every procedure starts from. */
export const procedure = os.$context<ApiContext>();

/** Every procedure, by name. Empty until the first procedures arrive. */
export const apiRouter = {};
