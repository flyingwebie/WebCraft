import { createHash } from "node:crypto";
import {
	type AdminLanguageCode,
	BUILDING_AREA_PATH,
	ComponentNotFoundError,
	EntryNotFoundError,
	type InstallServices,
	PostTypeNotFoundError,
	printBuildingDocument,
	type SiteHost,
	type StandInDocument,
	standInDocumentOf,
} from "@webcraft/core";

import en from "../../messages/en.json" with { type: "json" };
import it from "../../messages/it.json" with { type: "json" };
import { plainText } from "../../responses.ts";
import { buildingAreaCookieOf } from "../cookies.ts";
import { editSessionOf } from "../edit-mode.ts";
import { buildingAreaAssets } from "./assets.ts";

/** The words of what only a page shows, which the stand-in draws as placeholders (the builder's own). */
const PLACEHOLDERS: Record<AdminLanguageCode, Record<string, string>> = {
	en: en.builder.canvas.placeholders,
	it: it.builder.canvas.placeholders,
};

/**
 * The stand-in's own styles: placeholders for what only a page shows, and a Placement visitors
 * don't see shown faintly (as the builder's canvas draws them).
 */
const STAND_IN_CSS = [
	"[data-wc-builder-placeholder]{display:block;box-sizing:border-box;margin:.5rem 0;padding:1rem;border:2px dashed #a1a1aa;border-radius:.375rem;background:#f4f4f5;color:#3f3f46;font:500 14px/1.4 system-ui,sans-serif;text-align:center}",
	"[data-wc-builder-placeholder=themeToggle],[data-wc-builder-placeholder=consentSettings]{display:inline-block;margin:0;padding:.25rem .5rem}",
	"[data-wc-hidden-placement]:not([data-wc-hidden-placement] *){opacity:.45}",
].join("\n");

/** Errors that mean the address names nothing of this Site's. */
const NOT_FOUND = [ComponentNotFoundError, PostTypeNotFoundError, EntryNotFoundError];

/**
 * The stand-in (ADR 0037 › Addresses): a Template or Component that no page shows, drawn as the
 * visual builder previews it (`builder.preview`: the tree rendered as the Site renders it, with real
 * values where the Site has them and placeholders for what only a page has), as a document the
 * building area's frame shows. `GET /_webcraft/build/stand-in/<document>` on the Site's address, such
 * as `/_webcraft/build/stand-in/component/<id>` or `/stand-in/entry-template/<id>?entry=<id>`.
 *
 * It carries the page agent first and the Design system Draft's stylesheet, and none of the Site's
 * scripts: its policy allows WebCraft's own files only, and its styles by their hashes. Only someone
 * in the building area who may change the Site's Structure (`structure.edit`) gets it; anyone else
 * gets a plain refusal. Opened at the top level, it goes into the shell at that document.
 */
export async function standInEndpoint(services: InstallServices, request: Request, host: SiteHost): Promise<Response> {
	const url = new URL(request.url);
	const document = standInDocumentOf(`${url.pathname}${url.search}`);
	if (!document) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
	const edit = await editSessionOf(services, request, host);
	if (!edit.session || buildingAreaCookieOf(request) === null) {
		return plainText(401, "Open the building area from the admin.", { "x-robots-tag": "noindex" });
	}
	if (request.headers.get("sec-fetch-dest") === "document") {
		// Opened at the top level: the shell shows it in its frame.
		return new Response(null, {
			status: 303,
			headers: {
				location: `${BUILDING_AREA_PATH.slice(0, -1)}${printBuildingDocument(document)}`,
				"cache-control": "no-store",
				"x-robots-tag": "noindex",
			},
		});
	}
	const scope = await services.codeMode.openIfAllowed(edit.session);
	if (!scope) return plainText(403, "Forbidden", { "x-robots-tag": "noindex" });

	const target = builderTarget(document);
	let drawn: { html: string; css: string; language: { code: string; direction: "ltr" | "rtl" } };
	try {
		const opened = await services.builder.open(scope, target);
		const preview = await services.builder.preview(scope, target, {
			tree: opened.tree,
			...(document.kind === "entryTemplate" && document.entryId ? { entryId: document.entryId } : {}),
		});
		drawn = { html: preview.html, css: preview.css, language: opened.language };
	} catch (error) {
		if (NOT_FOUND.some((kind) => error instanceof kind))
			return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
		throw error;
	}

	const person = await services.people.get(edit.session.personId);
	const language = person?.adminLanguage ?? (await services.settings.read()).defaultAdminLanguage;
	// The preview names the Site's files where the admin serves them; here they are on the Site's own address.
	const onSite = (text: string) => text.replaceAll(`/api/media/${host.site.id}/`, "/_media/");
	// Nothing in the Draft's CSS may close its block (`<\/style` is the same inside a CSS string).
	const css = onSite(drawn.css).replace(/<\/(style)/gi, "<\\/$1");
	const files = await buildingAreaAssets();
	const html = [
		"<!doctype html>",
		`<html lang="${escapeText(drawn.language.code)}" dir="${drawn.language.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		`<script src="${files.agent.path}"></script>`,
		`<link rel="stylesheet" href="${files.agentStyles.path}">`,
		`<style>${css}</style>`,
		`<style>${STAND_IN_CSS}</style>`,
		"</head>",
		'<body data-wc-stand-in="">',
		worded(onSite(drawn.html), PLACEHOLDERS[language]),
		"</body>",
		"</html>",
	].join("\n");
	return new Response(request.method === "HEAD" ? null : html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-robots-tag": "noindex, nofollow",
			"referrer-policy": "same-origin",
			"x-content-type-options": "nosniff",
			"x-frame-options": "SAMEORIGIN",
			"content-security-policy": standInPolicy([css, STAND_IN_CSS]),
		},
	});
}

/**
 * The stand-in's policy: scripts only from the Site's own address (the page agent, the one script it
 * names), its two style blocks by their hashes, images and video as Site pages show them, framed by
 * its own origin only, nothing posted.
 */
function standInPolicy(styles: readonly string[]): string {
	const hashes = styles.map((text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`);
	return [
		"default-src 'self'",
		"script-src 'self'",
		`style-src 'self' ${hashes.join(" ")}`,
		"img-src 'self' data: https:",
		"media-src 'self' https:",
		"font-src 'self'",
		"connect-src 'self'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'self'",
	].join("; ");
}

/** The builder's target for a document the stand-in draws. */
function builderTarget(document: StandInDocument) {
	switch (document.kind) {
		case "entryTemplate":
			return { kind: "entryTemplate", postTypeId: document.postTypeId } as const;
		case "archiveTemplate":
			return { kind: "archiveTemplate", postTypeId: document.postTypeId } as const;
		case "component":
			return { kind: "component", componentId: document.componentId } as const;
		default:
			return { kind: document.kind } as const;
	}
}

/**
 * The preview's placeholders with their words in: the preview leaves them empty for the canvas to word
 * (`<span data-wc-builder-placeholder="form" data-wc-builder-name="contact">`). A name is escaped for an
 * attribute already, which is as escaped as text needs.
 */
function worded(html: string, words: Record<string, string>): string {
	return html.replace(
		/<span data-wc-builder-placeholder="([A-Za-z]+)"(?: data-wc-builder-name="([^"]*)")?><\/span>/g,
		(whole, kind: string, name: string | undefined) => {
			const text = words[kind] ?? words.outlet ?? "";
			const filled = escapeText(text).replace("{name}", name ?? "");
			return whole.replace("></span>", `>${filled}</span>`);
		},
	);
}

/** Text and attribute values in HTML. */
function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
