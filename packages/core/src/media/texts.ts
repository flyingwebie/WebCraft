import type { LanguageValue, Writer } from "../content/values.ts";

/**
 * A Media item's title, alt text and caption, stored per language like Entry values (ADR 0003):
 * `{ values: { alt: { en: { value, by } } } }`. Each is translatable and falls back to the Site's
 * Default language.
 */
export type MediaTexts = { values: Record<string, Record<string, LanguageValue>> };

/** The texts each Media item has, and their longest. */
export const MEDIA_TEXT_MAX_LENGTH = { title: 200, alt: 1000, caption: 2000 } as const;

export type MediaText = keyof typeof MEDIA_TEXT_MAX_LENGTH;

export const MEDIA_TEXTS = Object.keys(MEDIA_TEXT_MAX_LENGTH) as MediaText[];

type Languages = { language: string; defaultLanguage: string };

/** Reads stored texts. */
export function storedTexts(value: unknown): MediaTexts {
	const values = (value as Partial<MediaTexts> | null)?.values;
	return { values: values && typeof values === "object" && !Array.isArray(values) ? values : {} };
}

/** A text in a language, falling back to the Default language; null when there is none. */
export function readText(texts: MediaTexts, key: MediaText, languages: Languages): string | null {
	const byLanguage = texts.values[key] ?? {};
	const value = (byLanguage[languages.language] ?? byLanguage[languages.defaultLanguage])?.value;
	return typeof value === "string" ? value : null;
}

/** Sets a text in a language, or clears it with "". A text that doesn't change keeps its writer. */
export function writeText(texts: MediaTexts, key: MediaText, language: string, value: string, by: Writer): MediaTexts {
	const byLanguage = { ...(texts.values[key] ?? {}) };
	if (value === "") delete byLanguage[language];
	else if (byLanguage[language]?.value !== value) byLanguage[language] = { value, by };
	return { values: { ...texts.values, [key]: byLanguage } };
}
