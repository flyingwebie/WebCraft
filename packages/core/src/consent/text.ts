/**
 * The Consent banner's words (ADR 0020): Content, like the Globals' values (ADRs 0003, 0014). Members
 * write them in a Draft (`entry.edit`), per language, and publish them (`entry.publish`, through
 * `publish` with `{ kind: "consentBanner" }`); visitors see what is published. They are a fixed set of
 * Fields: text, translatable, and the privacy policy link (an address and its text, per language). A
 * word nobody wrote shows WebCraft's own in the page's language; a language without its own value
 * shows the Default language's, one word at a time, as every Translatable field does.
 */
import { consentBanners } from "@webcraft/db/schema";
import { CONSENT_TEXT_KEYS, type ConsentTextKey, type ConsentWords, consentWords } from "@webcraft/renderer";
import { eq } from "drizzle-orm";

import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition, FieldInput, Json } from "../content/field-types.ts";
import {
	checkFields,
	type Findings,
	findingsInEveryLanguage,
	type Languages,
	randomRowId,
	readFields,
	writeFields,
} from "../content/field-values.ts";
import { parseFields } from "../content/fields.ts";
import { sameJson } from "../content/json.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import type { Published } from "../content/publishing.ts";
import { storedVersion } from "../content/values.ts";
import { actingPerson, personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ConsentBannerRow, lockBanner } from "./banner.ts";

/** The banner's words can't be saved or published as they are: each problem at its place (`fields.heading`). */
export class ConsentBannerInvalidError extends Error {
	override name = "ConsentBannerInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(`The Consent banner's words can't be saved: ${problems.map((problem) => problem.message).join(" ")}`);
		this.problems = problems;
	}
}

/** What each word is, in API problems (the admin shows its own labels, in the person's language). */
const LABELS: Record<ConsentTextKey, string> = {
	heading: "Heading",
	message: "Message",
	acceptAll: "Accept all button",
	rejectAll: "Reject all button",
	choose: "Choose button",
	save: "Save button",
	settings: "Cookie settings button",
	privacyPolicy: "Privacy policy link",
	necessary: "Necessary",
	necessaryText: "What Necessary is for",
	analytics: "Analytics",
	analyticsText: "What Analytics is for",
	marketing: "Marketing",
	marketingText: "What Marketing is for",
	media: "Media",
	mediaText: "What Media is for",
	embedText: "Held-back content",
	loadContent: "Load content button",
	rememberEmbeds: "Remember Media choice",
};

/** Longer words: the message, what each category is for, and what a held-back embed says. */
const LONG: ReadonlySet<ConsentTextKey> = new Set([
	"message",
	"necessaryText",
	"analyticsText",
	"marketingText",
	"mediaText",
	"embedText",
]);

/** The banner's Fields, in the order the admin shows them. */
export const CONSENT_TEXT_FIELDS: readonly FieldDefinition[] = (() => {
	const inputs: FieldInput[] = CONSENT_TEXT_KEYS.map((key) =>
		key === "privacyPolicy"
			? { key, label: LABELS[key], type: "link", translatable: true }
			: { key, label: LABELS[key], type: "text", translatable: true, maxLength: LONG.has(key) ? 1000 : 120 },
	);
	const problems: ContentProblem[] = [];
	const fields = parseFields(inputs, problems, {
		postTypeKeys: new Set(),
		owner: "globals",
		reservedKeys: new Set(),
	});
	if (problems.length > 0) throw new Error(`The Consent banner's Fields are wrong: ${JSON.stringify(problems)}`);
	return fields;
})();

/** The banner's words as the admin edits them, in one language. */
export type ConsentText = {
	/** The Fields, in order. */
	fields: readonly FieldDefinition[];
	/** The language the values are in. */
	language: string;
	/** The Draft's values, by key (null where nobody wrote one: WebCraft's own word shows). */
	draft: Record<string, Json>;
	/** What visitors see, by key; null until first published. */
	published: Record<string, Json> | null;
	/** `published` while the Draft says what visitors see, else `draft` (never published) or `changed`. */
	status: "draft" | "published" | "changed";
	/** What keeps the Draft from being published, by path (`fields.heading`). */
	problems: ContentProblem[];
	/** WebCraft's own words in the language: what shows where nobody wrote one. */
	defaults: ConsentWords;
	updatedAt: Date | null;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

/** A change to the words' Draft, in one language (the Site's Default language unless given). */
export type ConsentTextChange = { language?: string; fields: Record<string, unknown> };

/** The banner's words, in a language (the Default language unless given). */
export async function consentText(
	scope: SiteScope,
	row: ConsentBannerRow | undefined,
	language?: string,
): Promise<ConsentText> {
	return toText(row, await textLanguages(scope, language));
}

/**
 * Saves a change to the words' Draft (open the Site with `entry.edit`). Values of the wrong kind are
 * refused (`ConsentBannerInvalidError`); values breaking a rule (too long) are saved and listed in
 * `problems`. Visitors see nothing of it until the words are published.
 */
export async function saveConsentTextDraft(scope: SiteScope, change: ConsentTextChange): Promise<ConsentText> {
	return scope.transaction(async (tx) => {
		const languages = await textLanguages(tx, change.language);
		const row = await lockBanner(tx);
		const problems: ContentProblem[] = [];
		const values = writeFields(
			storedVersion(row.draft).values,
			CONSENT_TEXT_FIELDS,
			change.fields,
			{
				...languages,
				by: { kind: "person", personId: actingPerson(tx.access.actor) },
				problems,
				references: [],
				newRowId: randomRowId,
			},
			"fields.",
			"The Consent banner",
		);
		if (problems.length > 0) throw new ConsentBannerInvalidError(problems);
		const [saved] = await tx.update(
			consentBanners,
			{ draft: { values }, updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor) },
			eq(consentBanners.id, row.id),
		);
		return toText(saved ?? row, languages);
	});
}

