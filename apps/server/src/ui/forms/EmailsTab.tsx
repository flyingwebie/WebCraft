import type { ApiClient } from "@webcraft/api";
import { formTextIn } from "@webcraft/renderer/forms";
import { fillEmailWords, formEmailWords } from "@webcraft/renderer/forms/email-words";
import {
	canRoute,
	FORM_EMAIL_LIMITS,
	type FormAutoReply,
	type FormEmails,
	type FormNotification,
} from "@webcraft/renderer/forms/emails";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { PlusIcon, SaveIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { type FormField, type FormProblem, problemsOf, withText } from "./model.ts";
import { StatusBadge } from "./StatusBadge.tsx";

type Form = Awaited<ReturnType<ApiClient["forms"]["get"]>>["form"];

/**
 * The Emails tab (Content: Staff, Owners and Editors): what each Submission sends. Its Notifications,
 * each to a list of addresses, optionally routed by the answer to a select or radio field, with a
 * subject and an opening text (WebCraft's words when left empty); and the Auto-reply to the visitor,
 * with its subject and text in each of the Site's languages. Changes are kept in the browser until
 * saved to the emails' Draft, and go out once published, apart from the Form's fields.
 */
export function EmailsTab({
	siteId,
	siteName,
	form,
	fields,
	languages,
	onSaved,
}: {
	siteId: string;
	siteName: string;
	form: Form;
	/** The Form's fields (its Draft's), which routing and the Auto-reply read. */
	fields: readonly FormField[];
	languages: { default: string; all: readonly string[] };
	onSaved(): Promise<void>;
}) {
	const t = useT();
	const saved = form.emails.draft as FormEmails;
	const [emails, setEmails] = useState<FormEmails>(saved);
	const attachmentsId = useId();
	const [problems, setProblems] = useState<FormProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const changed = JSON.stringify(emails) !== JSON.stringify(saved);
	const words = formEmailWords(languages.default);

	useEffect(() => {
		if (!changed) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [changed]);

	const save = async (): Promise<boolean> => {
		setBusy(true);
		setProblems([]);
		try {
			const api = await getApi();
			const { form: stored } = await api.forms.saveEmails({ siteId, formId: form.id, emails });
			setEmails(stored.emails.draft as FormEmails);
			await onSaved();
			toast.success(t("formEmails.saved"));
			return true;
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			else toast.error(t(errorMessage(error)));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const publish = async () => {
		if (changed && !(await save())) return;
		setBusy(true);
		try {
			const api = await getApi();
			await api.forms.publishEmails({ siteId, formId: form.id });
			await onSaved();
			toast.success(t("formEmails.published"));
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	const problemsAt = (prefix: string) =>
		problems.filter(
			(problem) => problem.at === prefix || problem.at.startsWith(`${prefix}[`) || problem.at.startsWith(`${prefix}.`),
		);
	const setNotification = (index: number, next: FormNotification | null) =>
		setEmails((current) => ({
			...current,
			notifications:
				next === null
					? current.notifications.filter((_, at) => at !== index)
					: current.notifications.map((notification, at) => (at === index ? next : notification)),
		}));

	return (
		<div className="grid gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge status={form.emails.status} />
					<Badge variant="outline">{t("formEmails.content")}</Badge>
					{changed ? <Badge variant="outline">{t("forms.unsaved")}</Badge> : null}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={() => void save()} disabled={busy || !changed}>
						<SaveIcon data-icon="inline-start" />
						{t("forms.saveDraft")}
					</Button>
					<Button onClick={() => void publish()} disabled={busy || (form.emails.status === "published" && !changed)}>
						<UploadIcon data-icon="inline-start" />
						{t("formEmails.publish")}
					</Button>
				</div>
			</div>
			<p className="text-muted-foreground text-sm">{t("formEmails.intro")}</p>
			{problems.length > 0 ? (
				<div role="alert" className="border-destructive/50 rounded-md border p-4 text-sm">
					<p className="font-medium">{t("formEmails.problems")}</p>
					<ul className="mt-2 list-disc ps-5">
						{problems.map((problem) => (
							<li key={`${problem.at}-${problem.message}`}>
								<span className="font-mono">{problem.at}</span>: {problem.message}
							</li>
						))}
					</ul>
				</div>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("formEmails.notifications.heading")}</h2>
					</CardTitle>
					<CardDescription>{t("formEmails.notifications.intro")}</CardDescription>
					<CardAction>
						<Button
							variant="outline"
							onClick={() =>
								setEmails((current) => ({
									...current,
									notifications: [...current.notifications, { recipients: [], routing: null, subject: "", intro: "" }],
								}))
							}
							disabled={emails.notifications.length >= FORM_EMAIL_LIMITS.notifications}
						>
							<PlusIcon data-icon="inline-start" />
							{t("formEmails.notifications.add")}
						</Button>
					</CardAction>
				</CardHeader>
				<CardContent className="grid gap-6">
					{emails.notifications.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("formEmails.notifications.none")}</p>
					) : null}
					{emails.notifications.map((notification, index) => (
						<NotificationEditor
							// Notifications have no ids; their place in the list is who they are while editing.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above.
							key={index}
							index={index}
							notification={notification}
							fields={fields}
							defaultLanguage={languages.default}
							subjectDefault={fillEmailWords(words.subject, { form: form.name })}
							introDefault={fillEmailWords(words.intro, { form: form.name, site: siteName })}
							problemsAt={problemsAt}
							onChange={(next) => setNotification(index, next)}
						/>
					))}
					{fields.some((field) => field.type === "file") ? (
						<Field data-invalid={problemsAt("attachmentsMaxBytes").length > 0 ? true : undefined}>
							<FieldLabel htmlFor={`${attachmentsId}-attachments`}>{t("forms.uploadAttachments.label")}</FieldLabel>
							<Input
								id={`${attachmentsId}-attachments`}
								type="number"
								inputMode="decimal"
								min={0}
								max={25}
								step={0.5}
								className="max-w-32"
								value={Math.round((emails.attachmentsMaxBytes / (1024 * 1024)) * 10) / 10}
								aria-describedby={`${attachmentsId}-attachments-help`}
								onChange={(event) => {
									const megabytes = Number(event.target.value);
									if (!Number.isFinite(megabytes)) return;
									setEmails((current) => ({
										...current,
										attachmentsMaxBytes: Math.round(Math.max(0, megabytes) * 1024 * 1024),
									}));
								}}
							/>
							<FieldDescription id={`${attachmentsId}-attachments-help`}>
								{t("forms.uploadAttachments.help")}
							</FieldDescription>
							{problemsAt("attachmentsMaxBytes").map((problem) => (
								<FieldError key={problem.message}>{problem.message}</FieldError>
							))}
						</Field>
					) : null}
				</CardContent>
			</Card>

			<AutoReplyEditor
				autoReply={emails.autoReply}
				fields={fields}
				languages={languages}
				problemsAt={problemsAt}
				onChange={(autoReply) => setEmails((current) => ({ ...current, autoReply }))}
			/>
		</div>
	);
}

/** A list of addresses typed one per line (or separated by commas), kept as typed while editing. */
function AddressList({
	id,
	label,
	help,
	value,
	problems,
	onChange,
}: {
	id: string;
	label: string;
	help: string;
	value: readonly string[];
	problems: readonly FormProblem[];
	onChange(addresses: string[]): void;
}) {
	const [text, setText] = useState(value.join("\n"));
	return (
		<Field data-invalid={problems.length > 0 ? true : undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Textarea
				id={id}
				rows={Math.min(Math.max(value.length + 1, 2), 6)}
				value={text}
				spellCheck={false}
				autoComplete="off"
				onChange={(event) => {
					setText(event.target.value);
					onChange(
						event.target.value
							.split(/[\n,;]+/)
							.map((address) => address.trim())
							.filter((address) => address !== ""),
					);
				}}
				aria-invalid={problems.length > 0 ? true : undefined}
				aria-describedby={`${id}-help${problems.length > 0 ? ` ${id}-error` : ""}`}
			/>
			<FieldDescription id={`${id}-help`}>{help}</FieldDescription>
			{problems.length > 0 ? (
				<FieldError id={`${id}-error`}>{problems.map((problem) => problem.message).join(" ")}</FieldError>
			) : null}
		</Field>
	);
}

function NotificationEditor({
	index,
	notification,
	fields,
	defaultLanguage,
	subjectDefault,
	introDefault,
	problemsAt,
	onChange,
}: {
	index: number;
	notification: FormNotification;
	fields: readonly FormField[];
	defaultLanguage: string;
	subjectDefault: string;
	introDefault: string;
	problemsAt(prefix: string): FormProblem[];
	onChange(next: FormNotification | null): void;
}) {
	const t = useT();
	const id = useId();
	const at = `notifications[${index}]`;
	const choiceFields = fields.filter(canRoute);
	const routingField = choiceFields.find((field) => field.key === notification.routing?.field);
	const number = index + 1;
	const recipientsAt = problemsAt(`${at}.recipients`);
	const subjectProblems = problemsAt(`${at}.subject`);
	const fieldLabel = (field: FormField) => formTextIn(field.label, defaultLanguage);

	return (
		<fieldset className="grid gap-5 rounded-lg border p-4">
			<legend className="px-1 text-sm font-semibold">{t("formEmails.notifications.title", { number })}</legend>
			<AddressList
				id={`${id}-recipients`}
				label={t("formEmails.notifications.recipients")}
				help={t("formEmails.notifications.recipientsHelp", { max: FORM_EMAIL_LIMITS.recipients })}
				value={notification.recipients}
				problems={recipientsAt}
				onChange={(recipients) => onChange({ ...notification, recipients })}
			/>
			<Field>
				<FieldLabel htmlFor={`${id}-routing`}>{t("formEmails.notifications.routing")}</FieldLabel>
				<NativeSelect
					id={`${id}-routing`}
					value={notification.routing?.field ?? ""}
					onChange={(event) =>
						onChange({
							...notification,
							routing: event.target.value === "" ? null : { field: event.target.value, routes: [] },
						})
					}
					aria-describedby={`${id}-routing-help`}
				>
					<NativeSelectOption value="">{t("formEmails.notifications.routingNone")}</NativeSelectOption>
					{choiceFields.map((field) => (
						<NativeSelectOption key={field.key} value={field.key}>
							{fieldLabel(field)}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<FieldDescription id={`${id}-routing-help`}>
					{choiceFields.length === 0
						? t("formEmails.notifications.routingNoField")
						: t("formEmails.notifications.routingHelp")}
				</FieldDescription>
			</Field>
			{routingField && notification.routing ? (
				<FieldGroup className="gap-4 border-s-2 ps-4">
					{routingField.options.map((option) => {
						const routes = notification.routing?.routes ?? [];
						const routeIndex = routes.findIndex((route) => route.value === option.value);
						const route = routes[routeIndex];
						return (
							<AddressList
								key={option.value}
								id={`${id}-route-${option.value}`}
								label={t("formEmails.notifications.routeFor", {
									field: fieldLabel(routingField),
									option: formTextIn(option.label, defaultLanguage),
								})}
								help={t("formEmails.notifications.routeHelp")}
								value={route?.recipients ?? []}
								problems={routeIndex >= 0 ? problemsAt(`${at}.routing.routes[${routeIndex}]`) : []}
								onChange={(recipients) => {
									const others = routes.filter((each) => each.value !== option.value);
									const next = recipients.length > 0 ? [...others, { value: option.value, recipients }] : others;
									const ordered = routingField.options.flatMap((each) =>
										next.filter((candidate) => candidate.value === each.value),
									);
									onChange({ ...notification, routing: { field: routingField.key, routes: ordered } });
								}}
							/>
						);
					})}
				</FieldGroup>
			) : null}
			<Field data-invalid={subjectProblems.length > 0 ? true : undefined}>
				<FieldLabel htmlFor={`${id}-subject`}>{t("formEmails.notifications.subject")}</FieldLabel>
				<Input
					id={`${id}-subject`}
					value={notification.subject}
					maxLength={FORM_EMAIL_LIMITS.subjectLength}
					placeholder={subjectDefault}
					onChange={(event) => onChange({ ...notification, subject: event.target.value.replace(/[\r\n]+/g, " ") })}
					aria-invalid={subjectProblems.length > 0 ? true : undefined}
					aria-describedby={`${id}-subject-help`}
				/>
				<FieldDescription id={`${id}-subject-help`}>
					{t("formEmails.leaveEmpty", { example: subjectDefault })}
				</FieldDescription>
			</Field>
			<Field>
				<FieldLabel htmlFor={`${id}-intro`}>{t("formEmails.notifications.intro2")}</FieldLabel>
				<Textarea
					id={`${id}-intro`}
					rows={3}
					value={notification.intro}
					maxLength={FORM_EMAIL_LIMITS.introLength}
					placeholder={introDefault}
					onChange={(event) => onChange({ ...notification, intro: event.target.value })}
					aria-describedby={`${id}-intro-help`}
				/>
				<FieldDescription id={`${id}-intro-help`}>{t("formEmails.notifications.introHelp")}</FieldDescription>
			</Field>
			<div>
				<Button variant="outline" size="sm" onClick={() => onChange(null)}>
					<TrashIcon data-icon="inline-start" />
					{t("formEmails.notifications.remove", { number })}
				</Button>
			</div>
		</fieldset>
	);
}

function AutoReplyEditor({
	autoReply,
	fields,
	languages,
	problemsAt,
	onChange,
}: {
	autoReply: FormAutoReply;
	fields: readonly FormField[];
	languages: { default: string; all: readonly string[] };
	problemsAt(prefix: string): FormProblem[];
	onChange(next: FormAutoReply): void;
}) {
	const t = useT();
	const id = useId();
	const emailFields = fields.filter((field) => field.type === "email");
	const ordered = [languages.default, ...languages.all.filter((code) => code !== languages.default)];
	const fieldProblems = problemsAt("autoReply.field");

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("formEmails.autoReply.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("formEmails.autoReply.intro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-5">
				<Field orientation="horizontal">
					<Checkbox
						id={`${id}-enabled`}
						checked={autoReply.enabled}
						onCheckedChange={(checked) => onChange({ ...autoReply, enabled: checked === true })}
					/>
					<FieldLabel htmlFor={`${id}-enabled`}>{t("formEmails.autoReply.enabled")}</FieldLabel>
				</Field>
				<Field data-invalid={fieldProblems.length > 0 ? true : undefined}>
					<FieldLabel htmlFor={`${id}-field`}>{t("formEmails.autoReply.field")}</FieldLabel>
					<NativeSelect
						id={`${id}-field`}
						value={autoReply.field ?? ""}
						onChange={(event) =>
							onChange({ ...autoReply, field: event.target.value === "" ? null : event.target.value })
						}
						aria-invalid={fieldProblems.length > 0 ? true : undefined}
						aria-describedby={`${id}-field-help`}
					>
						<NativeSelectOption value="">{t("formEmails.autoReply.firstEmailField")}</NativeSelectOption>
						{emailFields.map((field) => (
							<NativeSelectOption key={field.key} value={field.key}>
								{formTextIn(field.label, languages.default)}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<FieldDescription id={`${id}-field-help`}>
						{emailFields.length === 0 ? t("formEmails.autoReply.noEmailField") : t("formEmails.autoReply.fieldHelp")}
					</FieldDescription>
					{fieldProblems.length > 0 ? (
						<FieldError>{fieldProblems.map((problem) => problem.message).join(" ")}</FieldError>
					) : null}
				</Field>
				{ordered.map((language) => {
					const translated = language === languages.default ? null : language;
					const valueIn = (text: FormAutoReply["subject"]) =>
						translated === null ? text.text : (text.translations?.[translated] ?? "");
					const subjectProblems = translated === null ? problemsAt("autoReply.subject") : [];
					const textProblems = translated === null ? problemsAt("autoReply.text") : [];
					return (
						<fieldset key={language} className="grid gap-4 rounded-lg border p-4">
							<legend className="px-1 text-sm font-semibold">
								{translated === null
									? t("formEmails.autoReply.inDefault", { language: languageName(language) })
									: t("formEmails.autoReply.inLanguage", { language: languageName(language) })}
							</legend>
							<Field data-invalid={subjectProblems.length > 0 ? true : undefined}>
								<FieldLabel htmlFor={`${id}-subject-${language}`}>{t("formEmails.autoReply.subject")}</FieldLabel>
								<Input
									id={`${id}-subject-${language}`}
									lang={language}
									value={valueIn(autoReply.subject)}
									maxLength={FORM_EMAIL_LIMITS.subjectLength}
									onChange={(event) =>
										onChange({
											...autoReply,
											subject: withText(autoReply.subject, translated, event.target.value.replace(/[\r\n]+/g, " ")),
										})
									}
									aria-invalid={subjectProblems.length > 0 ? true : undefined}
								/>
								{subjectProblems.length > 0 ? (
									<FieldError>{subjectProblems.map((problem) => problem.message).join(" ")}</FieldError>
								) : null}
							</Field>
							<Field data-invalid={textProblems.length > 0 ? true : undefined}>
								<FieldLabel htmlFor={`${id}-text-${language}`}>{t("formEmails.autoReply.text")}</FieldLabel>
								<Textarea
									id={`${id}-text-${language}`}
									lang={language}
									rows={5}
									value={valueIn(autoReply.text)}
									maxLength={FORM_EMAIL_LIMITS.autoReplyTextLength}
									onChange={(event) =>
										onChange({ ...autoReply, text: withText(autoReply.text, translated, event.target.value) })
									}
									aria-invalid={textProblems.length > 0 ? true : undefined}
									aria-describedby={`${id}-text-${language}-help`}
								/>
								<FieldDescription id={`${id}-text-${language}-help`}>
									{translated === null ? t("formEmails.autoReply.textHelp") : t("formEmails.autoReply.translationHelp")}
								</FieldDescription>
								{textProblems.length > 0 ? (
									<FieldError>{textProblems.map((problem) => problem.message).join(" ")}</FieldError>
								) : null}
							</Field>
						</fieldset>
					);
				})}
			</CardContent>
		</Card>
	);
}
