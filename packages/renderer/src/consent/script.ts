/**
 * The consent script: what makes the Consent banner work on a cached page (ADR 0020). Pages never
 * carry inline scripts (ADR 0023), so it is a file of its own, named by the hash of what it holds,
 * served from the Site's domain (`/_wc/js/<hash>.js`) and linked, deferred, only from pages that hold
 * something back. It reads the Site's mode and banner version from `<meta name="webcraft-consent-mode">`
 * and `<meta name="webcraft-consent-version">`.
 *
 * **The visitor's choice** is the `webcraft.consent` cookie (`__Host-` on HTTPS), which the Site sets
 * when it records a choice (`POST /_wc/consent`): `<record id>.<banner version>.<bits>`, the bits
 * being `1` or `0` for Analytics, Marketing and Media in that order. Without one, an Opt-in Site
 * accepts nothing and an Opt-out Site everything, and the banner shows until the visitor answers.
 *
 * **Held back**: `<template data-wc-consent="<category>">` holds scripts, turned into running scripts
 * in place (in order: those that weren't `async` keep their order) once the category is accepted. An
 * element marked `data-wc-consent` (an embed) shows its placeholder while its category isn't accepted;
 * "Load content" loads that one alone (its `<template>`, or a click on its play link, which the embed
 * script turns into the player), and its box, when ticked, accepts the whole category. A category
 * withdrawn after something of it ran reloads the page, since nothing can stop a script once it runs.
 *
 * **Outside consent services** (mode `outside`, no banner of WebCraft's): the choice comes from
 * - the TCF v2.2 API (`__tcfapi`), once its data is final (`tcloaded`, `useractioncomplete`):
 *   Analytics needs purposes 1, 8 and 9 (storing on the device, measuring content, understanding
 *   audiences), Marketing purposes 1, 2, 3, 4 and 7 (storing, selecting, profiling and measuring
 *   advertising), Media purpose 1; everything is accepted where the data says GDPR doesn't apply;
 * - the consent-mode signal, `["consent", "default" | "update", {…}]` entries in `window.dataLayer`
 *   (`update` is an answer, `default` only a starting state): Analytics is `analytics_storage`,
 *   Marketing `ad_storage` with neither `ad_user_data` nor `ad_personalization` denied, Media
 *   `personalization_storage`, each `granted`;
 * - `webcraft.consent.set({ analytics, marketing, media })`, from the Site's own glue code. It does
 *   nothing on a Site with WebCraft's banner: there only the visitor's choice in the banner counts.
 * Whichever answers last wins. Nothing is recorded or kept: the service keeps its own records.
 *
 * **For other scripts** (Site analytics, Popups, the Site's own scripts): `window.webcraft.consent`
 * has `mode`, `version`, `answered`, `has(category)`, `choices()`, `set(choices)`, `open()` and
 * `whenAnswered()` (a promise, for Popups, which never show before the banner is answered), and
 * every change (and the state as the page starts) is the `webcraft:consent` event on `document`, its
 * `detail` being `{ choices, answered }`. A page without this script asks nothing: everything there
 * is accepted and there is nothing to wait for.
 */
import { createHash } from "node:crypto";

import { SCRIPT_PATH } from "../design-system/theme-toggle.ts";
import { CHOSEN_CATEGORIES, CONSENT_HOOKS, CONSENT_RECORD_PATH } from "./banner.ts";

