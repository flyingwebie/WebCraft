import type { InstallServices } from "@webcraft/core";

import { type Handler, notFound } from "../responses.ts";

/**
 * The Site request pipeline: every hostname other than the admin host comes here. It will resolve
 * the hostname to a Site (Primary, Redirect, language domain or Staging address) and render the
 * page. No Sites exist yet, so every hostname is unknown and gets the unbranded 404.
 */
export function createSitePipeline(_services: InstallServices): Handler {
	return async () => notFound();
}
