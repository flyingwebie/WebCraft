import { siteLanguages as siteLanguageRows, sites } from "@webcraft/db/schema";
import { directionOf } from "@webcraft/renderer";
import { asc, eq } from "drizzle-orm";

import type { SiteScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import type { Languages } from "./field-values.ts";

/**
 * A Site's languages (ADR 0010): the Default language, written first and unprefixed in URLs, and the
 * others, each prefixed with its code in lower case (`/fr/…`). Values are stored per Field and per
 * language (ADR 0003); every reader and writer of them gets its language from here.
 */

export type TextDirection = "ltr" | "rtl";

/** One of a Site's languages, as the API shows it. */
export type SiteLanguage = {
	/** The BCP 47 tag in its canonical form: `en`, `pt-BR`. */
	code: string;
	/** Its name as visitors read it, usually in the language itself: `Français`. */
	name: string;
	direction: TextDirection;
	/** A domain of its own, which the Site answers on in this language once domains are verified (#82). */
	domain: string | null;
	/** The first part of its URLs (`fr` for `/fr/…`); null for the Default language, which has none. */
	prefix: string | null;
	/** Whether it is the Site's Default language. */
	default: boolean;
};

/** A Site's language settings: its languages (the Default language first) and the browser-language redirect. */
export type SiteLanguages = {
	defaultLanguage: string;
	/** Whether a visitor's first request to the home page goes on to the home page in their browser's language. */
	browserLanguageRedirect: boolean;
	languages: SiteLanguage[];
};

/** The scope's Site's languages, the Default language first, then in the order Staff added them. */
export async function siteLanguages(scope: Pick<SiteScope, "db" | "site">): Promise<SiteLanguages> {
	const [site] = await scope.db
		.select({ defaultLanguage: sites.defaultLanguage, browserLanguageRedirect: sites.browserLanguageRedirect })
		.from(sites)
		.where(eq(sites.id, scope.site.id));
	const defaultLanguage = site?.defaultLanguage ?? "en";
	const rows = await scope.db
		.select()
		.from(siteLanguageRows)
		.where(eq(siteLanguageRows.siteId, scope.site.id))
		.orderBy(asc(siteLanguageRows.position), asc(siteLanguageRows.code));
	const languages = rows.map((row) =>
		toSiteLanguage(row.code, row.name, row.direction, row.domain, row.code === defaultLanguage),
	);
	// A Site made by an earlier version may have no row for its Default language yet.
	const ownDefault = languages.find((language) => language.default) ?? {
		...toSiteLanguage(defaultLanguage, languageName(defaultLanguage), directionOf(defaultLanguage), null, true),
	};
	return {
		defaultLanguage,
		browserLanguageRedirect: site?.browserLanguageRedirect ?? false,
		languages: [ownDefault, ...languages.filter((language) => !language.default)],
	};
}

function toSiteLanguage(
	code: string,
	name: string,
	direction: string,
	domain: string | null,
	isDefault: boolean,
): SiteLanguage {
	return {
		code,
		name,
		direction: direction === "rtl" ? "rtl" : "ltr",
		domain,
		prefix: isDefault ? null : prefixOf(code),
		default: isDefault,
	};
}

/** The first part of a language's URLs: its code in lower case (`pt-BR` gives `pt-br`). */
export function prefixOf(code: string): string {
	return code.toLowerCase();
}

/** A language's name in the language itself, starting with a capital: `fr` gives `Français`. */
export function languageName(code: string): string {
	try {
		const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
		return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
	} catch {
		// A code the runtime can't name keeps its code as its name.
		return code;
	}
}

/** A language tag WebCraft keeps: a language, with an optional script and region (`zh-Hant`, `pt-BR`, `es-419`). */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** A BCP 47 tag in its canonical form (`PT-br` gives `pt-BR`), or undefined when it isn't one WebCraft keeps. */
export function canonicalLanguage(input: string): string | undefined {
	let canonical: string | undefined;
	try {
		[canonical] = Intl.getCanonicalLocales(input.trim());
	} catch {
		return undefined;
	}
	return canonical && LANGUAGE_TAG.test(canonical) ? canonical : undefined;
}

/**
 * The Site language `language` names (the Default language when absent), with the Default language
 * values fall back to; undefined when the Site has no such language.
 */
export function languagesFor(site: SiteLanguages, language?: string): Languages | undefined {
	const code = language === undefined ? site.defaultLanguage : canonicalLanguage(language);
	const found = site.languages.find((candidate) => candidate.code === code);
	return found && { language: found.code, defaultLanguage: site.defaultLanguage };
}

/** Gives a new Site of the scope's Workspace its Default language, inside its transaction. */
export async function addDefaultLanguage(scope: WorkspaceScope, siteId: string, code: string): Promise<void> {
	await scope.insert(siteLanguageRows, {
		siteId,
		code,
		name: languageName(code),
		direction: directionOf(code),
		position: 0,
		createdAt: scope.now(),
	});
}
