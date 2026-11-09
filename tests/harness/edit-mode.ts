// Edit mode as a browser uses it: "Edit on site" in the admin gives a link, the browser follows it
// on the Site's own domain (which sets the edit cookie there), then loads pages and sends edit
// requests from the Site's own pages, as the editing bar does.
import { expect } from "bun:test";

import type { TestBrowser, TestInstall } from "./index.ts";

/** The header edit requests carry, with the Edit mode session's header token. */
export const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

/** One browser in Edit mode on one Site. */
export type EditModeBrowser = {
	/** The Site's origin, such as `https://bakery.sites.test`. */
	origin: string;
	/** The browser itself, on the Site's pages: it holds the edit cookie. */
	browser: TestBrowser;
	/** Loads a page of the Site, with the edit cookie. */
	page(path: string): Promise<Response>;
	/** The header token the last page loaded in Edit mode carried (its `<meta>`). */
	headerToken(): Promise<string>;
	/**
	 * Sends an edit request as the editing bar does: a `POST` of JSON from the Site's own page, with
	 * the header token. `options` change what the request carries, to test refusals.
	 */
	edit(
		action: string,
		body?: unknown,
		options?: { headerToken?: string | null; origin?: string | null; fetchSite?: string | null },
	): Promise<Response>;
};

/** The header token in a page rendered for Edit mode, or undefined when the page isn't one. */
export function headerTokenIn(html: string): string | undefined {
	return /<meta name="webcraft-edit-token" content="([^"]+)">/.exec(html)?.[1];
}

/**
 * Opens a Site in Edit mode for the person whose admin browser this is: asks for a link with
 * "Edit on site" and follows it in a new browser on the Site's domain.
 */
export async function openEditMode(
	install: TestInstall,
	admin: TestBrowser,
	siteId: string,
	path = "/",
): Promise<EditModeBrowser> {
	const { url } = await admin.api.editMode.open({ siteId, path });
	const origin = new URL(url).origin;
	const browser = install.browser({ origin });
	const entered = await browser.request(url);
	expect(entered.status).toBe(303);
	let token: string | undefined;
	const page = async (pagePath: string) => {
		const response = await browser.request(new URL(pagePath, origin));
		const found = headerTokenIn(await response.clone().text());
		if (found) token = found;
		return response;
	};
	// The browser goes on to the page the link opens, as a browser following the redirect does.
	await page(path);
	const headerToken = async () => {
		if (!token) throw new Error("No page loaded in Edit mode carried a header token.");
		return token;
	};
	return {
		origin,
		browser,
		page,
		headerToken,
		async edit(action, body = {}, options = {}) {
			const headers = new Headers({ "content-type": "application/json" });
			const sent = options.headerToken === undefined ? await headerToken() : options.headerToken;
			if (sent !== null) headers.set(EDIT_TOKEN_HEADER, sent);
			const request = new Request(`${origin}/_webcraft/edit/api/${action}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			if (options.origin === undefined && options.fetchSite === undefined) return browser.request(request);
			// A request another site's page makes, or one no browser would make: sent as it is, with the cookie.
			const raw = new Headers(request.headers);
			const cookies = Array.from(browser.cookies, ([name, value]) => `${name}=${value}`).join("; ");
			if (cookies) raw.set("cookie", cookies);
			if (options.origin) raw.set("origin", options.origin);
			if (options.fetchSite) raw.set("sec-fetch-site", options.fetchSite);
			return install.request(new Request(request, { headers: raw }));
		},
	};
}
