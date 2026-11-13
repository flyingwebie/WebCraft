import { EDIT_MODE_PATH } from "@webcraft/core";

/**
 * Where Co-editing's Draft sockets open (ADR 0025), kept apart from `sockets.ts` so the Vite config
 * (which wires development's socket upgrades to the same paths, `vite.config.ts`) can import them
 * without pulling that module's server-only wiring (the handler, the data layer, oRPC) into its graph.
 */

/** Where the admin's editors open a Draft's socket. */
export const ADMIN_DRAFTS_PREFIX = "/api/drafts/";

/** Where Edit mode opens a Draft's socket, on the Site's own domain. */
export const EDIT_DRAFTS_PREFIX = `${EDIT_MODE_PATH}drafts/`;
