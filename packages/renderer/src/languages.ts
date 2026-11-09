/**
 * Language tags, and fixed text with a value per language. A text node of an element tree keeps its
 * text as written and, optionally, its text in other languages (`translations`, by BCP 47 tag): a page
 * in one of them shows that, every other page the text as written. Templates, Components and Forms
 * all hold fixed text this way.
 */

/** A language tag WebCraft keeps: a language, with an optional script and region (`zh-Hant`, `pt-BR`, `es-419`). */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** A BCP 47 tag in its canonical form (`PT-br` gives `pt-BR`), or undefined when it isn't one WebCraft keeps. */
export function canonicalLanguage(input: string): string | undefined {
	let canonical: string | undefined;
	try {
		[canonical] = Intl.getCanonicalLocales(input.trim());
	} catch {
		return undefined;
	}
	return canonical && LANGUAGE_TAG.test(canonical) ? canonical : undefined;
}

/** Fixed text in other languages than the one it is written in, by language tag. */
export type Translations = Record<string, string>;

/** Fixed text in a language: its own text there, else the text as written. */
export function textIn(node: { text: string; translations?: Translations }, language: string | undefined): string {
	return (language !== undefined && node.translations?.[language]) || node.text;
}

/** The message for a language tag WebCraft doesn't keep. */
export function languageTagMessage(tag: string): string {
	return `${tag} isn't a language tag: write one such as fr or pt-BR.`;
}
