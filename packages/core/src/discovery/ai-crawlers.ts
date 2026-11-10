// The admin reads this file in the browser (`@webcraft/core/ai-crawlers`): it imports nothing.

/**
 * The AI crawlers a Site's robots.txt names (spec story 119), in one place. Each is the user-agent
 * token its operator publishes for robots.txt, and what it reads pages for:
 *
 * - `training`: collecting pages to train AI models. "Allow search but block training" and "Block
 *   all" keep these out.
 * - `search`: AI search and answer engines reading pages to show them, with a link, when people ask
 *   (indexing for answers, or fetching a page a person asked about). Only "Block all" keeps these out.
 *
 * Ordinary search engines (their crawlers for search results) aren't listed: the setting is about AI,
 * and `User-agent: *` stays open to them whatever it says.
 *
 * Keeping the list up to date: operators publish their tokens in their crawler documentation and add
 * new ones from time to time. Check the list before each release against those pages; add a new
 * token with its purpose, keep a retired one for a year (sites may still be visited under it), and
 * never move a token between purposes without saying so in the release notes, since it changes what
 * Sites' robots.txt files allow. `tests/discovery/robots.test.ts` checks that every token is listed
 * once with a purpose, and that each setting writes the tokens it should. Every Site's robots.txt
 * follows a change at once, since robots.txt is built on request.
 */
export const AI_CRAWLERS = [
	// Training: collecting pages for models.
	{ agent: "GPTBot", purpose: "training" },
	{ agent: "ClaudeBot", purpose: "training" },
	{ agent: "anthropic-ai", purpose: "training" },
	{ agent: "Google-Extended", purpose: "training" },
	{ agent: "Applebot-Extended", purpose: "training" },
	{ agent: "CCBot", purpose: "training" },
	{ agent: "Bytespider", purpose: "training" },
	{ agent: "meta-externalagent", purpose: "training" },
	{ agent: "FacebookBot", purpose: "training" },
	{ agent: "Amazonbot", purpose: "training" },
	{ agent: "cohere-training-data-crawler", purpose: "training" },
	{ agent: "AI2Bot", purpose: "training" },
	{ agent: "Diffbot", purpose: "training" },
	{ agent: "omgili", purpose: "training" },
	// Search: AI search and answer engines, and fetches a person asked for.
	{ agent: "OAI-SearchBot", purpose: "search" },
	{ agent: "ChatGPT-User", purpose: "search" },
	{ agent: "Claude-SearchBot", purpose: "search" },
	{ agent: "Claude-User", purpose: "search" },
	{ agent: "PerplexityBot", purpose: "search" },
	{ agent: "Perplexity-User", purpose: "search" },
	{ agent: "DuckAssistBot", purpose: "search" },
	{ agent: "meta-externalfetcher", purpose: "search" },
	{ agent: "MistralAI-User", purpose: "search" },
] as const satisfies readonly { agent: string; purpose: AiCrawlerPurpose }[];

export type AiCrawlerPurpose = "training" | "search";

/**
 * The AI crawler setting, one per Site (spec story 119): let every AI crawler read the Site, let AI
 * search read it but keep training out, or keep every AI crawler out. Ordinary search engines are
 * never affected.
 */
export const AI_CRAWLER_SETTINGS = ["allowAll", "allowSearch", "blockAll"] as const;
export type AiCrawlerSetting = (typeof AI_CRAWLER_SETTINGS)[number];

/** Every Site's setting until someone changes it: robots.txt lets every crawler in, as before. */
export const DEFAULT_AI_CRAWLER_SETTING: AiCrawlerSetting = "allowAll";

export function isAiCrawlerSetting(value: unknown): value is AiCrawlerSetting {
	return typeof value === "string" && (AI_CRAWLER_SETTINGS as readonly string[]).includes(value);
}

/** The AI crawlers a setting keeps out of the Site, by user-agent token, in the list's order. */
export function blockedAiCrawlers(setting: AiCrawlerSetting): string[] {
	if (setting === "allowAll") return [];
	return AI_CRAWLERS.filter((crawler) => setting === "blockAll" || crawler.purpose === "training").map(
		(crawler) => crawler.agent,
	);
}

/** Whether a user-agent token is one of the AI crawlers the setting decides about (compared without case). */
export function isAiCrawler(agent: string): boolean {
	const name = agent.trim().toLowerCase();
	return AI_CRAWLERS.some((crawler) => crawler.agent.toLowerCase() === name);
}
