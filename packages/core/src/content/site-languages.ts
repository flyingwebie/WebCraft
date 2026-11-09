import { siteLanguages as siteLanguageRows } from "@webcraft/db/schema";
import { directionOf } from "@webcraft/renderer";
import { eq, max } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { normaliseHostname } from "../hostnames.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ContentProblem, LanguageInvalidError, LanguageNotFoundError, LanguageTakenError } from "./errors.ts";
import { canonicalLanguage, languageName, type SiteLanguages, siteLanguages, type TextDirection } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import { lockSitePaths } from "./pages.ts";

/**
 * Changing a Site's languages (Structure: open the Site with `structure.edit`). Like every Site
 * setting, a change applies at once (no Draft), clears the Site's page cache and is recorded in the
 * Audit log. Changes that add or move the paths a Site answers take the Site's paths first.
 */

/** A new language: its BCP 47 code, and optionally its name, direction and a domain of its own. */
export type NewLanguage = { code: string; name?: string; direction?: TextDirection; domain?: string | null };

/** A change to a language's settings; only those given change. */
export type LanguageChange = { name?: string; direction?: TextDirection; domain?: string | null };

/** The longest language name, in characters. */
export const LANGUAGE_NAME_MAX_LENGTH = 100;

/** What checking a language's settings needs from the Install: hostnames that are never a language's domain. */
export type LanguageDeps = { config: Pick<InstallConfig, "adminHost" | "sitesDomain"> };

/**
 * Adds a language to the scope's Site. The code is a BCP 47 tag, kept in its canonical form; the name
 * is the language's own name unless given, the direction follows from the code unless given. Refuses
 * a tag WebCraft doesn't keep (`LanguageInvalidError`), and a language the Site has or a domain another
 * language has (`LanguageTakenError`).
 */
export async function addLanguage(deps: LanguageDeps, scope: SiteScope, input: NewLanguage): Promise<SiteLanguages> {
	const problems: ContentProblem[] = [];
	const code = canonicalLanguage(input.code);
	if (!code) {
		problems.push({
			at: "code",
			message:
				"A language is a BCP 47 tag: a language, then an optional script and region, such as fr, pt-BR or zh-Hant.",
		});
	}
	const name = input.name === undefined ? (code ? languageName(code) : "") : checkName(input.name, problems);
	const domain = input.domain == null ? null : checkDomain(deps, input.domain, problems);
	if (problems.length > 0 || !code) throw new LanguageInvalidError(problems);
	return saving(() =>
		scope.transaction(async (tx) => {
			// A new prefix is a new set of paths the Site answers.
			await lockSitePaths(tx);
			const current = await siteLanguages(tx);
			if (current.languages.some((language) => language.code === code)) throw new LanguageTakenError("code");
			const [last] = await tx.db
				.select({ position: max(siteLanguageRows.position) })
				.from(siteLanguageRows)
				.where(tx.where(siteLanguageRows));
			const direction = input.direction ?? directionOf(code);
			await tx.insert(siteLanguageRows, {
				code,
				name,
				direction,
				domain,
				position: (last?.position ?? 0) + 1,
				createdAt: tx.now(),
			});
			await clearPageCache(tx);
			await tx.audit("language.add", { code, name, direction, domain });
			return siteLanguages(tx);
		}),
	);
}

/** Changes a language's name, direction or domain. */
export async function updateLanguage(
	deps: LanguageDeps,
	scope: SiteScope,
	code: string,
	change: LanguageChange,
): Promise<SiteLanguages> {
	const problems: ContentProblem[] = [];
	const name = change.name === undefined ? undefined : checkName(change.name, problems);
	const domain =
		change.domain === undefined
			? undefined
			: change.domain === null
				? null
				: checkDomain(deps, change.domain, problems);
	if (problems.length > 0) throw new LanguageInvalidError(problems);
	return saving(() =>
		scope.transaction(async (tx) => {
			const current = await siteLanguages(tx);
			const language = current.languages.find((candidate) => candidate.code === canonicalLanguage(code));
			if (!language) throw new LanguageNotFoundError();
			const next = {
				name: name ?? language.name,
				direction: change.direction ?? language.direction,
				domain: domain === undefined ? language.domain : domain,
			};
			const changed = (["name", "direction", "domain"] as const).filter((key) => next[key] !== language[key]);
			if (changed.length === 0) return current;
			const where = eq(siteLanguageRows.code, language.code);
			const [updated] = await tx.update(siteLanguageRows, next, where);
			if (!updated) {
				// The Default language of a Site made by an earlier version may have no row yet.
				await tx.insert(siteLanguageRows, { code: language.code, ...next, position: 0, createdAt: tx.now() });
			}
			await clearPageCache(tx);
			await tx.audit("language.update", { code: language.code, changed });
			return siteLanguages(tx);
		}),
	);
}

function checkName(input: string, problems: ContentProblem[]): string {
	const name = input.trim();
	if (!name || name.length > LANGUAGE_NAME_MAX_LENGTH) {
		problems.push({ at: "name", message: `A language's name has 1 to ${LANGUAGE_NAME_MAX_LENGTH} characters.` });
	}
	return name;
}

/** A domain name: labels of letters, digits and dashes, at least two of them. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A language's own domain, in lower case. Never the admin's hostname, nor a name under the sites
 * domain, where Staging addresses are.
 */
function checkDomain(deps: LanguageDeps, input: string, problems: ContentProblem[]): string {
	const domain = normaliseHostname(input);
	const { adminHost, sitesDomain } = deps.config;
	if (!DOMAIN.test(domain)) {
		problems.push({ at: "domain", message: "A domain is a name such as bakery.fr or fr.bakery.com." });
	} else if (domain === adminHost || (sitesDomain && (domain === sitesDomain || domain.endsWith(`.${sitesDomain}`)))) {
		problems.push({ at: "domain", message: "This domain is the Install's own: choose another one." });
	}
	return domain;
}

/** Runs a save, turning a domain another language has into `LanguageTakenError`. */
async function saving<Result>(save: () => Promise<Result>): Promise<Result> {
	try {
		return await save();
	} catch (error) {
		if (isUniqueViolation(error, "site_languages_domain_unique")) throw new LanguageTakenError("domain");
		if (isUniqueViolation(error, "site_languages_pkey")) throw new LanguageTakenError("code");
		throw error;
	}
}
