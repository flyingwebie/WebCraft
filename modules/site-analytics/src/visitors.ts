/**
 * What the Module reads from a visitor's request besides what WebCraft tells it: whether it comes
 * from a program rather than a person (by its user agent), and the kind of device, browser and
 * operating system, in broad families only.
 */

/** User agents of programs: search engines, link previews, monitors, scripts and automated browsers. */
const BOT =
	/bot|crawl|spider|slurp|scrap|fetch|headless|lighthouse|pagespeed|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|whatsapp|telegram|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|httpclient|libwww|phantom|selenium|puppeteer|playwright|cypress/i;

/** Whether a request comes from a program rather than a person's browser (no user agent counts as one). */
export function isBot(userAgent: string | null): boolean {
	return !userAgent || userAgent.trim() === "" || BOT.test(userAgent);
}

/** The kind of device: by the user agent first, else by the window's width. */
export function deviceOf(userAgent: string, width: number | undefined): "desktop" | "mobile" | "tablet" {
	if (/ipad|tablet|kindle|silk|playbook/i.test(userAgent) || (/android/i.test(userAgent) && !/mobi/i.test(userAgent))) {
		return "tablet";
	}
	if (/mobi|iphone|ipod|android|windows phone/i.test(userAgent)) return "mobile";
	if (width !== undefined && width > 0 && width < 768) return "mobile";
	return "desktop";
}

/** The browser's family, newest look-alikes first (they all say "Safari" and most say "Chrome"). */
export function browserOf(userAgent: string): string {
	if (/edg(?:e|a|ios)?\//i.test(userAgent)) return "Edge";
	if (/opr\/|opera/i.test(userAgent)) return "Opera";
	if (/samsungbrowser/i.test(userAgent)) return "Samsung Internet";
	if (/firefox|fxios/i.test(userAgent)) return "Firefox";
	if (/chrome|crios|chromium/i.test(userAgent)) return "Chrome";
	if (/safari/i.test(userAgent)) return "Safari";
	return "Other";
}

/** The operating system's family. */
export function osOf(userAgent: string): string {
	if (/windows/i.test(userAgent)) return "Windows";
	if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
	if (/android/i.test(userAgent)) return "Android";
	if (/cros/i.test(userAgent)) return "ChromeOS";
	if (/mac os x|macintosh/i.test(userAgent)) return "macOS";
	if (/linux/i.test(userAgent)) return "Linux";
	return "Other";
}

/** A referring site's host as a source: lower case, without `www.`; empty when it isn't a host. */
export function sourceHost(referrer: string | null | undefined): string {
	const host = (referrer ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.includes(".")) return "";
	return host.replace(/^www\./, "");
}
