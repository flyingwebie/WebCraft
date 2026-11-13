/**
 * URL patterns: where a Post Type's Entries are, such as `/blog/{slug}`. A pattern is fixed path
 * segments (lower-case letters, digits and dashes) and exactly one `{slug}` segment, which matches an
 * Entry's published slug. Paths the Install keeps (`/_webcraft/…`, `/_media/…`, …) start with an
 * underscore, which a fixed segment can't, so no pattern reaches them.
 */

import type { SettingParams, SettingRule } from "./field-rules.ts";

type Segment = { kind: "fixed"; text: string } | { kind: "slug" };

export type UrlPattern = { pattern: string; segments: readonly Segment[] };

const FIXED_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_SEGMENT = "{slug}";

/** The most segments a pattern has. */
const MAX_SEGMENTS = 6;

/** An Entry slug: lower-case letters and digits, joined by single dashes; at most 200 characters. */
export const ENTRY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENTRY_SLUG_MAX_LENGTH = 200;

/** Why a URL pattern was refused: in English, and as a `SETTING_RULES` code for the admin to word. */
export type UrlPatternProblem = { problem: string; rule: SettingRule; params?: SettingParams };

/** Reads a URL pattern, or answers why it can't be one. */
export function parseUrlPattern(input: string): UrlPattern | UrlPatternProblem {
	const pattern = input.trim();
	const problem: UrlPatternProblem = {
		problem: `A URL pattern is a path with fixed parts (lower-case letters, digits and dashes) and one ${SLUG_SEGMENT}, such as /blog/${SLUG_SEGMENT}.`,
		rule: "urlPatternFormat",
		params: { slug: SLUG_SEGMENT },
	};
	if (!pattern.startsWith("/") || pattern.endsWith("/")) return problem;
	const parts = pattern.slice(1).split("/");
	if (parts.length > MAX_SEGMENTS) {
		return {
			problem: `A URL pattern has at most ${MAX_SEGMENTS} parts.`,
			rule: "urlPatternParts",
			params: { max: MAX_SEGMENTS },
		};
	}
	const segments: Segment[] = [];
	for (const part of parts) {
		if (part === SLUG_SEGMENT) segments.push({ kind: "slug" });
		else if (FIXED_SEGMENT.test(part)) segments.push({ kind: "fixed", text: part });
		else return problem;
	}
	if (segments.filter((segment) => segment.kind === "slug").length !== 1) return problem;
	return { pattern, segments };
}

/** The slug in `path` when it matches the pattern, else undefined. `path` is already split and decoded. */
export function slugIn(pattern: UrlPattern, path: readonly string[]): string | undefined {
	if (path.length !== pattern.segments.length) return undefined;
	let slug: string | undefined;
	for (const [index, segment] of pattern.segments.entries()) {
		const part = path[index] ?? "";
		if (segment.kind === "fixed") {
			if (part !== segment.text) return undefined;
		} else if (ENTRY_SLUG.test(part) && part.length <= ENTRY_SLUG_MAX_LENGTH) {
			slug = part;
		} else {
			return undefined;
		}
	}
	return slug;
}

/**
 * Orders patterns so the most specific is tried first: at the first segment where two differ, a
 * fixed segment comes before `{slug}`. `/news/{slug}` is tried before `/{slug}/latest`.
 */
export function bySpecificity(a: UrlPattern, b: UrlPattern): number {
	const length = Math.min(a.segments.length, b.segments.length);
	for (let index = 0; index < length; index++) {
		const left = a.segments[index]?.kind;
		const right = b.segments[index]?.kind;
		if (left !== right) return left === "fixed" ? -1 : 1;
	}
	return a.segments.length - b.segments.length || a.pattern.localeCompare(b.pattern);
}

/**
 * A request path split into decoded segments, without a trailing slash: `/blog/fresh-bread/` gives
 * `["blog", "fresh-bread"]`. Undefined for a path no Entry can have (an empty or undecodable segment).
 */
export function pathSegments(pathname: string): string[] | undefined {
	if (!pathname.startsWith("/")) return undefined;
	const trimmed = pathname.slice(1).replace(/\/$/, "");
	if (trimmed === "") return [];
	const segments: string[] = [];
	for (const part of trimmed.split("/")) {
		if (part === "") return undefined;
		try {
			segments.push(decodeURIComponent(part));
		} catch {
			return undefined;
		}
	}
	return segments;
}

/**
 * The one form of a request path WebCraft keeps pages under: decoded segments encoded again, no
 * trailing slash. `/blog/fresh-bread/` and `/blog/fresh%2Dbread` both give `/blog/fresh-bread`.
 */
export function canonicalPath(segments: readonly string[]): string {
	return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** The path of an Entry with `slug` under a URL pattern (`/blog/{slug}` gives `/blog/<slug>`), or null for a broken pattern. */
export function pathFor(pattern: string, slug: string): string | null {
	const parsed = parseUrlPattern(pattern);
	if ("problem" in parsed) return null;
	return canonicalPath(parsed.segments.map((segment) => (segment.kind === "fixed" ? segment.text : slug)));
}
