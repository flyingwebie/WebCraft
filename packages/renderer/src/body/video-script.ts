/**
 * The embed script: what makes a video Block load only when the visitor clicks to play. Pages never
 * carry inline scripts (ADR 0023), so it is a file of its own, named by the hash of what it holds,
 * served from the Site's domain (`/_wc/js/<hash>.js`) and linked only from pages that show a video.
 *
 * A video renders as a link to the video's own page, which works without the script. With it, a
 * click swaps the link for the provider's player (only from `PLAYER_ORIGINS`, never another
 * address), titled for screen readers, and moves focus to it.
 */
import { createHash } from "node:crypto";

import { SCRIPT_PATH } from "../design-system/theme-toggle.ts";
import { PLAYER_ORIGINS } from "./video.ts";

const SCRIPT = `(() => {
	const origins = ${JSON.stringify(PLAYER_ORIGINS)};
	const play = (link) => {
		const src = link.getAttribute("data-wc-embed") || "";
		let url;
		try {
			url = new URL(src);
		} catch {
			return false;
		}
		if (!origins.includes(url.origin)) return false;
		const frame = document.createElement("iframe");
		frame.src = url.href;
		frame.title = link.getAttribute("data-wc-title") || link.textContent || "";
		frame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
		frame.allowFullscreen = true;
		frame.referrerPolicy = "strict-origin-when-cross-origin";
		link.replaceWith(frame);
		frame.focus();
		return true;
	};
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const target = event.target instanceof Element ? event.target.closest(".wc-embed > a[data-wc-embed]") : null;
		if (target && play(target)) event.preventDefault();
	});
})();
`;

/** The embed script: its file name (`<hash>.js`), address and text. */
export const VIDEO_SCRIPT = (() => {
	const name = `${createHash("sha256").update(SCRIPT).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: SCRIPT };
})();
