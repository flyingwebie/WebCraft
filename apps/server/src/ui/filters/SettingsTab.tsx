import { filterWords } from "@webcraft/renderer/filters/words";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";

import { useT } from "../i18n.tsx";
import { SettingsCard, SettingsRow, SettingsRows } from "../settings/layout.tsx";
import { type FilterProblem, type FilterVersion, optionalText } from "./model.ts";

/**
 * The Settings tab: what never changes (the Filter's name, as Template markup places it, and the
 * query Loop it narrows) and the Filter's own words: its name for screen readers (also its drawer's
 * title and button) and its Apply button's, each showing WebCraft's words while empty.
 */
export function SettingsTab({
	name,
	loop,
	markup,
	version,
	onChange,
	language,
	problems,
}: {
	name: string;
	loop: string;
	markup: string;
	version: FilterVersion;
	onChange(version: FilterVersion): void;
	/** The Site's Default language, which WebCraft's own words show in. */
	language: string;
	problems: readonly FilterProblem[];
}) {
	const t = useT();
	const words = filterWords(language);
	const problemAt = (at: string) => problems.find((problem) => problem.at === at)?.message;
	return (
		<div className="grid max-w-2xl gap-6">
			<SettingsCard title={t("filters.settings.about")} description={t("filters.settings.neverChange")}>
				<SettingsRows>
					<SettingsRow label={t("filters.settings.name")}>
						<span className="font-mono text-sm">{name}</span>
					</SettingsRow>
					<SettingsRow label={t("filters.settings.loop")}>
						<span className="font-mono text-sm">{loop}</span>
					</SettingsRow>
					<SettingsRow label={t("filters.settings.markup")}>
						<code className="font-mono text-xs break-all">{markup}</code>
					</SettingsRow>
				</SettingsRows>
			</SettingsCard>
			<SettingsCard title={t("filters.settings.words")} description={t("filters.settings.wordsIntro")}>
				<FieldGroup>
					{(
						[
							["label", "filters.settings.filterLabel", "filters.settings.filterLabelHelp", words.filters],
							["applyLabel", "filters.settings.applyLabel", "filters.settings.applyLabelHelp", words.apply],
						] as const
					).map(([part, label, help, fallback]) => (
						<Field key={part} data-invalid={problemAt(part) ? true : undefined}>
							<FieldLabel htmlFor={`filter-${part}`}>{t(label)}</FieldLabel>
							<Input
								id={`filter-${part}`}
								value={version[part]?.text ?? ""}
								placeholder={fallback}
								aria-describedby={`filter-${part}-help`}
								onChange={(event) => onChange({ ...version, [part]: optionalText(version[part], event.target.value) })}
							/>
							<FieldDescription id={`filter-${part}-help`}>
								{t(help)} {t("filters.settings.webcraftWords", { words: fallback })}
							</FieldDescription>
							{problemAt(part) ? <FieldError>{problemAt(part)}</FieldError> : null}
						</Field>
					))}
				</FieldGroup>
			</SettingsCard>
		</div>
	);
}
