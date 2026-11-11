// Code mode as the editing bar uses it (ADR 0016): Staff in Edit mode turn it on with an edit
// request, then pages show the Drafts of the Site's Structure with every element tagged with where
// it comes from, and Code mode's own requests read and save Template markup, CSS and scripts.
import { expect } from "bun:test";

import { type EditModeBrowser, openEditMode } from "./edit-mode.ts";
import type { TestBrowser, TestInstall } from "./index.ts";

/**
 * Opens a Site in Edit mode for the person whose admin browser this is, and turns Code mode on
 * there, as the editing bar's Code button does.
 */
export async function openCodeMode(
	install: TestInstall,
	admin: TestBrowser,
	siteId: string,
	path = "/",
): Promise<EditModeBrowser> {
	const editing = await openEditMode(install, admin, siteId, path);
	const started = await editing.edit("code/start");
	expect(started.status).toBe(200);
	await editing.page(path);
	return editing;
}

/** An edit request's JSON answer, failing the test unless it answered 200. */
export async function answer<T = Record<string, unknown>>(response: Response | Promise<Response>): Promise<T> {
	const received = await response;
	const body = await received.text();
	if (received.status !== 200) throw new Error(`Expected 200, got ${received.status}: ${body}`);
	return JSON.parse(body) as T;
}

/** The elements of a page tagged for Code mode, as `[tag, data-wc-code]` in page order. */
export function codeTagsIn(html: string): [string, string][] {
	return [...html.matchAll(/<([a-z0-9]+)[^>]*? data-wc-code="([^"]+)"/g)].map((match) => [
		match[1] ?? "",
		match[2] ?? "",
	]);
}

/** The <main> of a page's HTML: what is between its tags. */
export function mainOf(html: string): string {
	return withoutCodeRanges(/<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "");
}

/** The <head> of a page's HTML. */
export function headOf(html: string): string {
	return /<head>\n([\s\S]*)\n<\/head>/.exec(html)?.[1] ?? "";
}

/** The Site's stylesheet a page in Edit mode links: the one that isn't the editing bar's. */
export function siteStylesheetIn(html: string): string {
	const links = [...headOf(html).matchAll(/<link rel="stylesheet" href="([^"]+)">/g)]
		.map((match) => match[1] ?? "")
		.filter((href) => !href.startsWith("/_webcraft/edit/assets/"));
	if (links.length !== 1) throw new Error(`The page links ${links.length} stylesheets of the Site.`);
	return links[0] ?? "";
}

/** Compare rendered HTML independently of the editor's layout-neutral source-range annotations. */
export function withoutCodeRanges(html: string): string {
	return html.replace(/<!--wc-code-(?:start|end) [^>]*-->/g, "");
}
