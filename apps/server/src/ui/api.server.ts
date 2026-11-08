import { createRouterClient } from "@orpc/server";
import { getRequest } from "@tanstack/react-start/server";
import { type ApiClient, apiRouter } from "@webcraft/api";

import { clientAddress } from "../client-address.ts";
import { startWebServices } from "../web-services.ts";

/** The Management API, called in-process with the cookies and client address of the request being rendered. */
export async function serverApi(): Promise<ApiClient> {
	const services = await startWebServices();
	const request = getRequest();
	const headers = new Headers(request.headers);
	return createRouterClient(apiRouter, {
		context: { services, headers, clientAddress: clientAddress(request, services.config), via: { kind: "admin" } },
	});
}
