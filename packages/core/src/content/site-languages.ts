import { entries, globals, siteLanguages as siteLanguageRows, sites } from "@webcraft/db/schema";
import { directionOf } from "@webcraft/renderer";
import { and, eq, isNotNull, max } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { normaliseHostname } from "../hostnames.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { publishedAddresses } from "./entry-paths.ts";
import { type ContentProblem, LanguageInvalidError, LanguageNotFoundError, LanguageTakenError } from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import { moveLanguage, moveSharedValues } from "./field-values.ts";
import { storedFields } from "./fields.ts";
import { checkPrefixFree, publishSlugsIn } from "./language-paths.ts";
import {
	canonicalLanguage,
	languageName,
	prefixOf,
	type SiteLanguages,
	siteLanguages,
	type TextDirection,
} from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import { lockSitePaths } from "./pages.ts";
import { listPostTypes } from "./post-types.ts";
import type { PathChange } from "./publishing.ts";
import { type EntryVersion, ownValue, storedVersion } from "./values.ts";

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
			await checkPrefixFree(tx, prefixOf(code));
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
			await publishSlugsIn(tx, code, current.defaultLanguage);
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

/**
 * Turns the Site's browser-language redirect on or off: when on, a visitor's first request to the
 * home page goes on to the home page in the language their browser prefers (ADR 0010).
 */
export async function setBrowserLanguageRedirect(scope: SiteScope, on: boolean): Promise<SiteLanguages> {
	return scope.transaction(async (tx) => {
		await tx.db
			.update(sites)
			.set({ browserLanguageRedirect: on })
			.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)));
		await clearPageCache(tx);
		await tx.audit("browserLanguageRedirect.change", { on });
		return siteLanguages(tx);
	});
}

/** What changing the Default language would do, shown before it is confirmed. */
export type DefaultLanguagePreview = {
	from: string;
	to: string;
	/** How many published addresses change: every published page in both languages. */
	changedPaths: number;
	/**
	 * How many Entries have no title of their own in the new Default language: with nothing to fall
	 * back to, they show none there until one is written.
	 */
	withoutOwnTitle: number;
};

/** Changing the Default language: before it is confirmed, what it would do; after, what it did. */
export type DefaultLanguageChange =
	| { changed: false; preview: DefaultLanguagePreview; confirmation: Confirmation }
	| { changed: true; settings: SiteLanguages; pathChanges: PathChange[] };

/**
 * Makes another of the Site's languages its Default language, in two steps: without a confirmation
 * it changes nothing and answers what would change (the addresses, the Entries without a title of
 * their own there) with a confirmation id; with it, it goes ahead. The new Default language loses its
 * prefix and the old one gets one; shared values move to the new Default language, where they are
 * kept, so they keep their value; Translatable fields now fall back to the new Default language.
 * Every published address that changes is answered and logged as `pathChanges` (Redirect rules
 * follow them); the new Default language's old addresses, under its old prefix, go on to the new
 * ones. Refuses a language the Site doesn't have (`LanguageNotFoundError`), the current Default
 * language (`LanguageInvalidError`), and a change that would put a prefix where an unprefixed page
 * of the new Default language is (`PathTakenError`).
 */
export async function setDefaultLanguage(
	scope: SiteScope,
	code: string,
	confirmation?: string,
): Promise<DefaultLanguageChange> {
	return scope.transaction(async (tx) => {
		// Every prefix and unprefixed path moves: hold the Site's paths first.
		await lockSitePaths(tx);
		const current = await siteLanguages(tx);
		const target = current.languages.find((language) => language.code === canonicalLanguage(code));
		if (!target) throw new LanguageNotFoundError();
		const from = current.defaultLanguage;
		const to = target.code;
		if (to === from)
			throw new LanguageInvalidError([{ at: "code", message: `${to} is already the Default language.` }]);
		// The new Default language's paths become unprefixed: no other language's prefix may start one.
		for (const language of current.languages) {
			if (language.code !== to) await checkPrefixFree(tx, prefixOf(language.code), to);
		}
		const pathChanges = await defaultLanguagePathChanges(tx, from, to);
		const rows = await tx.db.select().from(entries).where(tx.where(entries)).for("update");
		const request = {
			action: "defaultLanguage.change",
			target: to,
			preview: {
				from,
				to,
				changedPaths: pathChanges.length,
				withoutOwnTitle: rows.filter((row) => !ownValue(storedVersion(row.draft), "title", to)).length,
			},
		};
		if (confirmation === undefined) {
			return { changed: false, preview: request.preview, confirmation: await askConfirmation(tx, request) };
		}
		await useConfirmation(tx, confirmation, request);

		const fieldsOf = new Map((await listPostTypes(tx)).map((postType) => [postType.id, postType.fields]));
		const move = (version: unknown, fields: readonly FieldDefinition[]): EntryVersion => {
			const values = moveSharedValues(storedVersion(version).values, fields, from, to);
			for (const key of SHARED_BUILT_INS) {
				if (values[key] !== undefined) values[key] = moveLanguage(values[key], from, to);
			}
			return { values };
		};
		for (const row of rows) {
			const fields = fieldsOf.get(row.postTypeId) ?? [];
			await tx.update(
				entries,
				{ draft: move(row.draft, fields), published: row.published === null ? null : move(row.published, fields) },
				eq(entries.id, row.id),
			);
		}
		const [globalsRow] = await tx.db.select().from(globals).where(tx.where(globals)).for("update");
		if (globalsRow) {
			const fields = storedFields(globalsRow.fields);
			await tx.update(
				globals,
				{
					draft: move(globalsRow.draft, fields),
					published: globalsRow.published === null ? null : move(globalsRow.published, fields),
				},
				eq(globals.id, globalsRow.id),
			);
		}
		await tx.db
			.update(sites)
			.set({ defaultLanguage: to })
			.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)));
		await clearPageCache(tx);
		await tx.audit("defaultLanguage.change", { from, to, changedPaths: pathChanges.length });
		return { changed: true, settings: await siteLanguages(tx), pathChanges };
	});
}

/** Built-in values every language shares, kept under the Default language beside `title` and `slug`. */
const SHARED_BUILT_INS = ["parent", "hiddenLanguages"] as const;

/**
 * Every published address that changes when the Default language goes from `from` to `to`: each
 * published Entry's in both languages (the old Default language gets its prefix, the new one loses
 * its own). Other languages keep theirs.
 */
async function defaultLanguagePathChanges(scope: SiteScope, from: string, to: string): Promise<PathChange[]> {
	const changes: PathChange[] = [];
	const published = await scope.select(entries, isNotNull(entries.published));
	for (const postType of await listPostTypes(scope)) {
		const ids = published.filter((row) => row.postTypeId === postType.id).map((row) => row.id);
		for (const language of [from, to]) {
			const before = await publishedAddresses(scope, postType, ids, { language, defaultLanguage: from });
			const after = await publishedAddresses(scope, postType, ids, { language, defaultLanguage: to });
			for (const [entryId, address] of before) {
				const next = after.get(entryId);
				if (next && next.path !== address.path) changes.push({ entryId, language, from: address.path, to: next.path });
			}
		}
	}
	return changes;
}
