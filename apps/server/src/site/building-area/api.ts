import { BUILDING_AREA_API_PREFIX, createBuildingAreaApi } from "@webcraft/api";
import type { InstallServices, SiteHost } from "@webcraft/core";

import { clientAddress } from "../../client-address.ts";
import { buildingAreaCookieOf } from "../cookies.ts";
import { clearEditCookie, EDIT_TOKEN_HEADER, editSessionOf, fromSitePages } from "../edit-mode.ts";

const apis = new WeakMap<InstallServices, ReturnType<typeof createBuildingAreaApi>>();

/**
 * The Management API on the Site's own address for the building area (ADR 0037), at
 * `/_webcraft/build/api/rpc/<path>`: each call is checked first as an edit request is, in the same
 * order and with the same codes (a `POST`, from the Site's own pages, an edit cookie whose session
 * still holds, the session's header token), and must also carry the building-area cookie, so a
 * browser only in Edit mode reaches none of it. Then `createBuildingAreaApi` serves the listed
 * procedures, pinned to this Site. Answers null for paths outside it.
 */
export async function buildingAreaApiEndpoint(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (pathname !== BUILDING_AREA_API_PREFIX && !pathname.startsWith(`${BUILDING_AREA_API_PREFIX}/`)) return null;
	if (request.method !== "POST") {
		return refused(405, "METHOD_NOT_SUPPORTED", "Call procedures with POST.", { allow: "POST" });
	}
	if (!fromSitePages(request)) {
		return refused(403, "EDIT_REQUEST_REFUSED", "Edit requests must come from the Site's own pages.");
	}
	const edit = await editSessionOf(services, request, host);
	if (!edit.session) {
		const ended = refused(401, "EDIT_MODE_ENDED", "Edit mode has ended. Open it again from the admin.");
		if (edit.stale) ended.headers.append("set-cookie", clearEditCookie(request));
		return ended;
	}
	if (!(await services.editMode.checkHeaderToken(edit.session, request.headers.get(EDIT_TOKEN_HEADER) ?? ""))) {
		return refused(403, "EDIT_REQUEST_REFUSED", "The request has no valid Edit mode token.");
	}
	if (buildingAreaCookieOf(request) === null) {
		return refused(403, "EDIT_REQUEST_REFUSED", "Open the building area from the admin first.");
	}
	let api = apis.get(services);
	if (!api) {
		api = createBuildingAreaApi(services);
		apis.set(services, api);
	}
	return api({ request, session: edit.session, clientAddress: clientAddress(request, services.config) });
}

/** A request refused before any procedure ran, as the procedures' refusals look in the oRPC protocol. */
function refused(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
	return Response.json(
		{ json: { defined: false, code, status, message } },
		{ status, headers: { "cache-control": "no-store", ...headers } },
	);
}
