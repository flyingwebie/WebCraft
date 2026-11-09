import { type AiCrawlerSetting, blockedAiCrawlers, isAiCrawler } from "./ai-crawlers.ts";

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

/** The most Staff's own robots.txt lines may hold: characters and lines. */
export const ROBOTS_LINES_MAX = { characters: 5_000, lines: 200 } as const;

/** A problem with Staff's robots.txt lines: what it is, and on which line (from 1). */
export type RobotsLinesProblem = {
	rule: "robotsLine" | "robotsRuleWithoutAgent" | "robotsAiCrawler" | "robotsLinesLength";
	message: string;
	params: Record<string, number>;
};

/** A user-agent token, as robots.txt names crawlers: `Googlebot`, `*`. */
const AGENT = /^[A-Za-z0-9*._/-]{1,100}$/;

/** A path rule's value: empty (nothing), or a path pattern starting with `/` or `*`, without spaces. */
const PATH_RULE = /^(?:[/*][^\s#]{0,499})?$/;

/**
 * Reads Staff's own robots.txt lines (spec story 119): line breaks as `\n`, each line trimmed, blank
 * lines at either end dropped. Each line is blank, a comment (`# …`), or one of `User-agent`, `Allow`,
 * `Disallow`, `Crawl-delay` and `Sitemap` (an absolute http(s) address) with a value of its kind (a
 * trailing comment allowed), and a rule follows a `User-agent` line, since WebCraft's own groups come
 * before. A group may not name one of the AI crawlers: the AI crawler setting decides those. No line
 * can reach the sitemap line WebCraft writes after them. Answers the lines, or the first problem.
 */
export function readRobotsLines(input: string): { lines: string } | { problem: RobotsLinesProblem } {
	const lines = input
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim());
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	const text = lines.join("\n");
	if (text.length > ROBOTS_LINES_MAX.characters || lines.length > ROBOTS_LINES_MAX.lines) {
		return {
			problem: {
				rule: "robotsLinesLength",
				message: `At most ${ROBOTS_LINES_MAX.lines} lines and ${ROBOTS_LINES_MAX.characters} characters.`,
				params: { ...ROBOTS_LINES_MAX },
			},
		};
	}
	let agent = false;
	for (const [index, line] of lines.entries()) {
		const at = { line: index + 1 };
		const wrong = (rule: RobotsLinesProblem["rule"], message: string) => ({ problem: { rule, message, params: at } });
		if (line === "" || line.startsWith("#")) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
			if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(line))
				return wrong("robotsLine", "A line has no control characters.");
			continue;
		}
		const match = /^([A-Za-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
		const field = match?.[1]?.toLowerCase();
		const value = match?.[2] ?? "";
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
		const clean = !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(line);
		if (field === "user-agent") {
			agent = true;
			if (!clean || !AGENT.test(value))
				return wrong("robotsLine", "User-agent names one crawler, such as Googlebot or *.");
			if (isAiCrawler(value)) {
				return wrong("robotsAiCrawler", "The AI crawler setting decides what AI crawlers may read.");
			}
			continue;
		}
		if (field === "allow" || field === "disallow" || field === "crawl-delay") {
			if (!agent) return wrong("robotsRuleWithoutAgent", "A rule follows the User-agent line it is for.");
			const fits = field === "crawl-delay" ? /^\d{1,3}(?:\.\d{1,3})?$/.test(value) : PATH_RULE.test(value);
			if (!clean || !fits) {
				return wrong(
					"robotsLine",
					"Allow and Disallow take a path starting with / or *; Crawl-delay a number of seconds.",
				);
			}
			continue;
		}
		if (field === "sitemap") {
			if (!clean || !isAddress(value)) return wrong("robotsLine", "Sitemap takes an absolute http or https address.");
			continue;
		}
		return wrong("robotsLine", "A line is User-agent, Allow, Disallow, Crawl-delay, Sitemap or a # comment.");
	}
	return { lines: text };
}

function isAddress(text: string): boolean {
	if (text.length > 2_000 || /\s/.test(text)) return false;
	try {
		const url = new URL(text);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
	} catch {
		return false;
	}
}
