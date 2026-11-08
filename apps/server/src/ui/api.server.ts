import { createRouterClient } from "@orpc/server";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { type ApiClient, apiRouter } from "@webcraft/api";

import { startWebServices } from "../web-services.ts";

/** The Management API, called in-process with the cookies of the request being rendered. */
export async function serverApi(): Promise<ApiClient> {
	const services = await startWebServices();
	const headers = new Headers(getRequestHeaders() as HeadersInit);
	return createRouterClient(apiRouter, { context: { services, headers } });
}
