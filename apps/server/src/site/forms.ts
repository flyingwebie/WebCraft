import { FORM_POST_MAX_BYTES, type InstallServices, SENT_PARAMETER, type SiteHost } from "@webcraft/core";
import { FORM_POST_PATH, FORM_TOKEN_MARK } from "@webcraft/renderer";

import { clientAddress } from "../client-address.ts";
import { plainText } from "../responses.ts";
import { editSessionOf } from "./edit-mode.ts";

/**
 * Forms on a Site (GLOSSARY.md): what visitors send to `POST /_webcraft/forms/<id>`, on the Site's
 * own domain, and the page they get back. It works without JavaScript: a post with errors gets the
 * page again with what they typed and each field's error; one that went through is redirected (post,
 * redirect, get) to the Form's Page, or to the page it came from showing the Form's message. None of
 * it is ever cached.
 *
 * Cross-site requests: pages may be cached (and later served by a CDN), so a Form carries no token
 * tied to one visitor. A post is taken only from the Site's own pages instead, by the `Origin` the
 * browser sends with every POST (or `Sec-Fetch-Site: same-origin`), and the Site's pages send
 * `form-action 'self'` in their CSP (#99), so a Form can't be made to post elsewhere. The time-trap
 * token proves the post came after a page of this Site was handed out, and how long after.
 */

/** Whether a request is under the Forms' path. */
export function isFormPath(pathname: string): boolean {
	return pathname.startsWith(FORM_POST_PATH);
}

const NO_STORE = { "cache-control": "no-store" };

/** A Form's id, as its post path names it. */
const FORM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Answers `/_webcraft/forms/<id>` on a Site. */
export async function formPost(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	addressHeaders: Record<string, string>,
): Promise<Response> {
	const formId = new URL(request.url).pathname.slice(FORM_POST_PATH.length);
	if (!FORM_ID.test(formId)) return plainText(404, "Not Found", addressHeaders);
	if (request.method !== "POST") return plainText(405, "Method Not Allowed", { allow: "POST", ...addressHeaders });
	if (!fromSitePages(request)) return plainText(403, "Forbidden", addressHeaders);
	const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/x-www-form-urlencoded") {
		return plainText(415, "Unsupported Media Type", addressHeaders);
	}
	const body = await readLimited(request, FORM_POST_MAX_BYTES);
	const answer = await services.forms.receive(host, formId, {
		fields: body === null ? null : fieldsOf(body),
		clientAddress: clientAddress(request, services.config),
		referer: request.headers.get("referer"),
		via: host.address === "staging" ? "staging" : "domain",
		editing: (await editSessionOf(services, request, host)).session !== null,
		request,
	});
	switch (answer.kind) {
		case "notFound":
			return plainText(404, "Not Found", addressHeaders);
		case "tooLarge":
			return plainText(413, "Payload Too Large", addressHeaders);
		case "sent":
			return new Response(null, {
				status: 303,
				headers: { location: answer.location, ...NO_STORE, ...addressHeaders },
			});
		case "invalid": {
			// The page the Form was sent from, again for this visitor: page N of a paginated Loop when it was.
			const options = { state: { formId, instance: answer.instance, state: answer.state } };
			const rendered = await services.sitePages.render(host, answer.page, undefined, {
				forms: options,
				page: answer.pageNumber,
			});
			const page =
				rendered?.kind === "page" &&
				rendered.forms?.some((shown) => shown.formId === formId && shown.instance === answer.instance)
					? rendered
					: await services.sitePages.formPage(host, answer.page, formId, {
							state: { ...options.state, instance: 1 },
						});
			return formPage(422, page, addressHeaders);
		}
	}
}

/**
 * The page a visitor goes on to once a Form showing its message was sent (`?wc-sent=<n>`): the page
 * (page `page` of a paginated Loop), answered for them alone with the message in place of Form
 * number `n`. Null for any other request.
 */
export async function sentPage(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	page: number,
	addressHeaders: Record<string, string>,
): Promise<Response | null> {
	const url = new URL(request.url);
	const sent = url.searchParams.get(SENT_PARAMETER);
	if (sent === null) return null;
	const instance = Number(sent);
	if (!Number.isInteger(instance) || instance < 1 || instance > 1000) return null;
	const answer = await services.sitePages.render(host, url.pathname, undefined, { forms: { sent: instance }, page });
	if (answer?.kind !== "page") return null;
	return formPage(200, answer, addressHeaders);
}

/** A page answered for one visitor, with the Site's policy for it: never cached, never indexed. */
function formPage(
	status: number,
	page: { html: string; headers: Record<string, string> },
	addressHeaders: Record<string, string>,
): Response {
	return new Response(page.html, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			...page.headers,
			...NO_STORE,
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
			...addressHeaders,
		},
	});
}

/**
 * A cached page's Forms, each with a new time-trap token: the page cache holds the mark
 * (`FORM_TOKEN_MARK`), never a token, and each answer gets its own.
 */
export async function withFormTokens(services: InstallServices, host: SiteHost, html: string): Promise<string> {
	if (!html.includes(FORM_TOKEN_MARK)) return html;
	const token = await services.forms.issueToken(host.site);
	return html.replaceAll(FORM_TOKEN_MARK, token);
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

/** The body as text, or null when it is larger than `limit` bytes (reading stops there). */
async function readLimited(request: Request, limit: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > limit) {
		await request.body?.cancel();
		return null;
	}
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A form body's fields, by name: every value sent under it, in order. */
function fieldsOf(body: string): Map<string, string[]> {
	const fields = new Map<string, string[]>();
	for (const [name, value] of new URLSearchParams(body)) {
		const list = fields.get(name) ?? [];
		list.push(value);
		fields.set(name, list);
	}
	return fields;
}
