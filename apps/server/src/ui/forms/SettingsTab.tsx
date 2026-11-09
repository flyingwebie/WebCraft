import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { type FormProblem, type FormVersion, numberOrNull, problemsOf } from "./model.ts";

type FormSummary = { id: string; name: string; key: string };
type PageChoice = { id: string; title: string; path: string | null };

/**
 * The Settings tab: the Form's name (as the admin shows it) and key (as `{{@form <key>}}` writes it),
 * saved at once; and, in the Draft, its button, what visitors see once it is sent (a message in place
 * of the Form, or another Page in their language) and its spam limits.
 */
export function SettingsTab({
	siteId,
	form,
	version,
	onChange,
	pages,
	problems,
}: {
	siteId: string;
	form: FormSummary;
	version: FormVersion;
	onChange: (version: FormVersion) => void;
	pages: readonly PageChoice[];
	problems: readonly FormProblem[];
}) {
	const t = useT();
	const problemAt = (at: string) =>
		problems.find((problem) => problem.at === at || problem.at.startsWith(`${at}.`))?.message;
	const success = version.success;
	const spam = version.spam;
	const setSpam = (key: keyof FormVersion["spam"], value: string) => {
		const number = numberOrNull(value);
		onChange({ ...version, spam: { ...spam, [key]: number ?? 0 } });
	};

	return (
		<div className="grid max-w-3xl gap-8">
			<NameAndKey siteId={siteId} form={form} />
			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("forms.settings.sendingTitle")}</h2>
					</CardTitle>
					<CardDescription>{t("forms.settings.sendingIntro")}</CardDescription>
				</CardHeader>
				<CardContent>
					<FieldGroup>
						<Field data-invalid={problemAt("submitLabel") ? true : undefined}>
							<FieldLabel htmlFor="form-submit-label">{t("forms.settings.submitLabel")}</FieldLabel>
							<Input
								id="form-submit-label"
								value={version.submitLabel.text}
								onChange={(event) =>
									onChange({ ...version, submitLabel: { ...version.submitLabel, text: event.target.value } })
								}
							/>
							{problemAt("submitLabel") ? <FieldError>{problemAt("submitLabel")}</FieldError> : null}
						</Field>
						<fieldset className="grid gap-3">
							<legend className="mb-2 text-sm font-medium">{t("forms.settings.afterSending")}</legend>
							<RadioGroup
								value={success.kind}
								onValueChange={(kind) =>
									onChange({
										...version,
										success:
											kind === "redirect"
												? { kind: "redirect", pageId: pages[0]?.id ?? "" }
												: { kind: "message", message: { text: t("forms.settings.defaultMessage") } },
									})
								}
							>
								<Field orientation="horizontal">
									<RadioGroupItem value="message" id="form-success-message-choice" />
									<FieldLabel htmlFor="form-success-message-choice">{t("forms.settings.showMessage")}</FieldLabel>
								</Field>
								<Field orientation="horizontal">
									<RadioGroupItem value="redirect" id="form-success-redirect-choice" disabled={pages.length === 0} />
									<FieldLabel htmlFor="form-success-redirect-choice">{t("forms.settings.goToPage")}</FieldLabel>
								</Field>
							</RadioGroup>
						</fieldset>
						{success.kind === "message" ? (
							<Field data-invalid={problemAt("success") ? true : undefined}>
								<FieldLabel htmlFor="form-success-message">{t("forms.settings.message")}</FieldLabel>
								<Input
									id="form-success-message"
									value={success.message.text}
									onChange={(event) =>
										onChange({
											...version,
											success: { kind: "message", message: { ...success.message, text: event.target.value } },
										})
									}
								/>
								{problemAt("success") ? <FieldError>{problemAt("success")}</FieldError> : null}
							</Field>
						) : (
							<Field data-invalid={problemAt("success") ? true : undefined}>
								<FieldLabel htmlFor="form-success-page">{t("forms.settings.page")}</FieldLabel>
								<NativeSelect
									id="form-success-page"
									value={success.pageId}
									onChange={(event) =>
										onChange({ ...version, success: { kind: "redirect", pageId: event.target.value } })
									}
								>
									{pages.map((page) => (
										<NativeSelectOption key={page.id} value={page.id}>
											{page.path ? `${page.title} (${page.path})` : page.title}
										</NativeSelectOption>
									))}
								</NativeSelect>
								<FieldDescription>{t("forms.settings.pageHelp")}</FieldDescription>
								{problemAt("success") ? <FieldError>{problemAt("success")}</FieldError> : null}
							</Field>
						)}
					</FieldGroup>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("forms.settings.spamTitle")}</h2>
					</CardTitle>
					<CardDescription>{t("forms.settings.spamIntro")}</CardDescription>
				</CardHeader>
				<CardContent>
					<FieldGroup>
						{(
							[
								["minFillSeconds", "forms.settings.minFillSeconds", "forms.settings.minFillSecondsHelp"],
								["perMinute", "forms.settings.perMinute", "forms.settings.perMinuteHelp"],
								["perHour", "forms.settings.perHour", "forms.settings.perHourHelp"],
							] as const
						).map(([key, label, help]) => (
							<Field key={key} data-invalid={problemAt(`spam.${key}`) ? true : undefined}>
								<FieldLabel htmlFor={`form-spam-${key}`}>{t(label)}</FieldLabel>
								<Input
									id={`form-spam-${key}`}
									type="number"
									inputMode="numeric"
									value={spam[key]}
									onChange={(event) => setSpam(key, event.target.value)}
									aria-describedby={`form-spam-${key}-help`}
								/>
								<FieldDescription id={`form-spam-${key}-help`}>{t(help)}</FieldDescription>
								{problemAt(`spam.${key}`) ? <FieldError>{problemAt(`spam.${key}`)}</FieldError> : null}
							</Field>
						))}
					</FieldGroup>
				</CardContent>
			</Card>
		</div>
	);
}

/** The Form's name and key, saved at once (they aren't part of the Draft). */
function NameAndKey({ siteId, form }: { siteId: string; form: FormSummary }) {
	const t = useT();
	const router = useRouter();
	const [name, setName] = useState(form.name);
	const [key, setKey] = useState(form.key);
	const [problems, setProblems] = useState<FormProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblems([]);
		try {
			const api = await getApi();
			await api.forms.rename({ siteId, formId: form.id, name, key });
			toast.success(t("forms.settings.renamed"));
			await router.invalidate();
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			else toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const problemAt = (at: string) => problems.find((problem) => problem.at === at)?.message;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("forms.settings.nameTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("forms.settings.nameIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={save} className="grid gap-4">
					<FieldGroup>
						<Field data-invalid={problemAt("name") ? true : undefined}>
							<FieldLabel htmlFor="form-name">{t("forms.name")}</FieldLabel>
							<Input id="form-name" value={name} onChange={(event) => setName(event.target.value)} />
							{problemAt("name") ? <FieldError>{problemAt("name")}</FieldError> : null}
						</Field>
						<Field data-invalid={problemAt("key") ? true : undefined}>
							<FieldLabel htmlFor="form-key">{t("forms.key")}</FieldLabel>
							<Input
								id="form-key"
								className="font-mono"
								value={key}
								onChange={(event) => setKey(event.target.value)}
								aria-describedby="form-key-help"
							/>
							<FieldDescription id="form-key-help">{t("forms.keyHelp")}</FieldDescription>
							{problemAt("key") ? <FieldError>{problemAt("key")}</FieldError> : null}
						</Field>
					</FieldGroup>
					<Button type="submit" variant="outline" className="justify-self-start" disabled={busy}>
						{t("forms.settings.rename")}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
