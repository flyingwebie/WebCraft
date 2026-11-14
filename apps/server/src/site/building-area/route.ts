import {
	type AdminLanguageCode,
	BUILDING_AREA_PAGE_PATH,
	BUILDING_AREA_PATH,
	BUILDING_AREA_STAND_IN_PATH,
	can,
	type InstallServices,
	parseBuildingDocument,
	type SiteHost,
	stagingUrl,
} from "@webcraft/core";

import en from "../../messages/en.json" with { type: "json" };
import it from "../../messages/it.json" with { type: "json" };
import { plainText } from "../../responses.ts";
import { type AdminMessages, SHELL_PERMISSIONS, type ShellConfig } from "../../ui/building-area/api.ts";
import { buildingAreaCookieOf } from "../cookies.ts";
import { editSessionOf, safeModeOf } from "../edit-mode.ts";
import { buildingAreaAssets } from "./assets.ts";
import { shellHeaders } from "./headers.ts";
import { standInEndpoint } from "./stand-in.ts";

/** The building area's words, by Admin language (`buildingArea` in the admin's message files). */
const WORDS: Record<AdminLanguageCode, typeof en.buildingArea> = { en: en.buildingArea, it: it.buildingArea };

/** The admin's own words for the admin parts the shell reuses (the Media library's, BA-22), by Admin language. */
const ADMIN_MESSAGES: Record<AdminLanguageCode, AdminMessages> = { en: adminMessagesOf(en), it: adminMessagesOf(it) };

function adminMessagesOf(messages: typeof en): AdminMessages {
	return {
		media: messages.media,
		forms: messages.forms,
		errors: messages.errors,
		popups: { title: messages.popups.title },
		content: { media: messages.content.media, builtIn: messages.content.builtIn },
		editBar: { codeMode: { errors: messages.editBar.codeMode.errors } },
		loops: { query: messages.loops.query },
		entries: { status: messages.entries.status },
	};
}

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
	if (url.pathname.startsWith(`${BUILDING_AREA_STAND_IN_PATH}/`)) return standInEndpoint(services, request, host);
	// The document the address opens (ADR 0037 › Addresses); an address that opens none still gets the
	// shell, which says so (404), so a mistyped or stale address is never a dead end.
	const open = documentIn(url);
	const document = open === null ? null : parseBuildingDocument(open);
	const edit = await editSessionOf(services, request, host);
	const returnTo = buildingAreaCookieOf(request);
	const settings = await services.settings.read();
	if (!edit.session || returnTo === null) {
		if (!document) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
		return signedOut(request, host, services.config.adminOrigin, settings.defaultAdminLanguage, open ?? "/page/");
	}
	const person = await services.people.get(edit.session.personId);
	const language = person?.adminLanguage ?? settings.defaultAdminLanguage;
	const designSystem = (await services.designSystem.get(edit.session.scope)).draft;
	const staging = stagingUrl(services.config, host.site.slug);
	const siteLanguages = await services.languages.get(edit.session.scope);
	const { site } = edit.session.scope;
	const resource = { level: "site", workspaceId: site.workspaceId, siteId: site.id } as const;
	const preferences = await services.people.editorPreferences(edit.session.personId);
	const branding = await services.email.branding.resolve();
	const config: ShellConfig = {
		token: edit.session.headerToken,
		page: document?.kind === "page" ? document.page : null,
		returnTo: new URL(returnTo, services.config.adminOrigin).toString(),
		language,
		words: WORDS[language],
		safe: safeModeOf(request),
		site: { id: host.site.id, name: host.site.name },
		person: { name: person?.name ?? "" },
		breakpoints: [...designSystem.tokens.breakpoints]
			.sort((a, b) => a.width - b.width)
			.map(({ name, width }) => ({ name, width })),
		darkMode: designSystem.darkMode,
		staging: staging && host.address !== "staging" ? staging : null,
		settings: new URL(`/sites/${host.site.id}/domains`, services.config.adminOrigin).toString(),
		admin: new URL(`/sites/${host.site.id}`, services.config.adminOrigin).toString(),
		languages: {
			default: siteLanguages.defaultLanguage,
			all: siteLanguages.languages.map(({ code, name }) => ({ code, name })),
		},
		permissions: SHELL_PERMISSIONS.filter((permission) => can(edit.session.scope.access.actor, permission, resource)),
		adminMessages: ADMIN_MESSAGES[language],
		layout: preferences.layout,
		hintSeen: preferences.hintSeen,
		agency: { name: branding.senderName, note: branding.footer },
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
	return new Response(request.method === "HEAD" ? null : html, {
		status: document ? 200 : 404,
		headers: shellHeaders(url),
	});
}

/** The shell's own parameters, which belong to no document: the open place, its view and the selection. */
const SHELL_PARAMETERS = ["wc-place", "wc-view", "wc-select"];

/**
 * The document part of a shell address (after `/_webcraft/build`, with the document's own query, the
 * shell's parameters left out), as `parseBuildingDocument` reads it; null when the address isn't
 * printable ASCII, as a browser sends it.
 */
function documentIn(url: URL): string | null {
	// A page's query is the page's own: kept as the browser wrote it, unless the shell added to it.
	let search = url.search;
	if (SHELL_PARAMETERS.some((name) => url.searchParams.has(name))) {
		const params = new URLSearchParams(url.search);
		for (const name of SHELL_PARAMETERS) params.delete(name);
		search = params.size ? `?${params.toString()}` : "";
	}
	const open = `${url.pathname.slice(BUILDING_AREA_PATH.length - 1)}${search}`;
	return /^[\x21-\x7e]*$/.test(open) ? open : null;
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
	open: string,
): Promise<Response> {
	const words = WORDS[language].signedOut;
	const files = await buildingAreaAssets();
	const admin = new URL(`/sites/${host.site.id}/build`, adminOrigin);
	admin.searchParams.set("open", open);
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
