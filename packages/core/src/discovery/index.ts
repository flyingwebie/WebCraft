/**
 * Discovery files (spec stories 112, 117, 118, 119): what a Site tells search engines and AI engines
 * about itself, on each of its domains. All of them are built on request from what is published, and
 * the Site pipeline keeps them in the page cache, so a publish or a change to a setting shows at once.
 *
 * - robots.txt (`robots.ts`): the AI crawler setting (`ai-crawlers.ts`), Staff's own lines and the
 *   domain's sitemap.
 * - Sitemaps (`sitemaps.ts`): an index of one sitemap per Post Type, split into parts past the
 *   protocol's limits.
 *
 * What they list is one rule (`listed.ts`). The Staging address never offers any of them (its
 * robots.txt keeps every crawler out): it shows Drafts to the people reviewing a Site, never to
 * search engines.
 */
import type { SiteHost } from "../site-pages/index.ts";
import type { DataLayer } from "../tenancy/data-layer.ts";
import { DEFAULT_AI_CRAWLER_SETTING } from "./ai-crawlers.ts";
import { type Listing, listing } from "./listed.ts";
import { robotsText } from "./robots.ts";
import { createPartStarts, SITEMAP_PATH, type SitemapLimits, sitemapIndex, sitemapPart } from "./sitemaps.ts";

export {
	AI_CRAWLER_SETTINGS,
	AI_CRAWLERS,
	type AiCrawlerPurpose,
	type AiCrawlerSetting,
	blockedAiCrawlers,
	DEFAULT_AI_CRAWLER_SETTING,
	isAiCrawler,
	isAiCrawlerSetting,
} from "./ai-crawlers.ts";
export { ROBOTS_PATH, STAGING_ROBOTS } from "./robots.ts";
export { SITEMAP_LIMITS, SITEMAP_PATH, SITEMAPS_FOLDER, type SitemapLimits } from "./sitemaps.ts";

/** A Site's discovery files on one of its domains, for the Site pipeline (see the module's comment). */
export type Discovery = {
	/** The robots.txt of one of the Site's domains. */
	robots(host: SiteHost): Promise<string>;
	/** The domain's sitemap index (`/sitemap.xml`). */
	sitemapIndex(host: SiteHost, limits: SitemapLimits): Promise<string>;
	/** One part of a Post Type's sitemap by its file name (`blog-1.xml`); null when there is none. */
	sitemap(host: SiteHost, name: string, limits: SitemapLimits): Promise<string | null>;
};

export function createDiscovery(options: { data: DataLayer }): Discovery {
	const { data } = options;
	const starts = createPartStarts();
	const listingOf = (host: SiteHost): Promise<Listing> =>
		listing(data.visitors(host.site), host, async () => new Set());
	return {
		async robots(host) {
			return robotsText({
				aiCrawlers: DEFAULT_AI_CRAWLER_SETTING,
				lines: "",
				sitemap: `${host.origin}${SITEMAP_PATH}`,
			});
		},
		async sitemapIndex(host, limits) {
			return sitemapIndex(await listingOf(host), starts, limits);
		},
		async sitemap(host, name, limits) {
			return sitemapPart(await listingOf(host), starts, limits, name);
		},
	};
}
