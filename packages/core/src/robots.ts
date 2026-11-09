/** User agents of crawlers, link previewers, monitors and other robots. */
const ROBOTS =
	/bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|pinterest|vkshare|whatsapp|telegram|discord|slack|lighthouse|headless|validator|monitor|uptime|scan|^curl|^wget|python|^java\/|^go-http|^okhttp|^axios|^node/i;

/**
 * Whether a request's user agent says it is a robot rather than a person's browser: a crawler, a link
 * previewer, a monitor, a command-line client, or one that sends no user agent at all. Visitors'
 * features that only make sense for people (the browser-language redirect, the 404 log) leave robots out.
 */
export function isRobot(userAgent: string | null): boolean {
	return !userAgent || ROBOTS.test(userAgent);
}
