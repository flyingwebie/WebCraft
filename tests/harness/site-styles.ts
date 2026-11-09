/**
 * Reading a Site's styling the way a browser does: the stylesheet a page links in its <head>, the
 * file served there, and the cascade layers in it.
 */
import type { TestInstall } from "./index.ts";

/** The address of the one stylesheet a page links in its <head>; throws unless there is exactly one. */
export function stylesheetIn(html: string): string {
	const head = /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? "";
	const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1] ?? "");
	if (links.length !== 1) throw new Error(`The page links ${links.length} stylesheets:\n${head}`);
	return links[0] ?? "";
}

/** The page at `url` and the stylesheet it links, as served. */
export async function pageWithStyles(install: TestInstall, url: string): Promise<{ html: string; css: string }> {
	const html = await (await install.request(url)).text();
	const response = await install.request(new URL(stylesheetIn(html), url).href);
	if (response.status !== 200) throw new Error(`The stylesheet answered ${response.status}.`);
	return { html, css: await response.text() };
}

/** The rules of one cascade layer of a stylesheet, as written inside `@layer <name> { … }`; "" when it has none. */
export function layerOf(css: string, name: string): string {
	return new RegExp(`^@layer ${name} \\{\\n([\\s\\S]*?)\\n\\}$`, "m").exec(css)?.[1] ?? "";
}
