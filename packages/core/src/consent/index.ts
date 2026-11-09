/**
 * The Consent banner and Consent categories (ADR 0020, GLOSSARY.md): a Site asks its visitors which
 * categories of tracking and outside content they accept (Necessary, Analytics, Marketing, Media), and
 * holds back what they haven't accepted. Pages are cached and the same for every visitor: the banner is
 * in every page that needs it, and a served script reads the visitor's choice from the
 * `webcraft.consent` cookie and lets held-back scripts and embeds load (`@webcraft/renderer` ›
 * consent). Consent records prove each choice, with nothing that identifies the visitor.
 */
import type { RateLimits } from "../rate-limits.ts";
import type { DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";
import {
	bannerRow,
	CONSENT_LAYOUTS,
	CONSENT_MODES,
	type ConsentLayout,
	type ConsentMode,
	type ConsentSettings,
	setConsentSettings,
	settingsOf,
} from "./banner.ts";

import {
	CONSENT_RECORD_LIMIT,
	type ConsentRecord,
	ConsentRecordNotFoundError,
	findConsentRecord,
	type RecordAnswer,
	recordConsent,
} from "./records.ts";
import { type ConsentText, type ConsentTextChange, consentText, saveConsentTextDraft } from "./text.ts";

export { consentRecordsPurge } from "./records.ts";
export {
	CONSENT_TEXT_FIELDS,
	ConsentBannerInvalidError,
	type ConsentText,
	type ConsentTextChange,
} from "./text.ts";
export {
	CONSENT_LAYOUTS,
	CONSENT_MODES,
	CONSENT_RECORD_LIMIT,
	type ConsentLayout,
	type ConsentMode,
	type ConsentRecord,
	ConsentRecordNotFoundError,
	type ConsentSettings,
	type RecordAnswer,
};

/** A Site's Consent banner as the admin shows it. */
export type ConsentBannerView = {
	siteId: string;
	mode: ConsentMode;
	layout: ConsentLayout;
	/** Goes up with every change visitors can see; each Consent record names the one it answered. */
	version: number;
	/** Its words (Content), in the language asked for. */
	text: ConsentText;
};

export type ConsentService = {
	/** The Site's banner, its words in `language` (the Default language unless given; open the Site with `site.view`). */
	get(scope: SiteScope, language?: string): Promise<ConsentBannerView>;
	/** Changes its mode and layout (open the Site with `structure.edit`). */
	setSettings(scope: SiteScope, settings: ConsentSettings): Promise<ConsentBannerView>;
	/**
	 * Records a visitor's choice on the Site's banner (the Site pipeline, for `POST /_wc/consent`):
	 * `input` as the consent script sends it, the client address only for the per-address limit.
	 */
	record(site: Site, input: unknown, clientAddress: string | null): Promise<RecordAnswer>;
	/** One of the Site's Consent records (open the Site with `site.view`). */
	findRecord(scope: SiteScope, recordId: string): Promise<ConsentRecord>;
	/**
	 * Saves a change to its words' Draft (open the Site with `entry.edit`); publishing goes through
	 * `publishing.publish` with `{ kind: "consentBanner" }`.
	 */
	saveDraft(scope: SiteScope, change: ConsentTextChange): Promise<ConsentBannerView>;
};

export function createConsent({
	data,
	rateLimits,
}: {
	data: Pick<DataLayer, "visitors">;
	rateLimits: RateLimits;
}): ConsentService {
	const get = async (scope: SiteScope, language?: string): Promise<ConsentBannerView> => {
		const row = await bannerRow(scope);
		return { siteId: scope.site.id, ...settingsOf(row), text: await consentText(scope, row, language) };
	};
	return {
		get,
		async setSettings(scope, settings) {
			await setConsentSettings(scope, settings);
			return get(scope);
		},
		record: (site, input, clientAddress) => recordConsent(data.visitors(site), input, { rateLimits, clientAddress }),
		findRecord: findConsentRecord,
		async saveDraft(scope, change) {
			const text = await saveConsentTextDraft(scope, change);
			return { siteId: scope.site.id, ...settingsOf(await bannerRow(scope)), text };
		},
	};
}
