import { sites } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";

/** The languages of the scope's Site. Only the Default language exists until Sites get more. */
export async function siteLanguages(scope: Pick<SiteScope, "db" | "site">): Promise<{ defaultLanguage: string }> {
	const [row] = await scope.db
		.select({ defaultLanguage: sites.defaultLanguage })
		.from(sites)
		.where(eq(sites.id, scope.site.id));
	return { defaultLanguage: row?.defaultLanguage ?? "en" };
}

/**
 * The languages Content is written in on the scope's Site, as the admin shows them: the Default
 * language, and every language in order with the Default language first. Sites have one language
 * until the Site's languages (#80) add more here.
 */
export async function languagesOf(scope: Pick<SiteScope, "db" | "site">): Promise<{ default: string; all: string[] }> {
	const { defaultLanguage } = await siteLanguages(scope);
	return { default: defaultLanguage, all: [defaultLanguage] };
}
