import { entries, specialPages } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { entryValues } from "./entries.ts";
import { PageNotFoundError } from "./errors.ts";
import { siteLanguages } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import { isPagePostType } from "./pages.ts";
import { getPostType } from "./post-types.ts";
import { storedVersion } from "./values.ts";

/**
 * The Pages a Site gives a special job (Structure, chosen by Staff): the home page answers at `/`,
 * and the 404 page answers every path with no page, with status 404. Per-language 404 pages join
 * them with the Site's languages.
 */
export type SpecialPageRole = "home" | "notFound";

/** A chosen Page, named by its Draft title so a Page that isn't published yet can be chosen too. */
export type ChosenPage = { id: string; title: string };

export type SpecialPages = { homePage: ChosenPage | null; notFoundPage: ChosenPage | null };

/** Which Pages the scope's Site has chosen as its home page and its 404 page. */
export async function getSpecialPages(scope: SiteScope): Promise<SpecialPages> {
	const { defaultLanguage } = await siteLanguages(scope);
	const chosen = async (role: SpecialPageRole): Promise<ChosenPage | null> => {
		const row = await scope.first(specialPages, eq(specialPages.role, role));
		if (!row) return null;
		const page = await scope.first(entries, eq(entries.id, row.entryId));
		if (!page) return null;
		const languages = { language: defaultLanguage, defaultLanguage };
		return { id: page.id, title: entryValues(storedVersion(page.draft), [], languages).title };
	};
	return { homePage: await chosen("home"), notFoundPage: await chosen("notFound") };
}

/**
 * Gives a Page of the scope's Site a special job, or takes it away with null (open the Site with
 * `structure.edit`). It applies at once: the Site's page cache is cleared, and the change is recorded
 * in the Audit log (`homePage.change`, `notFoundPage.change`). Anything but a Page of the Site is
 * refused with `PageNotFoundError`.
 */
export async function setSpecialPage(
	scope: SiteScope,
	role: SpecialPageRole,
	pageId: string | null,
): Promise<SpecialPages> {
	return scope.transaction(async (tx) => {
		let title: string | null = null;
		if (pageId !== null) {
			const page = isUuid(pageId) ? await tx.first(entries, eq(entries.id, pageId)) : undefined;
			if (!page || !isPagePostType(await getPostType(tx, page.postTypeId))) throw new PageNotFoundError();
			const { defaultLanguage } = await siteLanguages(tx);
			title = entryValues(storedVersion(page.draft), [], { language: defaultLanguage, defaultLanguage }).title;
		}
		await tx.delete(specialPages, eq(specialPages.role, role));
		if (pageId !== null) await tx.insert(specialPages, { role, entryId: pageId });
		await clearPageCache(tx);
		await tx.audit(role === "home" ? "homePage.change" : "notFoundPage.change", {
			pageId,
			...(title === null ? {} : { title }),
		});
		return getSpecialPages(tx);
	});
}

/** The id of the Page with `role` on a Site, for its visitors, or undefined when it has none. */
export async function specialPageId(
	scope: Pick<VisitorScope, "first">,
	role: SpecialPageRole,
): Promise<string | undefined> {
	return (await scope.first(specialPages, eq(specialPages.role, role)))?.entryId;
}
