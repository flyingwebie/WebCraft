/**
 * SEO (the SEO decision, GLOSSARY.md: SEO fields, Social card, Schema type): every page carries good
 * metadata out of the box. Entries keep their SEO fields in their Drafts (`entry-seo.ts`); each Post
 * Type sets what they fall back to and its Schema type (`seo-rules.ts`, which the admin reads too);
 * each Site sets its own SEO settings (`site-settings.ts`); pages work out what they tell search
 * engines and other sites (`page-seo.ts`) for the renderer to write.
 */

import type { AiCrawlerSetting } from "../discovery/ai-crawlers.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	type SiteSeoChange,
	type SiteSeoSettings,
	setAiCrawlers,
	siteSeoSettings,
	updateSiteSeoSettings,
} from "./site-settings.ts";

export { type EntrySeo, type EntrySeoChange, SEO_KEY } from "./entry-seo.ts";
export * from "./seo-rules.ts";
export {
	ORGANIZATION_GLOBALS,
	ORGANIZATION_KINDS,
	type OrganizationKind,
	SAME_AS_MAX,
	SEO_NAME_MAX_LENGTH,
	type SeoOrganization,
	SeoSettingsInvalidError,
	type SiteSeoChange,
	type SiteSeoSettings,
} from "./site-settings.ts";

/**
 * A Site's SEO settings: everyone who sees the Site reads them; Staff change them (`structure.edit`),
 * and Staff and Owners the AI crawler setting (`aiCrawlers.manage`).
 */
export type SeoService = {
	settings(scope: SiteScope): Promise<SiteSeoSettings>;
	updateSettings(scope: SiteScope, change: SiteSeoChange): Promise<SiteSeoSettings>;
	setAiCrawlers(scope: SiteScope, setting: AiCrawlerSetting): Promise<SiteSeoSettings>;
};

export function createSeo(): SeoService {
	return { settings: siteSeoSettings, updateSettings: updateSiteSeoSettings, setAiCrawlers };
}
