import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { useState } from "react";

import { useT } from "../i18n.tsx";
import { controlName } from "./ControlsTab.tsx";
import { type FilterVersion, translatableTexts, withText } from "./model.ts";

/**
 * The Translations tab: every word of the Filter Staff wrote (labels, option and sort names,
 * placeholders, the result count's words) with its value in one of the Site's other languages, kept
 * in the Filter's Draft with it. A word left empty shows as written (in the Default language) on that
 * language's pages; words left to WebCraft are translated already.
 */
export function TranslationsTab({
	version,
	onChange,
	languages,
}: {
	version: FilterVersion;
	onChange(version: FilterVersion): void;
	languages: { default: string; all: readonly string[] };
}) {
	const t = useT();
	const others = languages.all.filter((code) => code !== languages.default);
	const [language, setLanguage] = useState(others[0] ?? "");
	if (others.length === 0)
		return <p className="text-muted-foreground max-w-2xl text-sm">{t("filters.translations.none")}</p>;
	const texts = translatableTexts(version);
	return (
		<div className="grid max-w-3xl gap-6">
			<Field className="max-w-xs">
				<FieldLabel htmlFor="filter-translation-language">{t("filters.translations.language")}</FieldLabel>
				<NativeSelect
					id="filter-translation-language"
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
			<p className="text-muted-foreground text-sm">{t("filters.translations.intro", { language })}</p>
			{texts.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("filters.translations.nothing")}</p>
			) : (
				<ul className="grid gap-4">
					{texts.map((text) => {
						const id = `filter-translation-${text.id}`;
						const control = text.control === null ? null : version.controls[text.control];
						return (
							<li key={text.id}>
								<Field>
									<FieldLabel htmlFor={id}>
										{control
											? t("filters.translations.ofControl", {
													control: controlName(t, control),
													part: t(`filters.translations.parts.${text.part}`),
												})
											: t(`filters.translations.parts.${text.part}`)}
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
										{t("filters.translations.asWritten", { text: text.text.text })}
									</FieldDescription>
								</Field>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
