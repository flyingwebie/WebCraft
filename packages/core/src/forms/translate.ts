import type { FormText, FormVersion } from "@webcraft/renderer/forms";

/**
 * Every text of a Form's version that a translation can give, in one order: each item's label, then
 * its help, placeholder and error message when it has them, then its options; the button's words;
 * the message shown once it is sent. The admin's Translations tab and the building area's list the
 * same texts (`translatableTexts` in the admin's Forms model).
 */
function mapTexts(version: FormVersion, change: (text: FormText) => FormText): FormVersion {
	const fields = version.fields.map((field) => {
		const next = { ...field, label: change(field.label) };
		for (const part of ["help", "placeholder", "message"] as const) {
			const value = field[part];
			if (value) next[part] = change(value);
		}
		next.options = field.options.map((option) => ({ ...option, label: change(option.label) }));
		return next;
	});
	return {
		...version,
		fields,
		submitLabel: change(version.submitLabel),
		success:
			version.success.kind === "message"
				? { kind: "message", message: change(version.success.message) }
				: version.success,
	};
}

/** Whether a text has words as written and none in `language`. */
function missingIn(text: FormText, language: string): boolean {
	return text.text.trim() !== "" && !text.translations?.[language]?.trim();
}

/**
 * A Form's version with every text missing in `language` translated by `translate` (one call, with
 * the texts as written, answering them in the same order); the texts it already has stay as they
 * are. Answers how many were filled.
 */
export async function withMissingTranslations(
	version: FormVersion,
	language: string,
	translate: (texts: readonly string[]) => Promise<readonly string[]>,
): Promise<{ version: FormVersion; filled: number }> {
	const missing: string[] = [];
	mapTexts(version, (text) => {
		if (missingIn(text, language)) missing.push(text.text);
		return text;
	});
	if (missing.length === 0) return { version, filled: 0 };
	const answers = await translate(missing);
	let at = 0;
	const next = mapTexts(version, (text) => {
		if (!missingIn(text, language)) return text;
		const answer = answers[at++]?.trim();
		return answer ? { text: text.text, translations: { ...(text.translations ?? {}), [language]: answer } } : text;
	});
	return { version: next, filled: missing.length };
}
