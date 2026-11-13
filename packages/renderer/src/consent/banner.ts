/**
 * The Consent banner on Site pages (ADR 0020). Pages are cached and the same for every visitor, and
 * never carry inline scripts or styles (ADR 0023), so everything here is markup, the same for all:
 *
 * - the banner itself, right after the skip link, `hidden` (a closed `<dialog>` for the dialog
 *   layout): the consent script shows it to a visitor who hasn't answered, so without JavaScript the
 *   page stays as it is (and nothing held back runs);
 * - what the banner holds back: outside and Module scripts as inert `<template data-wc-consent>`
 *   elements, which the consent script turns into scripts once their category is accepted, and
 *   embeds marked `data-wc-consent` with a labelled placeholder (`wc-consent-placeholder`) offering
 *   "Load content" for that one;
 * - the "Cookie settings" button (`{{@consentSettings}}`), `hidden` until the script can open the
 *   banner again.
 *
 * Its classes are WebCraft's own hooks (`CONSENT_HOOKS`), styled in the Design system's base layer.
 */
import { escapeAttribute, escapeText, safeUrl } from "../escape.ts";
import type { ConsentWords } from "./words.ts";

/** Where the consent script records a visitor's choice: `POST /_wc/consent`, on the Site's own domain. */
export const CONSENT_RECORD_PATH = "/_wc/consent";

/** The Consent categories a visitor chooses (Necessary is always on), in the order the banner lists them. */
export const CHOSEN_CATEGORIES = ["analytics", "marketing", "media"] as const;

export type ChosenCategory = (typeof CHOSEN_CATEGORIES)[number];

/** The names WebCraft keeps for the banner's parts: classes the base layer styles, and the ids it uses. */
export const CONSENT_HOOKS = {
	/** The banner's id, and its class (with `data-layout`: `bar`, `box`, `dialog`). */
	bannerId: "wc-consent",
	bannerClass: "wc-consent",
	/** Its buttons and the "Cookie settings" button, and an embed's placeholder. */
	buttonClass: "wc-consent-button",
	settingsClass: "wc-consent-settings",
	placeholderClass: "wc-consent-placeholder",
} as const;

/** What a page needs to show the Site's Consent banner (absent where nothing is asked: `none`, Edit mode). */
export type PageConsent = {
	/** How the Site asks: its own banner, Opt-in or Opt-out, or an outside consent service (no banner of WebCraft's). */
	mode: "optIn" | "optOut" | "outside";
	layout: "bar" | "box" | "dialog";
	/** The banner version a visitor's choice answers. */
	version: number;
	/** Its words in the page's language. */
	words: ConsentWords;
	/** The privacy policy link, when the banner has one. */
	privacyPolicy: { href: string; text: string } | null;
};

/** The banner: hidden until the consent script shows it. */
export function consentBannerHtml(consent: PageConsent): string {
	const { words } = consent;
	const policy = consent.privacyPolicy
		? `<p class="wc-consent-policy"><a href="${escapeAttribute(safeUrl(consent.privacyPolicy.href))}">${escapeText(consent.privacyPolicy.text || words.privacyPolicy)}</a></p>`
		: "";
	const category = (name: "necessary" | ChosenCategory) => {
		const id = `${CONSENT_HOOKS.bannerId}-${name}`;
		const fixed = name === "necessary" ? " checked disabled" : ` name="${name}"`;
		return [
			'<div class="wc-consent-category">',
			`<input type="checkbox" id="${id}"${fixed} aria-describedby="${id}-text">`,
			`<label for="${id}">${escapeText(words[name])}</label>`,
			`<p class="wc-consent-description" id="${id}-text">${escapeText(words[`${name}Text`])}</p>`,
			"</div>",
		].join("");
	};
	const button = (action: string, text: string, extra = "") =>
		`<button type="button" class="${CONSENT_HOOKS.buttonClass}" data-wc-consent-action="${action}"${extra}>${escapeText(text)}</button>`;
	const content = [
		'<div class="wc-consent-text">',
		`<h2 class="wc-consent-title" id="${CONSENT_HOOKS.bannerId}-title" tabindex="-1">${escapeText(words.heading)}</h2>`,
		`<p class="wc-consent-message">${escapeText(words.message)}</p>`,
		policy,
		"</div>",
		`<fieldset class="wc-consent-categories" id="${CONSENT_HOOKS.bannerId}-categories" hidden>`,
		`<legend class="wc-visually-hidden">${escapeText(words.categories)}</legend>`,
		category("necessary"),
		...CHOSEN_CATEGORIES.map(category),
		"</fieldset>",
		'<div class="wc-consent-actions">',
		button("reject", words.rejectAll),
		button("accept", words.acceptAll),
		button("choose", words.choose, ` aria-expanded="false" aria-controls="${CONSENT_HOOKS.bannerId}-categories"`),
		button("save", words.save, " hidden"),
		"</div>",
	].join("");
	const attributes = `class="${CONSENT_HOOKS.bannerClass}" id="${CONSENT_HOOKS.bannerId}" data-layout="${consent.layout}" aria-labelledby="${CONSENT_HOOKS.bannerId}-title"`;
	// The dialog layout is modal (a closed <dialog>, opened with showModal); the others leave the page usable.
	return consent.layout === "dialog"
		? `<dialog ${attributes}>${content}</dialog>`
		: `<section ${attributes} hidden>${content}</section>`;
}

/**
 * The placeholder a held-back embed shows while its category isn't accepted: what it is and where it
 * comes from, why it is held back, "Load content" (for this one only) and a box to remember the choice
 * for the whole category. `n` numbers the page's placeholders, for their ids.
 */
export function consentPlaceholderHtml(
	words: ConsentWords,
	embed: { label: string; source: string; n: number },
): string {
	const id = `wc-held-${embed.n}`;
	return [
		`<div class="${CONSENT_HOOKS.placeholderClass}" hidden>`,
		`<p class="wc-consent-placeholder-title" id="${id}"><strong>${escapeText(embed.label)}</strong> · ${escapeText(embed.source)}</p>`,
		`<p>${escapeText(words.embedText)}</p>`,
		'<div class="wc-consent-placeholder-actions">',
		`<button type="button" class="${CONSENT_HOOKS.buttonClass}" data-wc-consent-action="load" aria-describedby="${id}">${escapeText(words.loadContent)}</button>`,
		`<label class="wc-consent-remember"><input type="checkbox" data-wc-consent-remember> ${escapeText(words.rememberEmbeds)}</label>`,
		"</div>",
		"</div>",
	].join("");
}

/** The "Cookie settings" button (`{{@consentSettings}}`): hidden until the consent script can open the banner. */
export function consentSettingsHtml(words: ConsentWords): string {
	return `<button type="button" class="${CONSENT_HOOKS.settingsClass}" aria-controls="${CONSENT_HOOKS.bannerId}" hidden>${escapeText(words.settings)}</button>`;
}

/** Scripts held back until a category is accepted: inert in a `<template>` until the consent script loads them. */
export function heldScriptsHtml(category: string, tags: readonly string[], attributes = ""): string {
	return `<template data-wc-consent="${escapeAttribute(category)}"${attributes}>${tags.join("")}</template>`;
}
