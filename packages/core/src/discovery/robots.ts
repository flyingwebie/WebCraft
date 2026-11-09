import { type AiCrawlerSetting, blockedAiCrawlers } from "./ai-crawlers.ts";

/**
 * robots.txt (spec story 119): what one of a Site's domains asks crawlers. WebCraft writes its own
 * groups first: the AI crawlers the Site's setting keeps out (`Disallow: /`), then every other crawler
 * let in (`User-agent: *`, `Allow: /`). Staff's own lines come next, each checked when they were
 * saved (`readRobotsLines`), and the sitemap of the domain last, on a line of its own that nothing
 * before it can change.
 */
export function robotsText(input: { aiCrawlers: AiCrawlerSetting; lines: string; sitemap: string }): string {
	const blocked = blockedAiCrawlers(input.aiCrawlers);
	const parts: string[] = [];
	if (blocked.length > 0) parts.push(`${blocked.map((agent) => `User-agent: ${agent}`).join("\n")}\nDisallow: /\n`);
	parts.push("User-agent: *\nAllow: /\n");
	if (input.lines.trim() !== "") parts.push(`${input.lines.trim()}\n`);
	parts.push(`Sitemap: ${input.sitemap}\n`);
	return parts.join("\n");
}

/**
 * The Staging address's robots.txt: every crawler kept out, whoever asks (its pages also say
 * `noindex`). It answers before the Staging address's access check, so crawlers read it.
 */
export const STAGING_ROBOTS = "User-agent: *\nDisallow: /\n";

/** Where a domain's robots.txt is. */
export const ROBOTS_PATH = "/robots.txt";