const SCRIPT = `(() => {
	const doc = document;
	const root = doc.documentElement;
	const meta = (name) => (doc.querySelector('meta[name="' + name + '"]') || { content: "" }).content;
	const mode = meta("webcraft-consent-mode");
	if (mode !== "optIn" && mode !== "optOut" && mode !== "outside") return;
	const version = Number(meta("webcraft-consent-version")) || 1;
	const CATEGORIES = ${JSON.stringify(CHOSEN_CATEGORIES)};
	const RECORD = ${JSON.stringify(CONSENT_RECORD_PATH)};
	const cookieName = (location.protocol === "https:" ? "__Host-" : "") + "webcraft.consent";
	const all = (value) => Object.fromEntries(CATEGORIES.map((category) => [category, value]));

	const stored = () => {
		for (const part of doc.cookie.split(";")) {
			const separator = part.indexOf("=");
			if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
			const [id = "", , bits = ""] = part.slice(separator + 1).trim().split(".");
			if (!/^[0-9a-f-]{36}$/.test(id) || !/^[01]{3}$/.test(bits)) return null;
			return Object.fromEntries(CATEGORIES.map((category, index) => [category, bits[index] === "1"]));
		}
		return null;
	};
	const kept = mode === "outside" ? null : stored();
	let answered = kept !== null;
	let choices = kept || all(mode === "optOut");
	const ran = new Set();
	const waiting = [];

	const has = (category) => category === "necessary" || choices[category] === true;
	const emit = () => {
		root.setAttribute("data-wc-consent-state", answered ? "answered" : "waiting");
		if (answered) while (waiting.length > 0) waiting.shift()();
		doc.dispatchEvent(new CustomEvent("webcraft:consent", { detail: { choices: { necessary: true, ...choices }, answered } }));
	};

	const release = () => {
		for (const template of doc.querySelectorAll("template[data-wc-consent]")) {
			const category = template.getAttribute("data-wc-consent");
			if (!has(category) || template.parentElement?.closest("[data-wc-consent]")) continue;
			ran.add(category);
			const scripts = [...template.content.querySelectorAll("script")].map((held) => {
				const script = doc.createElement("script");
				for (const attribute of held.attributes) script.setAttribute(attribute.name, attribute.value);
				if (!held.hasAttribute("async")) script.async = false;
				return script;
			});
			template.replaceWith(...scripts);
		}
		for (const embed of doc.querySelectorAll("[data-wc-consent]:not(template)")) {
			if (embed.hasAttribute("data-wc-consent-loaded")) continue;
			const placeholder = embed.querySelector(":scope > .${CONSENT_HOOKS.placeholderClass}");
			if (!placeholder) continue;
			const allowed = has(embed.getAttribute("data-wc-consent"));
			placeholder.hidden = allowed;
			for (const child of embed.children) if (child !== placeholder && child.localName !== "template") child.hidden = !allowed;
		}
	};

	const loadEmbed = (embed) => {
		embed.setAttribute("data-wc-consent-loaded", "");
		ran.add(embed.getAttribute("data-wc-consent"));
		const placeholder = embed.querySelector(":scope > .${CONSENT_HOOKS.placeholderClass}");
		const focused = placeholder && placeholder.contains(doc.activeElement);
		if (placeholder) placeholder.remove();
		for (const child of embed.children) child.hidden = false;
		const template = embed.querySelector(":scope > template");
		if (template) template.replaceWith(template.content.cloneNode(true));
		const link = embed.querySelector(":scope > a[data-wc-embed]");
		if (link) link.click();
		else if (focused) (embed.querySelector("iframe, a, button") || embed).focus();
	};

	const apply = (before) => {
		if (CATEGORIES.some((category) => before[category] && !choices[category] && ran.has(category))) return false;
		release();
		emit();
		return true;
	};

	// The banner (none with an outside service, and none on a page that asks nothing).
	const banner = mode === "outside" ? null : doc.getElementById(${JSON.stringify(CONSENT_HOOKS.bannerId)});
	const modal = banner instanceof HTMLDialogElement;
	const part = (selector) => (banner ? banner.querySelector(selector) : null);
	const categories = part(".wc-consent-categories");
	const chooseButton = part('[data-wc-consent-action="choose"]');
	const saveButton = part('[data-wc-consent-action="save"]');
	const heading = part(".wc-consent-title");
	let returnTo = null;
	const room = () => {
		if (!banner || modal) return;
		root.style.scrollPaddingBlockEnd = banner.hidden ? "" : banner.offsetHeight + "px";
	};
	const expand = (open) => {
		if (!categories) return;
		categories.hidden = !open;
		if (saveButton) saveButton.hidden = !open;
		if (chooseButton) {
			chooseButton.hidden = open;
			chooseButton.setAttribute("aria-expanded", String(open));
		}
		for (const category of CATEGORIES) {
			const box = categories.querySelector('input[name="' + category + '"]');
			if (box) box.checked = choices[category] === true;
		}
	};
	const show = (open) => {
		if (!banner) return;
		expand(open);
		if (modal) {
			if (!banner.open) banner.showModal();
		} else {
			banner.hidden = false;
			room();
		}
	};
	const hide = () => {
		if (!banner) return;
		if (modal) {
			if (banner.open) banner.close();
		} else {
			banner.hidden = true;
			room();
		}
		const target = returnTo;
		returnTo = null;
		if (target && target.isConnected) target.focus();
	};
	const open = (from) => {
		if (!banner) return;
		returnTo = from || (doc.activeElement instanceof HTMLElement ? doc.activeElement : null);
		show(true);
		if (heading) heading.focus();
	};

	const record = () =>
		fetch(RECORD, {
			method: "POST",
			credentials: "same-origin",
			keepalive: true,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ choices, version, language: root.lang }),
		}).catch(() => undefined);

	/** A visitor's (or the Site's own code's) answer: kept, recorded and applied, or applied (outside service). */
	const choose = (next) => {
		const before = choices;
		choices = { ...choices };
		for (const category of CATEGORIES) if (typeof next[category] === "boolean") choices[category] = next[category];
		answered = true;
		const saved = mode === "outside" ? Promise.resolve() : record();
		if (!apply(before)) saved.then(() => location.reload());
	};

	if (banner) {
		banner.addEventListener("click", (event) => {
			const button = event.target instanceof Element ? event.target.closest("[data-wc-consent-action]") : null;
			if (!button || !banner.contains(button)) return;
			const action = button.getAttribute("data-wc-consent-action");
			if (action === "choose") {
				expand(true);
				const first = categories && categories.querySelector("input:not([disabled])");
				if (first) first.focus();
				return;
			}
			if (action === "accept") choose(all(true));
			else if (action === "reject") choose(all(false));
			else if (action === "save") {
				const next = {};
				for (const category of CATEGORIES) {
					const box = categories && categories.querySelector('input[name="' + category + '"]');
					next[category] = Boolean(box && box.checked);
				}
				choose(next);
			} else return;
			hide();
		});
		if (modal) banner.addEventListener("close", () => hide());
		else
			banner.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					hide();
				}
			});
		if (!modal && "ResizeObserver" in window) new ResizeObserver(room).observe(banner);
		for (const button of doc.querySelectorAll(".${CONSENT_HOOKS.settingsClass}")) {
			button.hidden = false;
			button.addEventListener("click", () => open(button));
		}
	}

	doc.addEventListener("click", (event) => {
		const button = event.target instanceof Element ? event.target.closest('[data-wc-consent-action="load"]') : null;
		const embed = button && button.closest("[data-wc-consent]:not(template)");
		if (!embed) return;
		const remember = embed.querySelector("[data-wc-consent-remember]");
		const category = embed.getAttribute("data-wc-consent");
		loadEmbed(embed);
		if (remember && remember.checked && CATEGORIES.includes(category)) {
			choose({ [category]: true });
			hide();
		}
	});

	// An outside consent service's answer.
	if (mode === "outside") {
		const signal = (next, final) => {
			const before = choices;
			choices = { ...choices, ...next };
			if (final) answered = true;
			if (!apply(before)) location.reload();
		};
		const tcf = () => {
			if (typeof window.__tcfapi !== "function") return false;
			window.__tcfapi("addEventListener", 2, (data, success) => {
				if (!success || !data || (data.eventStatus !== "tcloaded" && data.eventStatus !== "useractioncomplete")) return;
				if (data.gdprApplies === false) return signal(all(true), true);
				const consents = (data.purpose && data.purpose.consents) || {};
				const given = (...purposes) => purposes.every((purpose) => consents[purpose] === true);
				signal({ analytics: given(1, 8, 9), marketing: given(1, 2, 3, 4, 7), media: given(1) }, true);
			});
			return true;
		};
		if (!tcf()) {
			let tries = 0;
			const timer = setInterval(() => {
				if (tcf() || ++tries >= 40) clearInterval(timer);
			}, 250);
		}
		const state = {};
		const seen = (entry) => {
			if (!entry || typeof entry !== "object" || entry[0] !== "consent") return;
			const command = entry[1];
			const given = entry[2];
			if ((command !== "default" && command !== "update") || !given || typeof given !== "object") return;
			Object.assign(state, given);
			const granted = (key) => state[key] === "granted";
			signal(
				{
					analytics: granted("analytics_storage"),
					marketing: granted("ad_storage") && state.ad_user_data !== "denied" && state.ad_personalization !== "denied",
					media: granted("personalization_storage"),
				},
				command === "update",
			);
		};
		const layer = (window.dataLayer = window.dataLayer || []);
		for (const entry of [...layer]) seen(entry);
		const push = layer.push;
		layer.push = function (...entries) {
			for (const entry of entries) seen(entry);
			return push.apply(this, entries);
		};
	}

	window.webcraft = Object.assign(window.webcraft || {}, {
		consent: {
			mode,
			version,
			get answered() {
				return answered;
			},
			has,
			choices: () => ({ necessary: true, ...choices }),
			// Only an outside consent service answers through code; on a Site with WebCraft's banner, only
			// the visitor's own choice in the banner counts, so no script on the page can answer for them.
			set: (next) => {
				if (mode === "outside" && next && typeof next === "object") choose(next);
			},
			open: () => open(null),
			whenAnswered: () => new Promise((resolve) => (answered ? resolve() : waiting.push(resolve))),
		},
	});

	release();
	emit();
	if (!answered) show(false);
})();
`;

/** The consent script: its file name (`<hash>.js`), address and text. */
export const CONSENT_SCRIPT = (() => {
	const name = `${createHash("sha256").update(SCRIPT).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: SCRIPT };
})();
