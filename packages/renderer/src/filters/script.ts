/**
 * The Filter script (GLOSSARY.md › Filter). Site pages never carry inline scripts (ADR 0023), so it is
 * a file of its own, named by the hash of what it holds, served from the Site's domain and linked only
 * from pages showing a Filter. Without it a Filter is a plain GET form and the page loads again.
 *
 * With it the page never reloads: in Live mode a choice applies as it is made (text and ranges after a
 * short pause), in On submit mode when Apply is pressed. Either way it asks the Site for the parts of
 * the page the choice changes (`FILTER_FRAGMENTS_PATH`: the Filters, the filtered Loops' items and
 * their pagination, all rendered and escaped by the server), swaps them in, puts the page's address in
 * the browser's history (so Back and shared links work), keeps focus where it was and announces the
 * new result count in a live region. It never builds HTML from the address: it inserts what the
 * server sent, and writes words with `textContent` only. When the page has changed in a way it can't
 * swap (its parts no longer line up), it loads the page instead.
 */
import { createHash } from "node:crypto";

import { SCRIPT_PATH } from "../design-system/theme-toggle.ts";

/** Where the Filter script asks for a page's parts: `/_wc/filter/<page path>?<choices>`. */
export const FILTER_FRAGMENTS_PATH = "/_wc/filter";

/** The comment a region's start is marked with (`<!--wc-region loop products 1-->`); `/` ends it. */
const REGION = "wc-region";

