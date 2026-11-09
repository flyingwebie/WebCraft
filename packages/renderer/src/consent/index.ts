/**
 * The Consent banner on Site pages (ADR 0020): its markup, its words and the consent script that
 * makes it work on cached pages under the strict policy.
 */
export {
	CHOSEN_CATEGORIES,
	type ChosenCategory,
	CONSENT_HOOKS,
	CONSENT_RECORD_PATH,
	type PageConsent,
} from "./banner.ts";
export { CONSENT_SCRIPT } from "./script.ts";
export { CONSENT_TEXT_KEYS, type ConsentTextKey, type ConsentWords, consentWords } from "./words.ts";
