import { entries, specialPages } from "@webcraft/db/schema";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { entryValues } from "./entries.ts";
import { LanguageNotFoundError, PageNotFoundError } from "./errors.ts";
import { canonicalLanguage, siteLanguages } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import { isPagePostType } from "./pages.ts";
import { getPostType } from "./post-types.ts";
import { storedVersion } from "./values.ts";

/**
 * The Pages a Site gives a special job (Structure, chosen by Staff): the home page answers at `/`
 * (and at each language's prefix), and the 404 page answers every path with no page, with status
 * 404. A 404 page may also be chosen for one language: it answers there, and the Site's own answers
 * in the languages without one.
 */
export type SpecialPageRole = "home" | "notFound";

/** A chosen Page, named by its Draft title so a Page that isn't published yet can be chosen too. */
export type ChosenPage = { id: string; title: string };

export type SpecialPages = {
	homePage: ChosenPage | null;
	notFoundPage: ChosenPage | null;
	/** The 404 pages chosen for one language, by language code. */
	languageNotFoundPages: Record<string, ChosenPage>;
};

/** Which Pages the scope's Site has chosen as its home page and its 404 pages. */
export async function getSpecialPages(scope: SiteScope): Promise<SpecialPages> {
	const { defaultLanguage } = await siteLanguages(scope);
	const languages = { language: defaultLanguage, defaultLanguage };
	const chosen = async (entryId: string): Promise<ChosenPage | null> => {
		const page = await scope.first(entries, eq(entries.id, entryId));
		return page ? { id: page.id, title: entryValues(storedVersion(page.draft), [], languages).title } : null;
	};
	const rows = await scope.select(specialPages);
	const siteWide = (role: SpecialPageRole) => rows.find((row) => row.role === role && row.language === null);
	const home = siteWide("home");
	const notFound = siteWide("notFound");
	const languageNotFoundPages: Record<string, ChosenPage> = {};
	for (const row of rows) {
		if (row.role !== "notFound" || row.language === null) continue;
		const page = await chosen(row.entryId);
		if (page) languageNotFoundPages[row.language] = page;
	}
	return {
		homePage: home ? await chosen(home.entryId) : null,
		notFoundPage: notFound ? await chosen(notFound.entryId) : null,
		languageNotFoundPages,
	};
}

/**
 * Gives a Page of the scope's Site a special job, or takes it away with null (open the Site with
 * `structure.edit`); a 404 page may be given its job in one `language`. It applies at once: the
 * Site's page cache is cleared, and the change is recorded in the Audit log (`homePage.change`,
 * `notFoundPage.change`). Anything but a Page of the Site is refused with `PageNotFoundError`, a
 * language the Site doesn't have with `LanguageNotFoundError`.
 */
export async function setSpecialPage(
	scope: SiteScope,
	role: SpecialPageRole,
	pageId: string | null,
	language?: string,
): Promise<SpecialPages> {
	return scope.transaction(async (tx) => {
		const site = await siteLanguages(tx);
		const code =
			language === undefined
				? null
				: (site.languages.find((candidate) => candidate.code === canonicalLanguage(language))?.code ?? null);
		if (language !== undefined && code === null) throw new LanguageNotFoundError();
		let title: string | null = null;
		if (pageId !== null) {
			const page = isUuid(pageId) ? await tx.first(entries, eq(entries.id, pageId)) : undefined;
			if (!page || !isPagePostType(await getPostType(tx, page.postTypeId))) throw new PageNotFoundError();
			const languages = { language: code ?? site.defaultLanguage, defaultLanguage: site.defaultLanguage };
			title = entryValues(storedVersion(page.draft), [], languages).title;
		}
		const where = and(
			eq(specialPages.role, role),
			code === null ? isNull(specialPages.language) : eq(specialPages.language, code),
		);
		await tx.delete(specialPages, where);
		if (pageId !== null) await tx.insert(specialPages, { role, language: code, entryId: pageId });
		await clearPageCache(tx);
		await tx.audit(role === "home" ? "homePage.change" : "notFoundPage.change", {
			pageId,
			...(title === null ? {} : { title }),
			...(code === null ? {} : { language: code }),
		});
		return getSpecialPages(tx);
	});
}

/**
 * The id of the Page with `role` on a Site, for its visitors, or undefined when it has none. With a
 * language, the Page chosen for that language comes first.
 */
export async function specialPageId(
	scope: Pick<VisitorScope, "first">,
	role: SpecialPageRole,
	language?: string,
): Promise<string | undefined> {
	if (language !== undefined) {
		const own = await scope.first(
			specialPages,
			and(eq(specialPages.role, role), isNotNull(specialPages.language), eq(specialPages.language, language)),
		);
		if (own) return own.entryId;
	}
	return (await scope.first(specialPages, and(eq(specialPages.role, role), isNull(specialPages.language))))?.entryId;
}