/**
 * Publishes the words' Draft, inside `publish`'s transaction: refuses broken rules in any language
 * (`ConsentBannerInvalidError`), and makes a new banner version, which the Consent records made from
 * now on name.
 */
export async function publishConsentText(scope: SiteScope): Promise<Published> {
	const row = await lockBanner(scope);
	const site = await siteLanguages(scope);
	const draft = storedVersion(row.draft);
	const findings = findingsInEveryLanguage(site.languages, site.defaultLanguage, (languages) =>
		textFindings(draft.values, languages),
	);
	if (findings.problems.length > 0) throw new ConsentBannerInvalidError(findings.problems);
	const now = scope.now();
	await scope.update(
		consentBanners,
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now, version: row.version + 1 },
		eq(consentBanners.id, row.id),
	);
	await scope.audit("consentBanner.publish", { version: row.version + 1 });
	return { kind: "consentBanner", id: row.id, publishedAt: now, pathChanges: [] };
}

/**
 * What the banner says on a visitor's page, in its language: the published words, WebCraft's own
 * where nobody wrote one; and the privacy policy link, when its address is set.
 */
export function publishedWords(
	row: ConsentBannerRow | undefined,
	languages: Languages,
	/** Which version: the published words visitors see, or their Draft, as the Staging address shows it. */
	which: "published" | "draft" = "published",
): { words: ConsentWords; privacyPolicy: { href: string; text: string } | null } {
	const defaults = consentWords(languages.language);
	const stored = which === "draft" ? row?.draft : row?.published;
	const values = stored ? readFields(storedVersion(stored).values, CONSENT_TEXT_FIELDS, languages) : {};
	const words = { ...defaults };
	for (const key of CONSENT_TEXT_KEYS) {
		const value = values[key];
		if (key !== "privacyPolicy" && typeof value === "string" && value.trim() !== "") words[key] = value;
	}
	const link = values.privacyPolicy as { url?: unknown; text?: unknown } | null | undefined;
	const href = typeof link?.url === "string" ? link.url.trim() : "";
	const text = typeof link?.text === "string" ? link.text.trim() : "";
	return { words, privacyPolicy: href ? { href, text: text || defaults.privacyPolicy } : null };
}

function textFindings(values: ReturnType<typeof storedVersion>["values"], languages: Languages): Findings {
	const findings: Findings = { problems: [], missing: [], references: [] };
	checkFields(values, CONSENT_TEXT_FIELDS, languages, findings);
	return findings;
}

function toText(row: ConsentBannerRow | undefined, languages: Languages): ConsentText {
	const draft = storedVersion(row?.draft);
	const published = row?.published ? storedVersion(row.published) : null;
	const same = sameJson(draft.values, published?.values ?? {});
	return {
		fields: CONSENT_TEXT_FIELDS,
		language: languages.language,
		draft: readFields(draft.values, CONSENT_TEXT_FIELDS, languages),
		published: published ? readFields(published.values, CONSENT_TEXT_FIELDS, languages) : null,
		status: same ? "published" : published ? "changed" : "draft",
		problems: textFindings(draft.values, languages).problems,
		defaults: consentWords(languages.language),
		updatedAt: row?.updatedAt ?? null,
		publishedAt: row?.publishedAt ?? null,
		lastPublishedAt: row?.lastPublishedAt ?? null,
	};
}

/** The Site's language `language` names (the Default language when absent); `ConsentBannerInvalidError` for one it doesn't have. */
async function textLanguages(scope: Pick<SiteScope, "db" | "site">, language?: string): Promise<Languages> {
	const languages = languagesFor(await siteLanguages(scope), language);
	if (!languages) {
		throw new ConsentBannerInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	}
	return languages;
}
