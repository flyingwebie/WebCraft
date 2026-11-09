import type { RedirectRequest, RedirectTarget } from "@webcraft/module-sdk";

import { languageOfPath, prefixOf, type SiteLanguages } from "../content/languages.ts";
import { canonicalPath, pathSegments } from "../content/url-patterns.ts";
import { placeOf } from "../domains/addresses.ts";
import type { Site } from "../tenancy/data-layer.ts";
import type { SiteHost } from "./index.ts";

/**
 * Redirect rules and the 404 log on the Site side (SDK 1.5): what the Site pipeline asks the Module
 * keeping them, in **Site paths** (a path as the Site's Staging address writes it, every language but
 * the Default language under its prefix), and how their answers become addresses on the hostname a
 * request came in on.
 */

/** Where a Redirect rule sends a request: a path on its hostname or an address elsewhere, without the request's query. */
export type SiteRedirect = { location: string; status: 301 | 302 };

/** What the Site pipeline lets the Module host know about a Site's paths while it follows rules. */
export type RedirectPaths = {
	/** Whether a page answers a Site path now. */
	hasPage(path: string): Promise<boolean>;
	/** The language of a Site path. */
	languageOf(path: string): string;
};

/** Asks the Module keeping Redirect rules on a Site (`ModuleHost.redirectFor`). */
export type RedirectsOf = (
	site: Site,
	request: RedirectRequest,
	paths: RedirectPaths,
) => Promise<Pick<RedirectTarget, "to" | "status"> | null>;

/** A visitor's request for a path with no page, for the Site's 404 log. */
export type NotedMiss = { path: string; language: string; referrerHost: string | null; at: Date };

/** Hands a miss to the Module keeping the 404 log (`ModuleHost.noteMiss`). */
export type MissesOf = { keeps: boolean; note(site: Site, miss: NotedMiss): void };

/**
 * A request's path as a Site path, with its language: on a language's own domain an unprefixed path
 * gets that language's prefix (`fr.example.com/x` is `/fr/x`); everywhere else it is the path asked
 * for, prefix and all.
 */
export function sitePathIn(site: SiteLanguages, host: SiteHost, segments: readonly string[]): RedirectRequest {
	let parts = segments;
	if (host.address === "language" && host.language) {
		const [first] = segments;
		const named = first !== undefined && site.languages.some((language) => prefixOf(language.code) === first);
		if (!named && host.language !== site.defaultLanguage) parts = [prefixOf(host.language), ...segments];
	}
	return { path: canonicalPath(parts), language: languageOf(site, canonicalPath(parts)) };
}

/** The language of a Site path: its prefix's, else the Default language. */
export function languageOf(site: SiteLanguages, path: string): string {
	return languageOfPath(site, pathSegments(path) ?? []).languages.language;
}

/**
 * Where a Redirect rule's target is, from the hostname a request came in on: a Site path goes where
 * that path's language lives (on a language's own domain without its prefix, as an absolute
 * address when that is another of the Site's hostnames); an address elsewhere stays as it is.
 */
export function addressFrom(site: SiteLanguages, host: SiteHost, target: string): string {
	if (!target.startsWith("/")) return target;
	const cut = target.search(/[?#]/);
	const path = cut === -1 ? target : target.slice(0, cut);
	const suffix = cut === -1 ? "" : target.slice(cut);
	const languages = languageOfPath(site, pathSegments(path) ?? []).languages;
	const there = placeOf(host.addresses, languages, path);
	return there.origin === host.origin ? `${there.path}${suffix}` : `${there.origin}${there.path}${suffix}`;
}

/** How many Redirect rule answers a web process keeps, over every Site. */
const KEPT_ANSWERS = 20_000;

/**
 * Redirect rule answers, kept like pages: by the address's origin and path, under the Site's page
 * cache generation (a publish, a setting, or a change to the rules raises it). A request that read an
 * older generation never replaces a newer answer. The answers used least recently go first.
 */
export function createRedirectAnswers() {
	const kept = new Map<string, { generation: number; answer: SiteRedirect | null }>();
	return {
		get(host: SiteHost, key: string): SiteRedirect | null | undefined {
			const id = `${host.site.id}\n${key}`;
			const found = kept.get(id);
			if (!found || found.generation !== host.cacheGeneration) return undefined;
			kept.delete(id);
			kept.set(id, found);
			return found.answer;
		},
		set(host: SiteHost, key: string, answer: SiteRedirect | null): void {
			const id = `${host.site.id}\n${key}`;
			const found = kept.get(id);
			if (found && found.generation > host.cacheGeneration) return;
			kept.delete(id);
			kept.set(id, { generation: host.cacheGeneration, answer });
			if (kept.size > KEPT_ANSWERS) kept.delete(kept.keys().next().value as string);
		},
	};
}
