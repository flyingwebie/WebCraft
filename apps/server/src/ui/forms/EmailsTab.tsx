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
import { Button } from "@webcraft/ui/components/button.tsx";
import { FieldDescription, FieldError } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { LockIcon, PlusIcon, SaveIcon, TrashIcon, UploadIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { HistoryLink } from "../history/HistoryLink.tsx";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { SettingsCard, StateBadge, Switch } from "../settings/layout.tsx";
import { type FormField, type FormProblem, problemsOf, withText } from "./model.ts";

type Form = Awaited<ReturnType<ApiClient["forms"]["get"]>>["form"];

/**
 * The Emails tab (Content: Staff, Owners and Editors), frame 03: what each Submission sends. Its
 * Notifications as cards (up to ten), each to a list of addresses, optionally routed by the answer to
 * a select or radio field, with a subject and an opening line (WebCraft's words when left empty); and
 * the Auto-reply to the visitor (on or off, which email field it answers), with its subject and text
 * in each of the Site's languages. Emails are Content and publish apart from the Form's fields: while
 * the tab shows, the page header holds their state ("Draft · 1 change") and Publish emails
 * (`actionsSlot`). Changes are kept in the browser until saved to the emails' Draft (Save draft, or
 * Publish emails, which saves first). A save that changes who receives Submissions is a Sensitive
 * action: the person confirms who they are first.
 */
export function EmailsTab({
	siteId,
	siteName,
	form,
	fields,
	languages,
	onSaved,
	active,
	actionsSlot,
}: {
	siteId: string;
	siteName: string;
	form: Form;
	/** The Form's fields (its Draft's), which routing and the Auto-reply read. */
	fields: readonly FormField[];
	languages: { default: string; all: readonly string[] };
	onSaved(): Promise<void>;
	/** Whether the tab shows now: its state and Publish emails are in the page header then. */
	active: boolean;
	/** Where in the page header the emails' state and actions go. */
	actionsSlot: HTMLElement | null;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const saved = form.emails.draft as FormEmails;
	const published = form.emails.published as FormEmails | null;
	const [emails, setEmails] = useState<FormEmails>(saved);
	const attachmentsId = useId();
	const [problems, setProblems] = useState<FormProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const changed = JSON.stringify(emails) !== JSON.stringify(saved);
	const words = formEmailWords(languages.default);
	const changes = published ? changesBetween(published, emails) : null;

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
			const { form: stored } = await runSensitive(() => api.forms.saveEmails({ siteId, formId: form.id, emails }));
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
	const full = emails.notifications.length >= FORM_EMAIL_LIMITS.notifications;

	const actions = (
		<>
			{changes === null ? (
				<StateBadge tone="warning">{t("formEmails.state.neverPublished")}</StateBadge>
			) : changes === 0 ? (
				<StateBadge tone="success">{t("formEmails.state.published")}</StateBadge>
			) : (
				<StateBadge tone="warning">{t("formEmails.state.changes", { count: changes })}</StateBadge>
			)}
			{changed ? <StateBadge>{t("forms.unsaved")}</StateBadge> : null}
			<HistoryLink siteId={siteId} item={{ kind: "formEmails", id: form.id }} emails />
			{changed ? (
				<Button variant="outline" onClick={() => void save()} disabled={busy}>
					<SaveIcon data-icon="inline-start" />
					{t("forms.saveDraft")}
				</Button>
			) : null}
			<Button onClick={() => void publish()} disabled={busy || (form.emails.status === "published" && !changed)}>
				<UploadIcon data-icon="inline-start" />
				{t("formEmails.publish")}
			</Button>
		</>
	);

	return (
		<div className="grid max-w-180 gap-3">
			{active && actionsSlot ? createPortal(actions, actionsSlot) : null}
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

			<SettingsCard title={t("formEmails.notifications.heading")}>
				{emails.notifications.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("formEmails.notifications.none")}</p>
				) : null}
				{emails.notifications.map((notification, index) => (
					<NotificationCard
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
				<div className="flex flex-wrap items-center gap-2.5">
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							setEmails((current) => ({
								...current,
								notifications: [...current.notifications, { recipients: [], routing: null, subject: "", intro: "" }],
							}))
						}
						disabled={full}
						aria-describedby={`${attachmentsId}-most`}
					>
						<PlusIcon data-icon="inline-start" />
						{t("formEmails.notifications.add")}
					</Button>
					<span id={`${attachmentsId}-most`} className="text-muted-foreground text-xs">
						{t("formEmails.notifications.upToTen")}
					</span>
				</div>
				{fields.some((field) => field.type === "file") ? (
					<KeyValue
						id={`${attachmentsId}-attachments`}
						label={t("forms.uploadAttachments.label")}
						help={t("forms.uploadAttachments.help")}
						problems={problemsAt("attachmentsMaxBytes")}
					>
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
					</KeyValue>
				) : null}
			</SettingsCard>

			<AutoReplyCard
				autoReply={emails.autoReply}
				fields={fields}
				languages={languages}
				problemsAt={problemsAt}
				onChange={(autoReply) => setEmails((current) => ({ ...current, autoReply }))}
			/>
		</div>
	);
}

/**
 * How many parts of the emails differ from what is published: each Notification (added, removed or
 * changed), the Auto-reply, and how much a Notification attaches.
 */
function changesBetween(published: FormEmails, draft: FormEmails): number {
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	let count = 0;
	const most = Math.max(published.notifications.length, draft.notifications.length);
	for (let at = 0; at < most; at++) {
		if (!same(published.notifications[at], draft.notifications[at])) count++;
	}
	if (!same(published.autoReply, draft.autoReply)) count++;
	if (published.attachmentsMaxBytes !== draft.attachmentsMaxBytes) count++;
	return count;
}

/** A label on the left and its control on the right (Subject, Opening line), with its help and problems. */
function KeyValue({
	id,
	label,
	help,
	problems = [],
	children,
}: {
	id: string;
	label: string;
	help?: string;
	problems?: readonly FormProblem[];
	children: ReactNode;
}) {
	return (
		<div
			className="grid gap-1.5 @lg/card:grid-cols-[9rem_minmax(0,1fr)] @lg/card:items-start @lg/card:gap-x-4"
			data-invalid={problems.length > 0 ? true : undefined}
		>
			<label htmlFor={id} className="text-muted-foreground pt-2 text-sm">
				{label}
			</label>
			<div className="grid min-w-0 gap-1.5">
				{children}
				{help ? (
					<FieldDescription id={`${id}-help`} className="sr-only">
						{help}
					</FieldDescription>
				) : null}
				{problems.length > 0 ? (
					<FieldError id={`${id}-error`}>{problems.map((problem) => problem.message).join(" ")}</FieldError>
				) : null}
			</div>
		</div>
	);
}

/**
 * A list of addresses as chips: type one and press Enter (or a comma), paste several at once, remove
 * one with its ×, or Backspace in the empty box to remove the last.
 */
function Recipients({
	id,
	label,
	visibleLabel = false,
	help,
	value,
	problems,
	onChange,
}: {
	id: string;
	label: string;
	/** Whether the label shows over the chips (a route's), or is only said (the Notification's own). */
	visibleLabel?: boolean;
	help?: string;
	value: readonly string[];
	problems: readonly FormProblem[];
	onChange(addresses: string[]): void;
}) {
	const t = useT();
	const [text, setText] = useState("");
	const box = useRef<HTMLInputElement>(null);
	const add = (typed: string) => {
		const addresses = typed
			.split(/[\s,;]+/)
			.map((address) => address.trim())
			.filter((address) => address !== "" && !value.includes(address));
		if (addresses.length > 0) onChange([...value, ...new Set(addresses)]);
		setText("");
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" || event.key === "," || event.key === ";") {
			if (text.trim() === "") return;
			event.preventDefault();
			add(text);
		} else if (event.key === "Backspace" && text === "" && value.length > 0) {
			onChange(value.slice(0, -1));
		}
	};
	const described = [help ? `${id}-help` : null, problems.length > 0 ? `${id}-error` : null].filter(Boolean).join(" ");
	return (
		<div className="grid gap-1.5" data-invalid={problems.length > 0 ? true : undefined}>
			<label htmlFor={id} className={visibleLabel ? "text-muted-foreground text-sm" : "sr-only"}>
				{label}
			</label>
			{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click on the box's empty part puts the caret in its text box, which the keyboard reaches on its own. */}
			<div
				className="border-input dark:bg-input/30 focus-within:border-ring aria-invalid:border-destructive flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-1.5 py-1"
				aria-invalid={problems.length > 0 ? true : undefined}
				onClick={(event) => {
					if (event.target === event.currentTarget) box.current?.focus();
				}}
			>
				{value.map((address) => (
					<span
						key={address}
						className="bg-muted inline-flex h-7 max-w-full items-center gap-1 rounded-full ps-2.5 pe-1 text-[13px]"
					>
						<span className="truncate">{address}</span>
						<button
							type="button"
							className="hover:bg-background focus-visible:ring-ring/50 grid size-5 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-3"
							aria-label={t("formEmails.recipients.remove", { address })}
							onClick={() => onChange(value.filter((each) => each !== address))}
						>
							<XIcon className="size-3.5" aria-hidden="true" />
						</button>
					</span>
				))}
				<input
					ref={box}
					id={id}
					type="text"
					inputMode="email"
					className="placeholder:text-muted-foreground focus-visible:ring-ring/50 h-7 min-w-40 flex-1 rounded-sm bg-transparent px-1 text-sm outline-none focus-visible:ring-3"
					value={text}
					spellCheck={false}
					autoComplete="off"
					placeholder={t("formEmails.recipients.add")}
					maxLength={FORM_EMAIL_LIMITS.addressLength * 2}
					onChange={(event) => {
						const typed = event.target.value;
						// Pasting a list adds each address at once.
						if (/[\s,;]/.test(typed.trim())) add(typed);
						else setText(typed);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => {
						if (text.trim() !== "") add(text);
					}}
					aria-invalid={problems.length > 0 ? true : undefined}
					aria-describedby={described || undefined}
				/>
			</div>
			{help ? (
				<FieldDescription id={`${id}-help`} className="sr-only">
					{help}
				</FieldDescription>
			) : null}
			{problems.length > 0 ? (
				<FieldError id={`${id}-error`}>{problems.map((problem) => problem.message).join(" ")}</FieldError>
			) : null}
		</div>
	);
}

function NotificationCard({
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
	const fieldLabel = (field: FormField) => formTextIn(field.label, defaultLanguage);

	return (
		<section aria-labelledby={`${id}-title`} className="@container/card grid gap-2.5 rounded-[10px] border p-3.5">
			<h3 id={`${id}-title`} className="sr-only">
				{t("formEmails.notifications.title", { number })}
			</h3>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<Recipients
						id={`${id}-recipients`}
						label={t("formEmails.notifications.recipients")}
						help={t("formEmails.notifications.recipientsHelp", { max: FORM_EMAIL_LIMITS.recipients })}
						value={notification.recipients}
						problems={problemsAt(`${at}.recipients`)}
						onChange={(recipients) => onChange({ ...notification, recipients })}
					/>
				</div>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t("formEmails.notifications.remove", { number })}
					onClick={() => onChange(null)}
				>
					<TrashIcon aria-hidden="true" />
				</Button>
			</div>
			<p className="text-muted-foreground flex items-center gap-1.5 text-xs">
				<LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
				{t("formEmails.recipients.password")}
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={`${id}-routing`} className="text-muted-foreground text-sm">
					{t("formEmails.notifications.routing")}
				</label>
				<NativeSelect
					id={`${id}-routing`}
					size="sm"
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
				<p
					id={`${id}-routing-help`}
					className={choiceFields.length === 0 ? "text-muted-foreground w-full text-xs" : "sr-only"}
				>
					{choiceFields.length === 0
						? t("formEmails.notifications.routingNoField")
						: t("formEmails.notifications.routingHelp")}
				</p>
			</div>
			{routingField && notification.routing ? (
				<div className="grid gap-3 border-s-2 ps-3">
					{routingField.options.map((option) => {
						const routes = notification.routing?.routes ?? [];
						const routeIndex = routes.findIndex((route) => route.value === option.value);
						const route = routes[routeIndex];
						return (
							<Recipients
								key={option.value}
								id={`${id}-route-${option.value}`}
								visibleLabel
								label={t("formEmails.notifications.routeFor", {
									field: fieldLabel(routingField),
									option: formTextIn(option.label, defaultLanguage),
								})}
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
					<p className="text-muted-foreground text-xs">{t("formEmails.notifications.routeHelp")}</p>
				</div>
			) : null}
			<KeyValue
				id={`${id}-subject`}
				label={t("formEmails.notifications.subject")}
				help={t("formEmails.leaveEmpty", { example: subjectDefault })}
				problems={problemsAt(`${at}.subject`)}
			>
				<Input
					id={`${id}-subject`}
					value={notification.subject}
					maxLength={FORM_EMAIL_LIMITS.subjectLength}
					placeholder={subjectDefault}
					onChange={(event) => onChange({ ...notification, subject: event.target.value.replace(/[\r\n]+/g, " ") })}
					aria-invalid={problemsAt(`${at}.subject`).length > 0 ? true : undefined}
					aria-describedby={`${id}-subject-help`}
				/>
			</KeyValue>
			<KeyValue
				id={`${id}-intro`}
				label={t("formEmails.notifications.intro2")}
				help={t("formEmails.notifications.introHelp")}
			>
				<Textarea
					id={`${id}-intro`}
					rows={2}
					value={notification.intro}
					maxLength={FORM_EMAIL_LIMITS.introLength}
					placeholder={introDefault}
					onChange={(event) => onChange({ ...notification, intro: event.target.value })}
					aria-describedby={`${id}-intro-help`}
				/>
			</KeyValue>
		</section>
	);
}

function AutoReplyCard({
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
	const [shown, setShown] = useState(languages.default);
	const tabs = useRef<HTMLDivElement>(null);
	const fieldProblems = problemsAt("autoReply.field");
	const language = ordered.includes(shown) ? shown : languages.default;
	const translated = language === languages.default ? null : language;
	const valueIn = (text: FormAutoReply["subject"]) =>
		translated === null ? text.text : (text.translations?.[translated] ?? "");
	const subjectProblems = translated === null ? problemsAt("autoReply.subject") : [];
	const textProblems = translated === null ? problemsAt("autoReply.text") : [];

	const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		const index = ordered.indexOf(language);
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
		let next: number | undefined;
		if (step !== undefined) next = (index + step + ordered.length) % ordered.length;
		if (event.key === "Home") next = 0;
		if (event.key === "End") next = ordered.length - 1;
		const target = next === undefined ? undefined : ordered[next];
		if (!target) return;
		event.preventDefault();
		setShown(target);
		tabs.current?.querySelector<HTMLButtonElement>(`[data-language="${target}"]`)?.focus();
	};

	const texts = (
		<div className="@container/card grid gap-4">
			<KeyValue id={`${id}-subject`} label={t("formEmails.autoReply.subject")} problems={subjectProblems}>
				<Input
					id={`${id}-subject`}
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
			</KeyValue>
			<div className="grid gap-1.5" data-invalid={textProblems.length > 0 ? true : undefined}>
				<label htmlFor={`${id}-text`} className="text-sm font-medium">
					{t("formEmails.autoReply.text")}
				</label>
				<Textarea
					id={`${id}-text`}
					lang={language}
					rows={3}
					value={valueIn(autoReply.text)}
					maxLength={FORM_EMAIL_LIMITS.autoReplyTextLength}
					onChange={(event) =>
						onChange({ ...autoReply, text: withText(autoReply.text, translated, event.target.value) })
					}
					aria-invalid={textProblems.length > 0 ? true : undefined}
					aria-describedby={`${id}-text-help`}
				/>
				<FieldDescription id={`${id}-text-help`}>
					{translated === null ? t("formEmails.autoReply.textHelp") : t("formEmails.autoReply.translationHelp")}
				</FieldDescription>
				{textProblems.length > 0 ? (
					<FieldError>{textProblems.map((problem) => problem.message).join(" ")}</FieldError>
				) : null}
			</div>
		</div>
	);

	return (
		<SettingsCard
			title={t("formEmails.autoReply.heading")}
			action={
				<Switch
					checked={autoReply.enabled}
					aria-label={t("formEmails.autoReply.enabled")}
					onCheckedChange={(enabled) => onChange({ ...autoReply, enabled })}
				/>
			}
		>
			<div className="grid gap-1.5" data-invalid={fieldProblems.length > 0 ? true : undefined}>
				<div className="flex flex-wrap items-center gap-2">
					<label htmlFor={`${id}-field`} className="text-muted-foreground text-sm">
						{t("formEmails.autoReply.field")}
					</label>
					<NativeSelect
						id={`${id}-field`}
						size="sm"
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
				</div>
				<FieldDescription id={`${id}-field-help`} className={emailFields.length === 0 ? undefined : "sr-only"}>
					{emailFields.length === 0 ? t("formEmails.autoReply.noEmailField") : t("formEmails.autoReply.fieldHelp")}
				</FieldDescription>
				{fieldProblems.length > 0 ? (
					<FieldError>{fieldProblems.map((problem) => problem.message).join(" ")}</FieldError>
				) : null}
			</div>
			{ordered.length > 1 ? (
				<div className="grid gap-4">
					<div
						ref={tabs}
						role="tablist"
						aria-label={t("formEmails.autoReply.languages")}
						className="flex flex-wrap gap-2 border-b"
					>
						{ordered.map((code) => (
							<button
								key={code}
								type="button"
								role="tab"
								id={`${id}-tab-${code}`}
								data-language={code}
								aria-selected={code === language}
								aria-controls={`${id}-panel`}
								tabIndex={code === language ? 0 : -1}
								onClick={() => setShown(code)}
								onKeyDown={onTabKey}
								className="focus-visible:ring-ring/50 aria-selected:border-primary aria-selected:text-foreground text-muted-foreground -mb-px rounded-t-sm border-b-2 border-transparent px-1 pb-2 text-sm font-medium outline-none focus-visible:ring-3"
							>
								{languageName(code)}
							</button>
						))}
					</div>
					<div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${language}`}>
						{texts}
					</div>
				</div>
			) : (
				texts
			)}
		</SettingsCard>
	);
}
