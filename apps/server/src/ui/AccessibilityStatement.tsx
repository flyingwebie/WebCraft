import type { StatementForm, StatementSettings } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useId, useState } from "react";
import { getApi } from "./api.ts";
import { errorMessage } from "./errors.ts";
import { useT } from "./i18n.tsx";
import { useSettingsSection } from "./settings/form.tsx";
import { SettingsCard, SettingsRow, SettingsRows, Switch } from "./settings/layout.tsx";

const FIELDS = [
	"organisation",
	"website",
	"standard",
	"limitations",
	"burden",
	"excluded",
	"alternatives",
	"preparedOn",
	"reviewedOn",
	"method",
	"feedback",
	"feedbackUrl",
	"enforcement",
	"enforcementUrl",
] as const;
const blank = () => ({ ...Object.fromEntries(FIELDS.map((key) => [key, ""])), status: "notAssessed" }) as StatementForm;
export function AccessibilityStatement({
	siteId,
	languages,
	settings: initial,
}: {
	siteId: string;
	languages: { default: string; all: readonly string[] };
	settings: StatementSettings | null;
}) {
	const t = useT();
	const id = useId();
	const [settings, setSettings] = useState(initial);
	// The route loaded again (after a save): show what it answered.
	const [loaded, setLoaded] = useState(initial);
	if (loaded !== initial) {
		setLoaded(initial);
		setSettings(initial);
	}
	const [language, setLanguage] = useState(languages.default);
	const [form, setForm] = useState<StatementForm>(initial?.forms[languages.default] ?? blank());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	return (
		<div className="grid gap-6">
			<SettingsCard title={t("statement.aboutTitle")} description={t("statement.model")}>
				<p className="text-muted-foreground text-sm">{t("statement.languages")}</p>
				<a className="w-fit underline underline-offset-4" href="https://eur-lex.europa.eu/eli/dec_impl/2018/1523/oj">
					{t("statement.source")}
				</a>
			</SettingsCard>
			{settings ? <StatementPage siteId={siteId} settings={settings} language={language} /> : null}
			<SettingsCard title={t("statement.formTitle")} description={t("statement.replace")}>
				<form
					className="grid gap-5"
					onSubmit={async (event) => {
						event.preventDefault();
						setBusy(true);
						setError(null);
						setSaved(false);
						try {
							const result = await (await getApi()).accessibilityStatement.generate({ siteId, language, ...form });
							setSettings(result.settings);
							setSaved(true);
						} catch (e) {
							setError(t(errorMessage(e)));
						} finally {
							setBusy(false);
						}
					}}
				>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-language`}>{t("statement.language")}</Label>
						<NativeSelect
							disabled={busy}
							id={`${id}-language`}
							value={language}
							onChange={(e) => {
								setLanguage(e.target.value);
								setForm(settings?.forms[e.target.value] ?? blank());
								setSaved(false);
							}}
						>
							{languages.all.map((code) => (
								<NativeSelectOption key={code} value={code}>
									{code}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-status`}>{t("statement.status")}</Label>
						<NativeSelect
							disabled={busy}
							id={`${id}-status`}
							value={form.status}
							onChange={(e) => setForm({ ...form, status: e.target.value as StatementForm["status"] })}
						>
							{(["notAssessed", "full", "partial", "notCompliant"] as const).map((status) => (
								<NativeSelectOption key={status} value={status}>
									{t(`statement.statuses.${status}`)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					{FIELDS.map((key) => (
						<div key={key} className="grid gap-2 text-sm font-medium">
							<Label htmlFor={`${id}-${key}`}>{t(`statement.fields.${key}`)}</Label>
							{["limitations", "burden", "excluded", "alternatives", "method", "feedback", "enforcement"].includes(
								key,
							) ? (
								<Textarea
									disabled={busy}
									id={`${id}-${key}`}
									required
									maxLength={5000}
									value={form[key]}
									onChange={(e) => setForm({ ...form, [key]: e.target.value })}
								/>
							) : (
								<Input
									disabled={busy}
									id={`${id}-${key}`}
									required
									type={key.endsWith("On") ? "date" : key === "website" || key === "enforcementUrl" ? "url" : "text"}
									maxLength={key.endsWith("Url") || key === "website" ? 2000 : 5000}
									value={form[key]}
									onChange={(e) => setForm({ ...form, [key]: e.target.value })}
								/>
							)}
						</div>
					))}
					{error ? <p role="alert">{error}</p> : null}
					<p role="status">{saved ? t("statement.saved") : ""}</p>
					<Button type="submit" variant="outline" className="justify-self-start" disabled={busy}>
						{t("statement.generate")}
					</Button>
				</form>
			</SettingsCard>
		</div>
	);
}

/** The statement's Page and Component, and whether the footer links the Page (saved with the foot bar). */
function StatementPage({
	siteId,
	settings,
	language,
}: {
	siteId: string;
	settings: StatementSettings;
	language: string;
}) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: { enabled: settings.enabled },
		save: async ({ enabled }) => (await getApi()).accessibilityStatement.setEnabled({ siteId, enabled }),
	});
	return (
		<SettingsCard title={t("statement.pageTitle")}>
			<div className="flex flex-wrap gap-x-6 gap-y-2">
				<a
					className="underline underline-offset-4"
					href={`/sites/${siteId}/entries/${settings.postTypeId}/${settings.pageId}?language=${language}`}
				>
					{t("statement.edit")}
				</a>
				<a className="underline underline-offset-4" href={`/builder/${siteId}/component/${settings.componentId}`}>
					{t("statement.component")}
				</a>
			</div>
			<SettingsRows>
				<SettingsRow label={t("statement.enabled")} htmlFor={`${id}-enabled`}>
					<Switch
						id={`${id}-enabled`}
						checked={section.values.enabled}
						onCheckedChange={(enabled) => section.set({ enabled })}
					/>
				</SettingsRow>
			</SettingsRows>
			{section.error ? <p role="alert">{t(section.error)}</p> : null}
		</SettingsCard>
	);
}
