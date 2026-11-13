/**
 * Video Blocks come from a fixed list of providers: YouTube and Vimeo. WebCraft writes the player
 * itself, from the video's id, and nothing is loaded from the provider until the visitor clicks to
 * play: the page links to the video's own page, and WebCraft's embed script swaps that link for the
 * player (`video-script.ts`). YouTube's player comes from its no-cookie domain, Vimeo's with
 * `dnt=1`, so neither tracks the visitor before they choose to play.
 */

/** The providers a video Block can show. */
export const VIDEO_PROVIDERS = ["youtube", "vimeo"] as const;

export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

/** A video a Block shows: its provider, where its own page is, and the player WebCraft loads on a click. */
export type Video = {
	provider: VideoProvider;
	/** The video's page on the provider's site, which the link goes to without the embed script. */
	watchUrl: string;
	/** The provider's player, loaded only when the visitor clicks to play. */
	playerUrl: string;
};

/** Where players may come from; the embed script loads nothing else. */
export const PLAYER_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"] as const;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

/** The video at an address on YouTube or Vimeo, or undefined for any other address. */
export function videoAt(address: string): Video | undefined {
	let url: URL;
	try {
		url = new URL(address.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	const host = url.hostname.toLowerCase();
	const parts = url.pathname.split("/").filter(Boolean);
	if (host === "youtu.be" || YOUTUBE_HOSTS.has(host)) {
		const id =
			host === "youtu.be"
				? parts[0]
				: parts[0] === "watch" || parts.length === 0
					? (url.searchParams.get("v") ?? undefined)
					: ["embed", "shorts", "live", "v"].includes(parts[0] ?? "")
						? parts[1]
						: undefined;
		if (!id || !YOUTUBE_ID.test(id)) return undefined;
		const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
		return {
			provider: "youtube",
			watchUrl: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`,
			playerUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ""}`,
		};
	}
	if (VIMEO_HOSTS.has(host)) {
		// vimeo.com/<id>, vimeo.com/<id>/<hash> (unlisted), vimeo.com/channels/<name>/<id>, player.vimeo.com/video/<id>
		const index = parts.findIndex((part) => /^\d{1,12}$/.test(part));
		const id = index === -1 ? undefined : parts[index];
		if (!id) return undefined;
		const hashPart = parts[index + 1];
		const hash = url.searchParams.get("h") ?? (hashPart && /^[0-9a-f]{6,20}$/i.test(hashPart) ? hashPart : null);
		const safeHash = hash && /^[0-9a-f]{6,20}$/i.test(hash) ? hash.toLowerCase() : null;
		const start = seconds(/^#t=(.+)$/.exec(url.hash)?.[1] ?? null);
		return {
			provider: "vimeo",
			watchUrl: `https://vimeo.com/${id}${safeHash ? `/${safeHash}` : ""}${start ? `#t=${start}s` : ""}`,
			playerUrl: `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1${safeHash ? `&h=${safeHash}` : ""}${start ? `#t=${start}s` : ""}`,
		};
	}
	return undefined;
}

/** A start time written as seconds (`90`) or hours, minutes and seconds (`1m30s`); undefined when there is none. */
function seconds(value: string | null): number | undefined {
	if (!value) return undefined;
	if (/^\d{1,6}s?$/.test(value)) return Number.parseInt(value, 10) || undefined;
	const match = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,3})s)?$/.exec(value);
	if (!match) return undefined;
	const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
	return total > 0 ? total : undefined;
}
