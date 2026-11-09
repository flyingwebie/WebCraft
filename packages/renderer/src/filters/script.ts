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
 *
 * A control shown apart from its Filter's form belongs to it through its fields' `form` attribute.
 * A drawer opened as a dialog holds its choices until its "Show" button applies them (whatever the
 * mode), its button saying meanwhile how many items they would list; it opens and closes with
 * `command` buttons, which the script handles where browsers don't. A top bar's dropdown stays open
 * while its choices apply in Live mode. Sliders show once it runs and keep their boxes in step; a date
 * preset fills its range's boxes where choices wait (On submit mode, an open drawer).
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
	const TYPED = "input[type=search], input[type=number], input[type=date]";
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	let status;
	let pending;
	let waiting;
	let timer;
	// The address whose choices the page shows: Back and Forward to another one swap the page's parts.
	let shown = location.pathname + location.search;

	const forms = () => document.querySelectorAll("form.wc-filter");
	/** The Filter form a field belongs to: its own, or the one a control shown apart names (\`form\`). */
	const formOf = (element) => {
		const form = element?.form ?? element?.closest?.("form");
		return form?.matches("form.wc-filter") ? form : undefined;
	};
	/** The drawer a field is in while it is open as a dialog: its choices wait for its Show button. */
	const openDrawer = (element) => {
		const drawer = element?.closest?.("dialog.wc-filter-drawer");
		return drawer?.open ? drawer : undefined;
	};
	const prepare = () => {
		for (const form of forms()) {
			for (const apply of form.querySelectorAll(".wc-filter-apply")) apply.hidden = form.dataset.wcMode === "live";
		}
		for (const slider of document.querySelectorAll("[data-wc-slider]")) slider.hidden = false;
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

	/**
	 * Where focus is before a swap, to put it back after: the element's id, a text box's own state, and
	 * the dropdown it is in, opened again.
	 */
	const focusState = () => {
		const active = document.activeElement;
		if (!active || active === document.body || !active.id) return undefined;
		const typing = active.matches(TYPED + ", input[type=text]");
		return {
			id: active.id,
			form: formOf(active)?.id,
			popover: active.closest("[popover]")?.id,
			value: typing ? active.value : undefined,
			start: typing && typeof active.selectionStart === "number" ? active.selectionStart : undefined,
			end: typing && typeof active.selectionEnd === "number" ? active.selectionEnd : undefined,
		};
	};

	const restoreFocus = (state) => {
		if (!state) return;
		if (state.popover) {
			// The dropdown opens again from its button, so Escape puts focus back there.
			const panel = document.getElementById(state.popover);
			const button = panel && document.querySelector('[popovertarget="' + panel.id + '"]');
			button?.focus({ preventScroll: true });
			try {
				panel?.showPopover({ source: button ?? undefined });
			} catch {}
		}
		let target = document.getElementById(state.id);
		if (target && state.value !== undefined && target.value !== state.value) target.value = state.value;
		if (!target && state.form) {
			// What had focus is gone (the last chip, just removed): the chip before it, else Reset's place,
			// else the Filter's first control.
			const form = document.getElementById(state.form);
			const chips = form?.querySelectorAll(".wc-filter-chip") ?? [];
			target = chips[chips.length - 1] ?? form?.querySelector("input:not([type=hidden]), select") ?? undefined;
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

	/** The page's parts for an address, as the Site renders them; undefined when it can't answer. */
	const fetchParts = async (target, signal) => {
		const response = await fetch(FRAGMENTS + target.pathname + target.search, {
			headers: { accept: "application/json" },
			credentials: "same-origin",
			signal,
		});
		return response.ok ? response.json() : undefined;
	};

	/** Shows the page's choices at \`url\` in place: its parts asked for, swapped, the address kept. */
	const go = async (url, options = {}) => {
		const target = new URL(url, location.href);
		if (target.origin !== location.origin) return load(target.href);
		pending?.abort();
		waiting?.abort();
		const controller = new AbortController();
		pending = controller;
		for (const form of forms()) form.setAttribute("aria-busy", "true");
		let data;
		try {
			data = await fetchParts(target, controller.signal);
			if (!data) return load(target.href);
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

	/**
	 * What an open drawer's choices would list, before they apply: its Show button says it, and screen
	 * readers hear it. Nothing else on the page changes until the button is pressed.
	 */
	const preview = async (form, drawer) => {
		waiting?.abort();
		const controller = new AbortController();
		waiting = controller;
		try {
			const data = await fetchParts(new URL(addressOf(form), location.href), controller.signal);
			const part = data?.filters.find((each) => each.id === form.id);
			if (!part || waiting !== controller) return;
			const fresh = parse(part.html).querySelector(".wc-filter-show")?.textContent;
			const show = drawer.querySelector(".wc-filter-show");
			if (fresh && show) show.textContent = fresh;
			const said = parse(part.html).querySelector("form")?.dataset.wcAnnounce;
			if (said) announce(said);
		} catch {}
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

	/** A change to a field: applied at once in Live mode, after a pause for text, or held by an open drawer. */
	const changed = (field, typed) => {
		const form = formOf(field);
		if (!form) return;
		const drawer = openDrawer(field);
		clearTimeout(timer);
		if (drawer) {
			timer = setTimeout(() => preview(form, drawer), typed ? PAUSE : 0);
			return;
		}
		if (form.dataset.wcMode !== "live") return;
		if (typed) timer = setTimeout(() => apply(form), PAUSE);
		else apply(form);
	};

	/** A range's slider moved: its box takes the value (each end kept on its side of the other). */
	const slid = (slider) => {
		const box = document.getElementById(slider.dataset.wcFor);
		if (!box) return;
		const ends = slider.parentElement.querySelectorAll("input[type=range]");
		const [low, high] = [ends[0], ends[1]];
		if (low && high && Number(low.value) > Number(high.value)) {
			if (slider === low) low.value = high.value;
			else high.value = low.value;
		}
		box.value = slider.value;
		changed(box, true);
	};

	/** A box with a slider took a value: its slider shows it. */
	const typedInto = (box) => {
		const slider = box.id ? document.querySelector('input[type=range][data-wc-for="' + box.id + '"]') : null;
		if (slider && box.value !== "") slider.value = box.value;
	};

	/** Empties an open drawer's fields: its choices wait for its Show button like any other. */
	const clearDrawer = (drawer) => {
		for (const field of drawer.querySelectorAll("input, select")) {
			if (field.type === "checkbox") field.checked = false;
			else if (field.type === "radio") field.checked = field.value === "";
			else if (field.tagName === "SELECT") field.selectedIndex = 0;
			else if (field.name) field.value = "";
		}
		for (const preset of drawer.querySelectorAll("a[aria-current]")) preset.removeAttribute("aria-current");
	};

	/** A preset picked where choices wait (On submit mode, an open drawer): it fills its range's boxes. */
	const pick = (link) => {
		const fieldset = link.closest("fieldset");
		const [from, to] = fieldset?.querySelectorAll("input[type=date]") ?? [];
		if (!from || !to) return false;
		from.value = link.dataset.wcFrom;
		to.value = link.dataset.wcTo;
		for (const other of fieldset.querySelectorAll("a[aria-current]")) other.removeAttribute("aria-current");
		link.setAttribute("aria-current", "true");
		changed(from, false);
		return true;
	};

	// Buttons that open and close a drawer, where the browser doesn't do it by itself.
	const commands = "command" in HTMLButtonElement.prototype;
	document.addEventListener("click", (event) => {
		if (commands) return;
		const button = event.target.closest?.("button[commandfor]");
		const dialog = button && document.getElementById(button.getAttribute("commandfor"));
		if (!dialog || dialog.tagName !== "DIALOG") return;
		if (button.getAttribute("command") === "show-modal" && !dialog.open) dialog.showModal();
		if (button.getAttribute("command") === "close" && dialog.open) dialog.close();
	});
	document.addEventListener("submit", (event) => {
		const form = event.target.closest?.("form.wc-filter");
		if (!form) return;
		event.preventDefault();
		// The drawer's Show button applies its choices and closes it; focus goes back to its button.
		openDrawer(event.submitter)?.close();
		const popover = event.submitter?.closest?.("[popover]");
		try {
			popover?.hidePopover();
		} catch {}
		apply(form);
	});
	document.addEventListener("change", (event) => {
		const field = event.target;
		if (!formOf(field) || field.matches(TYPED) || field.matches("input[type=range]")) return;
		changed(field, false);
	});
	document.addEventListener("input", (event) => {
		const field = event.target;
		if (field.matches?.("input[type=range][data-wc-for]")) return slid(field);
		if (!formOf(field) || !field.matches(TYPED)) return;
		typedInto(field);
		changed(field, true);
	});
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		const link = event.target.closest?.("a[data-wc-filter-link]");
		if (!link) return;
		const drawer = openDrawer(link);
		if (drawer && link.matches(".wc-filter-drawer-reset")) {
			event.preventDefault();
			clearDrawer(drawer);
			const form = formOf(drawer);
			if (form) preview(form, drawer);
			return;
		}
		if (link.dataset.wcFrom !== undefined && (drawer || formOf(link)?.dataset.wcMode === "submit") && pick(link)) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		openDrawer(link)?.close();
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
