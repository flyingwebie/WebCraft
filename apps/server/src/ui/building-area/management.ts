import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { BuildingAreaApiClient } from "@webcraft/api";

/** Where the Site's address serves the Management API to the building area (`site/building-area/api.ts`). */
const API_PATH = "/_webcraft/build/api/rpc";

/** The header the session's header token goes in, as every edit request carries it. */
const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

/**
 * The Management API as the shell calls it (ADR 0037): the listed procedures on the Site's own
 * address, with the session's header token, the edit cookie going with each call.
 */
export function managementApi(token: string): BuildingAreaApiClient {
	return createORPCClient(
		new RPCLink({
			url: new URL(API_PATH, window.location.origin).toString(),
			headers: { [EDIT_TOKEN_HEADER]: token },
		}),
	) as BuildingAreaApiClient;
}

/** What Go to lists (`builder.commandMenu`): Pages, each Post Type's Entries, and the Site's Components. */
export type GoToData = Awaited<ReturnType<BuildingAreaApiClient["builder"]["commandMenu"]>>;

/** The Site's Post Types as `postTypes.list` answers them. */
export type PostTypeRow = Awaited<ReturnType<BuildingAreaApiClient["postTypes"]["list"]>>["postTypes"][number];
