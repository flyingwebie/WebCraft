import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { useState } from "react";

import { useT } from "../i18n.tsx";
import { type FormVersion, translatableTexts, withText } from "./model.ts";

/**
 * The Translations tab: every text of the Form (labels, help, placeholders, options, error messages,
 * its button and its message) with its value in one of the Site's other languages. A text left empty
 * shows as written (in the Default language) on that language's pages.
 */
export function TranslationsTab({
	version,
	onChange,
	languages,
}: {
	version: FormVersion;
	onChange: (version: FormVersion) => void;
	languages: { default: string; all: readonly string[] };
}) {
	const t = useT();
	const others = languages.all.filter((code) => code !== languages.default);
	const [language, setLanguage] = useState(others[0] ?? "");
	if (others.length === 0)
		return <p className="text-muted-foreground max-w-2xl text-sm">{t("forms.translations.none")}</p>;
	const texts = translatableTexts(version);
	return (
		<div className="grid max-w-3xl gap-6">
			<Field className="max-w-xs">
				<FieldLabel htmlFor="form-translation-language">{t("forms.translations.language")}</FieldLabel>
				<NativeSelect
					id="form-translation-language"
					value={language}
					onChange={(event) => setLanguage(event.target.value)}
				>
					{others.map((code) => (
						<NativeSelectOption key={code} value={code}>
							{code}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</Field>
			<p className="text-muted-foreground text-sm">{t("forms.translations.intro", { language })}</p>
			<ul className="grid gap-4">
				{texts.map((text) => {
					const id = `form-translation-${text.id}`;
					return (
						<li key={text.id}>
							<Field>
								<FieldLabel htmlFor={id}>
									{text.field
										? t("forms.translations.ofField", {
												field: text.field,
												part: t(`forms.translations.parts.${text.part}`),
											})
										: t(`forms.translations.parts.${text.part}`)}
								</FieldLabel>
								<Input
									id={id}
									lang={language}
									value={text.text.translations?.[language] ?? ""}
									placeholder={text.text.text}
									aria-describedby={`${id}-written`}
									onChange={(event) => onChange(text.set(version, withText(text.text, language, event.target.value)))}
								/>
								<FieldDescription id={`${id}-written`}>
									{t("forms.translations.asWritten", { text: text.text.text })}
								</FieldDescription>
							</Field>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
