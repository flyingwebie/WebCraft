import { canonicalLanguage } from "@webcraft/renderer";

import type { LanguageChain } from "../content/field-values.ts";
import type { SiteLanguages } from "../content/languages.ts";
import { ContentApiError } from "./errors.ts";

/**
 * Reading a Content API request's query string: only the parameters each path takes, each once, and
 * every problem found at once, refused together as `QUERY_INVALID` (400) with `data.problems`, each
 * naming its `parameter` and a stable `problem` code (`CONTENT_API_QUERY_PROBLEMS`).
 */

/** The `problem` codes of `QUERY_INVALID`, with what each means. */
export const CONTENT_API_QUERY_PROBLEMS = {
	parameterUnknown: "The path doesn't take this parameter.",
	parameterRepeated: "The parameter is given more than once.",
	languageUnknown: "The Site has no such language (`lang`, `fallback`).",
	bodyFormat: "`body` is `html`, `blocks` or `markdown`.",
	fieldUnknown: "No exposed Field of the Post Type (or the Globals) has this key.",
	fieldNotRelationship: "Only a Relationship Field's related items take fields of their own (`category.title`).",
	tooDeep: "Relationships are read one level deep.",
	tooMany: "More values than the parameter takes.",
	filterUnsupported: "The Field can't be filtered on this way (see the schema's `filters`).",
	valueInvalid: "The value isn't one the Field (or the filter) takes.",
	sortUnsupported: "The Field can't be sorted by (see the schema's `sortable`).",
	limitInvalid: "`limit` is a whole number from 1 to 100.",
	cursorInvalid: "The cursor isn't one this list gave, for this same query.",
	queryMissing: "`q` is the text to search for.",
	tooFar: "Search answers its first 1,000 hits.",
	pathInvalid: "`path` is a path on the Site, starting with `/`.",
	notForPages: "Pages are found by their path (`/entry?path=`), as their slugs repeat under different parents.",
} as const;

export type QueryProblemCode = keyof typeof CONTENT_API_QUERY_PROBLEMS;

export type QueryProblem = { parameter: string; problem: QueryProblemCode; message: string };

/** The formats a Body field is answered in. */
export const BODY_FORMATS = ["html", "blocks", "markdown"] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** How many items a list answers at a time: 20 unless `limit` asks for up to 100. */
export const CONTENT_API_PAGE = { default: 20, max: 100 } as const;

/** Parameter names a key might be sent under: refused, so a key never sits in a log. */
const KEY_PARAMETERS = new Set(["key", "access_token", "contentKey", "content_key", "apiKey", "api_key"]);

/** Whether a query string carries something named like a key (refused before anything else). */
export function carriesKey(params: URLSearchParams): boolean {
	return [...params.keys()].some((name) => KEY_PARAMETERS.has(name));
}

export class QueryParams {
	readonly problems: QueryProblem[] = [];
	private readonly params: URLSearchParams;

	constructor(params: URLSearchParams, takes: (name: string) => boolean) {
		this.params = params;
		const seen = new Set<string>();
		for (const name of params.keys()) {
			if (seen.has(name)) {
				if (!this.problems.some((problem) => problem.parameter === name && problem.problem === "parameterRepeated")) {
					this.add(name, "parameterRepeated", `Give ${name} once.`);
				}
				continue;
			}
			seen.add(name);
			if (!takes(name)) this.add(name, "parameterUnknown", `This path doesn't take ${name}.`);
		}
	}

	get(name: string): string | undefined {
		return this.params.get(name) ?? undefined;
	}

	/** The parameters whose names start with `prefix`, each once. */
	named(prefix: string): [string, string][] {
		const found = new Map<string, string>();
		for (const [name, value] of this.params) {
			if (name.startsWith(prefix) && !found.has(name)) found.set(name, value);
		}
		return [...found];
	}

	add(parameter: string, problem: QueryProblemCode, message: string): void {
		this.problems.push({ parameter, problem, message });
	}

	/** Refuses the request when any problem was found. */
	done(): void {
		if (this.problems.length === 0) return;
		throw new ContentApiError(
			"QUERY_INVALID",
			`The query can't be answered: ${this.problems.map((problem) => `${problem.parameter}: ${problem.message}`).join("; ")}`,
			{ problems: this.problems },
		);
	}
}

/** The language a request reads in and the chain it falls back through. */
export type Reading = { language: string; chain: LanguageChain };

/**
 * The language (`lang`: the hostname's language on a language's own domain, else the Default language,
 * unless given) and its fallbacks (`fallback`: languages in order, comma-separated; the Default
 * language unless given; `none`, or empty, for none). Values fall back one Field at a time (ADR 0003).
 */
export function readingOf(
	params: QueryParams,
	site: SiteLanguages,
	hostLanguage: string | null,
	fixed?: string,
): Reading {
	const codes = site.languages.map((language) => language.code);
	const known = (text: string, parameter: string): string | undefined => {
		const code = canonicalLanguage(text);
		const found = code && codes.find((candidate) => candidate.toLowerCase() === code.toLowerCase());
		if (!found) params.add(parameter, "languageUnknown", `The Site has no language ${text}.`);
		return found || undefined;
	};
	const asked = params.get("lang");
	const language =
		fixed ??
		(asked === undefined ? (hostLanguage ?? site.defaultLanguage) : (known(asked, "lang") ?? site.defaultLanguage));
	const fallback = params.get("fallback");
	let rest: string[] = [site.defaultLanguage];
	if (fallback !== undefined) {
		rest =
			fallback.trim() === "" || fallback.trim() === "none"
				? []
				: fallback
						.split(",")
						.slice(0, 20)
						.flatMap((text) => known(text.trim(), "fallback") ?? []);
	}
	const languages = [...new Set([language, ...rest])];
	return { language, chain: { languages, defaultLanguage: site.defaultLanguage } };
}

/** `body`: how a Body field is answered (`html` unless asked). */
export function bodyFormatOf(params: QueryParams): BodyFormat {
	const asked = params.get("body");
	if (asked === undefined) return "html";
	if ((BODY_FORMATS as readonly string[]).includes(asked)) return asked as BodyFormat;
	params.add("body", "bodyFormat", "Ask for html, blocks or markdown.");
	return "html";
}

/** `limit`: how many items a list answers (20 unless asked; up to 100). */
export function limitOf(params: QueryParams): number {
	const asked = params.get("limit");
	if (asked === undefined) return CONTENT_API_PAGE.default;
	const limit = /^\d{1,3}$/.test(asked) ? Number(asked) : Number.NaN;
	if (!(limit >= 1 && limit <= CONTENT_API_PAGE.max)) {
		params.add("limit", "limitInvalid", `Ask for 1 to ${CONTENT_API_PAGE.max} items.`);
		return CONTENT_API_PAGE.default;
	}
	return limit;
}
