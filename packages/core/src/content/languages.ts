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
