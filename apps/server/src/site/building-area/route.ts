import {
	type AdminLanguageCode,
	BUILDING_AREA_PAGE_PATH,
	BUILDING_AREA_PATH,
	type InstallServices,
	isEditPath,
	type SiteHost,
} from "@webcraft/core";

import en from "../../messages/en.json" with { type: "json" };
import it from "../../messages/it.json" with { type: "json" };
import { plainText } from "../../responses.ts";
import type { ShellConfig } from "../../ui/building-area/api.ts";
import { buildingAreaCookieOf } from "../cookies.ts";
import { editSessionOf, safeModeOf } from "../edit-mode.ts";
import { buildingAreaAssets } from "./assets.ts";
import { shellHeaders } from "./headers.ts";

/** The building area's words, by Admin language (`buildingArea` in the admin's message files). */
const WORDS: Record<AdminLanguageCode, typeof en.buildingArea> = { en: en.buildingArea, it: it.buildingArea };

/**
 * The building area (ADR 0037) on a Site's own address, `/_webcraft/build/…`: the shell for a browser
 * in Edit mode that entered it, a page that sends everyone else to the admin. Answers null for paths
 * outside it.
 */
export async function buildingAreaEndpoint(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<Response | null> {
	const url = new URL(request.url);
	const root = BUILDING_AREA_PATH.slice(0, -1);
	if (url.pathname !== root && !url.pathname.startsWith(BUILDING_AREA_PATH)) return null;
	if (request.method !== "GET" && request.method !== "HEAD") {
		return plainText(405, "Method Not Allowed", { allow: "GET, HEAD", "x-robots-tag": "noindex" });
	}
	if (url.pathname === root || url.pathname === BUILDING_AREA_PATH) {
		return new Response(null, {
			status: 303,
			headers: { location: `${BUILDING_AREA_PAGE_PATH}/`, "cache-control": "no-store", "x-robots-tag": "noindex" },
		});
	}
	const page = pageIn(url);
	if (page === null) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
	const edit = await editSessionOf(services, request, host);
	const returnTo = buildingAreaCookieOf(request);
	const settings = await services.settings.read();
	if (!edit.session || returnTo === null) {
		return signedOut(request, host, services.config.adminOrigin, settings.defaultAdminLanguage, page);
	}
	const person = await services.people.get(edit.session.personId);
	const language = person?.adminLanguage ?? settings.defaultAdminLanguage;
	const config: ShellConfig = {
		token: edit.session.headerToken,
		page: `${page}${url.search}`,
		returnTo: new URL(returnTo, services.config.adminOrigin).toString(),
		language,
		words: WORDS[language],
		safe: safeModeOf(request),
	};
	const files = await buildingAreaAssets();
	const html = [
		"<!doctype html>",
		`<html lang="${language}" class="dark">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		`<title>${escapeText(WORDS[language].pageTitle)}</title>`,
		`<link rel="stylesheet" href="${files.shellStyles.path}">`,
		`<script type="module" src="${files.shell.path}"></script>`,
		"</head>",
		'<body class="wc-shell">',
		'<div id="webcraft-building-area"></div>',
		`<script type="application/json" id="webcraft-building-area-config">${jsonInHtml(config)}</script>`,
		"</body>",
		"</html>",
	].join("\n");
	return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: shellHeaders(url) });
}

/**
 * The page a shell address opens: the path after `/_webcraft/build/page` (the home page when there is
 * none). Null for any other address of the building area, or a path that isn't one on the Site.
 */
function pageIn(url: URL): string | null {
	if (url.pathname !== BUILDING_AREA_PAGE_PATH && !url.pathname.startsWith(`${BUILDING_AREA_PAGE_PATH}/`)) return null;
	const page = url.pathname.slice(BUILDING_AREA_PAGE_PATH.length) || "/";
	return isEditPath(page) ? page : null;
}

/**
 * The building area for a browser that isn't in it (no Edit mode session on this Site, or a session
 * that didn't enter the building area): a 401 page in the Install's Admin language, linking to the
 * admin, where the building area is opened.
 */
async function signedOut(
	request: Request,
	host: SiteHost,
	adminOrigin: string,
	language: AdminLanguageCode,
	page: string,
): Promise<Response> {
	const words = WORDS[language].signedOut;
	const files = await buildingAreaAssets();
	const admin = new URL(`/sites/${host.site.id}/build`, adminOrigin);
	admin.searchParams.set("open", `/page${page}`);
	const html = [
		"<!doctype html>",
		`<html lang="${language}" class="dark">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		`<title>${escapeText(words.pageTitle)}</title>`,
		`<link rel="stylesheet" href="${files.shellStyles.path}">`,
		"</head>",
		'<body class="wc-shell">',
		'<main class="wc-signed-out">',
		`<h1>${escapeText(words.pageTitle)}</h1>`,
		`<p>${escapeText(words.text)}</p>`,
		`<p><a href="${escapeText(admin.toString())}">${escapeText(words.link)}</a></p>`,
		"</main>",
		"</body>",
		"</html>",
	].join("\n");
	const url = new URL(request.url);
	return new Response(request.method === "HEAD" ? null : html, { status: 401, headers: shellHeaders(url) });
}

/** Text and attribute values in HTML. */
function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** JSON inside a `<script type="application/json">` block: nothing in it can close the block. */
function jsonInHtml(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll(" ", "\\u2028")
		.replaceAll(" ", "\\u2029");
}
