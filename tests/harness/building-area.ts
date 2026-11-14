// The building area (ADR 0037) as a browser uses it: the admin's way in asks for a link that opens
// it (`editMode.open` with `building`), the browser follows it on the Site's own domain (which sets
// the edit cookie and the building-area cookie there) and lands on the shell, which frames the page.
import { expect } from "bun:test";

import { EDIT_TOKEN_HEADER } from "./edit-mode.ts";
import type { TestBrowser, TestInstall } from "./index.ts";

/** One browser in the building area on one Site. */
export type BuildingAreaBrowser = {
	/** The Site's origin, such as `https://bakery.sites.test`. */
	origin: string;
	/** The browser itself, on the Site's address: it holds the edit cookie and the building-area cookie. */
	browser: TestBrowser;
	/** Where following the link sent the browser (the shell's address). */
	landed: string;
	/** Loads the shell at an address of the building area, such as `/_webcraft/build/page/blog/fresh-bread`. */
	shell(address: string): Promise<Response>;
	/**
	 * Loads a page of the Site as the shell's frame does (`Sec-Fetch-Dest: iframe`), or as a page opened
	 * at the top level (`document`), or as a client that says neither (null).
	 */
	page(path: string, destination?: "iframe" | "document" | null): Promise<Response>;
	/** The session's header token, as the shell's document carries it. */
	headerToken(): Promise<string>;
	/** Sends an edit request as the shell does: a `POST` of JSON from the Site's own page, with the header token. */
	edit(action: string, body?: unknown): Promise<Response>;
};

/** The JSON block the shell's document starts from, read as the shell reads it. */
export function shellConfigIn(html: string): Record<string, unknown> | undefined {
	const block = /<script type="application\/json" id="webcraft-building-area-config">([^<]*)<\/script>/.exec(html)?.[1];
	return block ? (JSON.parse(block) as Record<string, unknown>) : undefined;
}

/**
 * Opens the building area for the person whose admin browser this is, as the admin's way in does,
 * and follows the link in a new browser on the Site's domain.
 */
export async function openBuildingArea(
	install: TestInstall,
	admin: TestBrowser,
	siteId: string,
	options: { open?: string; returnTo?: string; path?: string; safeMode?: boolean } = {},
): Promise<BuildingAreaBrowser> {
	const { url } = await admin.api.editMode.open({
		siteId,
		building: true,
		...(options.path ? { path: options.path } : {}),
		...(options.open ? { open: options.open } : {}),
		...(options.returnTo ? { returnTo: options.returnTo } : {}),
		...(options.safeMode ? { safeMode: true } : {}),
	});
	const origin = new URL(url).origin;
	const browser = install.browser({ origin });
	const entered = await browser.request(url);
	expect(entered.status).toBe(303);
	const landed = entered.headers.get("location") ?? "";
	let token: string | undefined;
	const shell = async (address: string) => {
		const response = await browser.request(new URL(address, origin));
		const config = shellConfigIn(await response.clone().text());
		if (typeof config?.token === "string") token = config.token;
		return response;
	};
	await shell(landed);
	const headerToken = async () => {
		if (!token) throw new Error("No shell loaded in the building area carried a header token.");
		return token;
	};
	return {
		origin,
		browser,
		landed,
		shell,
		page(path, destination = "iframe") {
			const headers = new Headers();
			if (destination) headers.set("sec-fetch-dest", destination);
			return browser.request(new URL(path, origin), { headers });
		},
		headerToken,
		async edit(action, body = {}) {
			return browser.request(`${origin}/_webcraft/edit/api/${action}`, {
				method: "POST",
				headers: { "content-type": "application/json", [EDIT_TOKEN_HEADER]: await headerToken() },
				body: JSON.stringify(body),
			});
		},
	};
}
