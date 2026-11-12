import { type InstallServices, normaliseHostname } from "@webcraft/core";

/** What stands for a Share link's path, which is its token. */
const SHARE_LINK_PATH = "/[share-link]";

/**
 * A request's address as it may be written down: in the log, and from there in the Error log (which
 * names a failed request by its method and path) and in what an outside error tracker is sent. Every
 * place that records a request's address takes it from here, so a token that is a link's whole secret
 * is never written, working, where only its hash is kept:
 *
 * - a Share link's token is its path on the Share link address: the path becomes `/[share-link]`;
 * - other links carry theirs in the query (setup, invite, Edit mode and Staging links as `token`, the
 *   undo history's handoff as `history`, a Site export's download as `signature`): of the query only
 *   the parameters' names are kept. A visitor's own words (what they searched for) are there too.
 */
export function recordedAddress(request: Request, services: InstallServices): string {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return "[not an address]";
	}
	const path = normaliseHostname(url.hostname) === services.shareLinks.hostname() ? SHARE_LINK_PATH : url.pathname;
	const names = [...new Set(url.searchParams.keys())];
	const query = names.length > 0 ? `?${names.map((name) => `${encodeURIComponent(name)}=…`).join("&")}` : "";
	return `${url.origin}${path}${query}`;
}
