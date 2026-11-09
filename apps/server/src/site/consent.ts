import type { InstallServices, SiteHost } from "@webcraft/core";
import { CHOSEN_CATEGORIES, CONSENT_RECORD_PATH } from "@webcraft/renderer";

import { clientAddress } from "../client-address.ts";
import { plainText } from "../responses.ts";
import { siteScriptCookie } from "./cookies.ts";

/**
 * Consent records on a Site (ADR 0020): the consent script posts a visitor's choice on the Consent
 * banner to `POST /_wc/consent`, on the Site's own domain, as JSON. The Site keeps the record (with
 * nothing that identifies the visitor) and answers its id, setting the `webcraft.consent` cookie the
 * consent script reads on the visitor's next pages. Never cached.
 *
 * Like Form posts, a choice is taken only from the Site's own pages (`Sec-Fetch-Site: same-origin`, or
 * an `Origin` on the same host), so no other site can record choices for a visitor.
 */

/** The cookie a visitor's choice is kept in: `webcraft.consent`, for six months (records are kept 12). */
export const CONSENT_COOKIE = "consent";
const CONSENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

/** How big a choice may be: a few categories, a version and a language. */
const MAX_BYTES = 2048;

const NO_STORE = { "cache-control": "no-store" };

/** Whether a request is for the Consent record path. */
export function isConsentPath(pathname: string): boolean {
	return pathname === CONSENT_RECORD_PATH || pathname.startsWith(`${CONSENT_RECORD_PATH}/`);
}

/** Answers `/_wc/consent` on a Site. */
export async function consentRecordPost(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	addressHeaders: Record<string, string>,
): Promise<Response> {
	const url = new URL(request.url);
	const headers = { ...NO_STORE, ...addressHeaders };
	if (url.pathname !== CONSENT_RECORD_PATH) return plainText(404, "Not Found", headers);
	if (request.method !== "POST") return plainText(405, "Method Not Allowed", { allow: "POST", ...headers });
	if (!fromSitePages(request)) return plainText(403, "Forbidden", headers);
	const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json") return plainText(415, "Unsupported Media Type", headers);
	const text = await readLimited(request, MAX_BYTES);
	if (text === null) return plainText(413, "Payload Too Large", headers);
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		return plainText(400, "Bad Request", headers);
	}
	const answer = await services.consent.record(host.site, input, clientAddress(request, services.config));
	switch (answer.kind) {
		case "notAsked":
			return plainText(404, "Not Found", headers);
		case "invalid":
			return plainText(400, "Bad Request", headers);
		case "limited":
			return plainText(429, "Too Many Requests", { "retry-after": String(answer.retryAfterSeconds), ...headers });
		case "recorded": {
			const bits = CHOSEN_CATEGORIES.map((category) => (answer.choices[category] ? "1" : "0")).join("");
			const value = `${answer.id}.${answer.version}.${bits}`;
			return new Response(JSON.stringify({ id: answer.id }), {
				status: 201,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"set-cookie": siteScriptCookie(url.hostname, CONSENT_COOKIE, value, CONSENT_COOKIE_MAX_AGE),
					...headers,
				},
			});
		}
	}
}

/**
 * Whether a post comes from the Site's own pages: `Sec-Fetch-Site: same-origin`, or an `Origin` on
 * the same host (browsers send it with every POST) where the browser doesn't say otherwise.
 */
function fromSitePages(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null) return fetchSite === "same-origin";
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

/** The body as text, or null when it is longer than `limit` bytes. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > limit) return null;
	const bytes = new Uint8Array(await request.arrayBuffer());
	return bytes.byteLength > limit ? null : new TextDecoder().decode(bytes);
}