const SCRIPT = `(() => {
	const FRAGMENTS = ${JSON.stringify(FILTER_FRAGMENTS_PATH)};
	const REGION = ${JSON.stringify(REGION)};
	const PAUSE = 400;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	let status;
	let pending;
	let timer;
	// The address whose choices the page shows: Back and Forward to another one swap the page's parts.
	let shown = location.pathname + location.search;

	const forms = () => document.querySelectorAll("form.wc-filter");
	const prepare = () => {
		for (const form of forms()) {
			const apply = form.querySelector(".wc-filter-apply");
			if (apply) apply.hidden = form.dataset.wcMode === "live";
		}
	};

	/** The live region screen readers hear the result count in: one per page, made once. */
	const announce = (text) => {
		if (!status) {
			status = document.createElement("div");
			status.className = "wc-visually-hidden";
			status.setAttribute("role", "status");
			status.setAttribute("aria-live", "polite");
			document.body.append(status);
		}
		status.textContent = "";
		setTimeout(() => {
			status.textContent = text;
		}, 50);
	};

	/** The page's regions by name: the comments around each, start and end. */
	const regions = () => {
		const found = new Map();
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.data;
			if (text.startsWith(REGION + " ")) {
				const name = text.slice(REGION.length + 1);
				found.set(name, { ...found.get(name), start: node });
			} else if (text.startsWith("/" + REGION + " ")) {
				const name = text.slice(REGION.length + 2);
				found.set(name, { ...found.get(name), end: node });
			}
		}
		return found;
	};

	const parse = (html) => {
		const template = document.createElement("template");
		template.innerHTML = html;
		return template.content;
	};

	/** Where focus is before a swap, to put it back after: the element's id, and a text box's own state. */
	const focusState = () => {
		const active = document.activeElement;
		if (!active || active === document.body || !active.id) return undefined;
		const typing = active.matches("input[type=search], input[type=number], input[type=date], input[type=text]");
		return {
			id: active.id,
			form: active.closest("form.wc-filter")?.id,
			value: typing ? active.value : undefined,
			start: typing && typeof active.selectionStart === "number" ? active.selectionStart : undefined,
			end: typing && typeof active.selectionEnd === "number" ? active.selectionEnd : undefined,
		};
	};

	const restoreFocus = (state) => {
		if (!state) return;
		let target = document.getElementById(state.id);
		if (target && state.value !== undefined && target.value !== state.value) target.value = state.value;
		if (!target && state.form) {
			// What had focus is gone (a chip just removed): the Filter's next choice, else its first control.
			const form = document.getElementById(state.form);
			target = form?.querySelector(".wc-filter-chip, .wc-filter-reset, input, select") ?? undefined;
		}
		if (!target) return;
		target.focus({ preventScroll: true });
		if (state.start !== undefined && typeof target.setSelectionRange === "function") {
			try {
				target.setSelectionRange(state.start, state.end ?? state.start);
			} catch {}
		}
	};

	/** Loads the page at \`url\` the way a link would: what the script does when it can't swap. */
	const load = (url) => {
		location.assign(url);
	};

	/** Shows the page's choices at \`url\` in place: its parts asked for, swapped, the address kept. */
	const go = async (url, options = {}) => {
		const target = new URL(url, location.href);
		if (target.origin !== location.origin) return load(target.href);
		pending?.abort();
		const controller = new AbortController();
		pending = controller;
		for (const form of forms()) form.setAttribute("aria-busy", "true");
		let data;
		try {
			const response = await fetch(FRAGMENTS + target.pathname + target.search, {
				headers: { accept: "application/json" },
				credentials: "same-origin",
				signal: controller.signal,
			});
			if (!response.ok) return load(target.href);
			data = await response.json();
		} catch (error) {
			if (controller.signal.aborted) return;
			return load(target.href);
		} finally {
			if (pending === controller) for (const form of forms()) form.removeAttribute("aria-busy");
		}
		if (pending !== controller) return;
		const here = regions();
		const fits =
			data.filters.every((part) => document.getElementById(part.id)) &&
			data.regions.every((part) => here.get(part.name)?.start && here.get(part.name)?.end) &&
			[...here.keys()].every((name) => data.regions.some((part) => part.name === name));
		if (!fits) return load(data.url);
		const focus = focusState();
		for (const part of data.filters) document.getElementById(part.id)?.replaceWith(parse(part.html));
		for (const part of data.regions) {
			const { start, end } = here.get(part.name);
			while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
			end.before(parse(part.html));
		}
		prepare();
		if (options.push !== false) history.pushState({ wcFilter: true }, "", data.url);
		shown = data.url;
		if (data.title) document.title = data.title;
		restoreFocus(focus);
		if (options.scroll) {
			const first = regions().values().next().value?.start;
			const element = first?.nextElementSibling ?? first?.parentElement;
			element?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
		}
		const said = forms()[0]?.dataset.wcAnnounce;
		if (said) announce(said);
	};

	/** A form's choices as the address it would load: the same fields a plain GET form sends. */
	const addressOf = (form) => {
		const action = new URL(form.getAttribute("action") || location.pathname, location.href);
		const query = new URLSearchParams(new FormData(form)).toString();
		return action.pathname + (query ? "?" + query : "");
	};

	const apply = (form) => {
		clearTimeout(timer);
		go(addressOf(form));
	};

	document.addEventListener("submit", (event) => {
		const form = event.target.closest?.("form.wc-filter");
		if (!form) return;
		event.preventDefault();
		apply(form);
	});
	document.addEventListener("change", (event) => {
		const form = event.target.closest?.("form.wc-filter");
		if (!form || form.dataset.wcMode !== "live") return;
		if (event.target.matches("input[type=search], input[type=number], input[type=date]")) return;
		apply(form);
	});
	document.addEventListener("input", (event) => {
		const form = event.target.closest?.("form.wc-filter");
		if (!form || form.dataset.wcMode !== "live") return;
		if (!event.target.matches("input[type=search], input[type=number], input[type=date]")) return;
		clearTimeout(timer);
		timer = setTimeout(() => apply(form), PAUSE);
	});
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		const link = event.target.closest?.("a[data-wc-filter-link]");
		if (!link) return;
		event.preventDefault();
		go(link.href, { scroll: link.closest("nav") !== null });
	});
	addEventListener("popstate", () => {
		if (location.pathname + location.search !== shown) go(location.href, { push: false });
	});
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", prepare);
	else prepare();
})();
`;

/** The Filter script: its file name (`<hash>.js`), address and text. */
export const FILTER_SCRIPT = (() => {
	const name = `${createHash("sha256").update(SCRIPT).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: SCRIPT };
})();
