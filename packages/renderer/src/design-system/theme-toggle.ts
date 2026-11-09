/**
 * The theme toggle's script. Site pages never carry inline scripts (ADR 0023), so it is a file of
 * its own, named by the hash of what it holds, served from the Site's domain and linked only from
 * pages that show a theme toggle. It runs in the page's <head>, before the page shows, so a
 * visitor's choice applies without a flash of the other theme; then it shows each toggle (they
 * start hidden, so a page without the script never offers a button that does nothing) and keeps
 * its pressed state true to the theme on screen.
 *
 * The choice is kept in the browser's local storage as `wc-theme`: a preference the visitor asked
 * for, read by nothing else.
 */
import { createHash } from "node:crypto";

/** Where Site pages' own scripts are served: `/_wc/js/<hash>.js`. */
export const SCRIPT_PATH = "/_wc/js/";

const SCRIPT = `(() => {
	const root = document.documentElement;
	const key = "wc-theme";
	const media = matchMedia("(prefers-color-scheme: dark)");
	try {
		const stored = localStorage.getItem(key);
		if (stored === "light" || stored === "dark") root.dataset.wcTheme = stored;
	} catch {}
	const dark = () => (root.dataset.wcTheme ? root.dataset.wcTheme === "dark" : media.matches);
	const toggles = () => document.querySelectorAll("button.wc-theme-toggle");
	const show = () => {
		for (const toggle of toggles()) toggle.setAttribute("aria-pressed", String(dark()));
	};
	const ready = () => {
		for (const toggle of toggles()) {
			toggle.hidden = false;
			toggle.addEventListener("click", () => {
				const next = dark() ? "light" : "dark";
				root.dataset.wcTheme = next;
				try {
					localStorage.setItem(key, next);
				} catch {}
				show();
			});
		}
		show();
	};
	media.addEventListener("change", show);
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
	else ready();
})();
`;

/** The theme toggle's script: its file name (`<hash>.js`), address and text. */
export const THEME_TOGGLE_SCRIPT = (() => {
	const name = `${createHash("sha256").update(SCRIPT).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: SCRIPT };
})();
