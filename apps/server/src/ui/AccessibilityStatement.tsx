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
	const [language, setLanguage] = useState(languages.default);
	const [form, setForm] = useState<StatementForm>(initial?.forms[languages.default] ?? blank());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	return (
		<div className="grid max-w-3xl gap-6">
			<p>{t("statement.model")}</p>
			<p className="text-muted-foreground text-sm">{t("statement.languages")}</p>
			<a className="underline underline-offset-4" href="https://eur-lex.europa.eu/eli/dec_impl/2018/1523/oj">
				{t("statement.source")}
			</a>
			{settings ? (
				<div className="grid gap-3 rounded-md border p-4">
					<a
						className="underline underline-offset-4"
						href={`/sites/${siteId}/entries/${settings.postTypeId}/${settings.pageId}?language=${language}`}
					>
						{t("statement.edit")}
					</a>
					<a className="underline underline-offset-4" href={`/builder/${siteId}/component/${settings.componentId}`}>
						{t("statement.component")}
					</a>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={settings.enabled}
							disabled={busy}
							onChange={async (event) => {
								setBusy(true);
								try {
									setSettings(
										(
											await (
												await getApi()
											).accessibilityStatement.setEnabled({ siteId, enabled: event.target.checked })
										).settings,
									);
								} catch (e) {
									setError(t(errorMessage(e)));
								} finally {
									setBusy(false);
								}
							}}
						/>
						{t("statement.enabled")}
					</label>
				</div>
			) : null}
			<form
				className="grid gap-5 rounded-md border p-5"
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
				<p className="text-muted-foreground text-sm">{t("statement.replace")}</p>
				{error ? <p role="alert">{error}</p> : null}
				<p role="status">{saved ? t("statement.saved") : ""}</p>
				<Button type="submit" disabled={busy}>
					{t("statement.generate")}
				</Button>
			</form>
		</div>
	);
}
