import type { FormField } from "@webcraft/renderer/forms";
import { FORM_EMAIL_LIMITS, type FormEmails, type FormNotification } from "@webcraft/renderer/forms/emails";
import { LockIcon, UploadIcon } from "lucide-react";
import { useId, useState } from "react";

import { withText } from "../../../../forms/model.ts";
import { fill, type ShellConfig, type Words } from "../../../api.ts";
import { DraftStateCell, draftStateOf } from "../../../bottom-bar/DraftState.tsx";
import { buttonLook } from "../../content/ui.tsx";
import type { FormsApi, OpenedForm } from "../data.ts";
import { AdminLink, Card, INPUT_LOOK, LanguageTabs, Problem, Switch, WELL_LOOK } from "../parts.tsx";
import { useEmailsEditor } from "./emails.ts";

/**
 * The Emails tab (BA-27; SPEC 15.1 and 15.2, `forms/03`, `forms-builder/06`): the Form's Notifications
 * as cards (who receives them, their routing, subject and opening text) and its Auto-reply (on or
 * off, the email field it answers, its subject and text in each of the Site's languages). Emails are
 * Content with a Draft of their own: changes are saved to it after the pause, and the tab's own
 * "Publish emails", beside their Draft state, publishes them apart from the fields (which the bottom
 * bar's Publish does). Who receives Submissions is a Sensitive action: changing it, or adding a
 * Notification, asks for the password again in the admin's Emails tab, which the cards link to.
 */
export function Emails({
	config,
	words,
	api,
	form,
	fields,
	announce,
	onTaken,
}: {
	config: ShellConfig;
	words: Words;
	api: FormsApi;
	form: OpenedForm["form"];
	/** The Form's fields as the Draft holds them (the Auto-reply's email field, routing's field). */
	fields: readonly FormField[];
	announce(text: string, urgent?: boolean): void;
	onTaken(form: OpenedForm["form"]): void;
}) {
	const shown = words.forms.emails;
	const ids = useId();
	const editor = useEmailsEditor({ api, siteId: config.site.id, form, words, announce, onTaken });
	const [busy, setBusy] = useState(false);
	const [language, setLanguage] = useState(config.languages.default);
	const { emails } = editor;
	const languages = config.languages.all;
	const defaultLanguage = config.languages.default;
	const adminEmails = `${config.admin}/forms/${form.id}?tab=emails`;
	const problemAt = (at: string) =>
		editor.problems.find((problem) => problem.at === at || problem.at.startsWith(`${at}.`))?.message;
	const labelOf = (key: string) => fields.find((field) => field.key === key)?.label.text ?? key;
	const emailFields = fields.filter((field) => field.type === "email");

	const setNotification = (index: number, next: FormNotification, label: string, group: string) =>
		editor.change(
			{ ...emails, notifications: emails.notifications.map((each, at) => (at === index ? next : each)) },
			label,
			group,
		);
	const setAutoReply = (next: FormEmails["autoReply"], label: string, group?: string) =>
		editor.change({ ...emails, autoReply: next }, label, group);

	// At rest the emails' own state ("Published", or never published); else the Draft state's cell.
	const state =
		editor.saving !== "idle"
			? null
			: editor.published === null
				? shown.neverPublished
				: editor.changes === 0
					? shown.publishedState
					: null;
	const autoReply = emails.autoReply;
	const shownLanguage = languages.some((each) => each.code === language) ? language : defaultLanguage;
	const textIn = (text: { text: string; translations?: Record<string, string> }) =>
		shownLanguage === defaultLanguage ? text.text : (text.translations?.[shownLanguage] ?? "");

	return (
		<div className="flex min-h-0 grow flex-col gap-3 overflow-hidden" data-wc-emails="">
			<div className="flex flex-wrap items-center gap-3">
				<p className="text-chrome-muted m-0 grow text-[12px]">{shown.apart}</p>
				{state ? (
					<span className="text-chrome-muted text-[12px]" data-wc-emails-state="">
						{state}
					</span>
				) : (
					<span data-wc-emails-state="">
						<DraftStateCell
							state={draftStateOf(editor.saving, {
								changes: editor.changes,
								inReview: false,
							})}
							words={words}
							language={config.language}
						/>
					</span>
				)}
				<button
					type="button"
					className={buttonLook("primary")}
					aria-disabled={busy || (editor.changes === 0 && editor.published !== null) || undefined}
					onClick={async () => {
						if (busy || (editor.changes === 0 && editor.published !== null)) return;
						setBusy(true);
						await editor.publish();
						setBusy(false);
					}}
					data-wc-publish-emails=""
				>
					<UploadIcon aria-hidden="true" className="size-3.5" />
					{busy ? shown.publishing : shown.publish}
				</button>
			</div>

			<div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto pb-2">
				<div className="flex max-w-[680px] flex-col gap-3">
					<div className="flex items-center gap-3">
						<h2 className="text-chrome-strong m-0 text-[13px] font-semibold">{shown.notifications}</h2>
						<span className="text-chrome-muted text-[11px]">
							{fill(shown.upTo, { count: String(FORM_EMAIL_LIMITS.notifications) })}
						</span>
						<span className="ms-auto">
							<AdminLink href={adminEmails} data-wc-add-notification="">
								{shown.addNotification}
							</AdminLink>
						</span>
					</div>
					{emails.notifications.length === 0 ? (
						<p className="text-chrome-muted m-0 text-[12px]">{shown.noNotifications}</p>
					) : null}
					{emails.notifications.map((notification, index) => {
						const at = `notifications[${index}]`;
						const id = `${ids}-n${index}`;
						return (
							<Card
								// oxlint-disable-next-line react/no-array-index-key -- Notifications are known by their place.
								key={index}
								title={fill(shown.notification, { number: String(index + 1) })}
								id={`${id}-title`}
							>
								<div className="flex flex-col gap-1.5" data-wc-notification={index}>
									<span id={`${id}-to`} className="text-chrome-muted text-[11px]">
										{shown.sendTo}
									</span>
									<ul aria-labelledby={`${id}-to`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
										{notification.recipients.map((address) => (
											<li
												key={address}
												className="bg-chrome-hover text-chrome-strong rounded-full px-2.5 py-1 text-[11px] font-medium"
											>
												{address}
											</li>
										))}
									</ul>
									{notification.routing ? (
										<p className="text-chrome-muted m-0 text-[11px]">
											{fill(shown.routed, { field: labelOf(notification.routing.field) })}
										</p>
									) : null}
									<p className="text-chrome-muted m-0 flex items-center gap-1.5 text-[11px]">
										<LockIcon aria-hidden="true" className="size-3 shrink-0" />
										{shown.password}
									</p>
									<AdminLink href={adminEmails} data-wc-change-recipients={String(index)}>
										{shown.changeRecipients}
									</AdminLink>
								</div>
								<label className="flex flex-col gap-1.5">
									<span className="text-chrome-muted text-[11px]">{shown.subject}</span>
									<input
										value={notification.subject}
										placeholder={shown.subjectPlaceholder}
										maxLength={FORM_EMAIL_LIMITS.subjectLength}
										aria-describedby={problemAt(`${at}.subject`) ? `${id}-subject-problem` : undefined}
										onChange={(event) =>
											setNotification(
												index,
												{ ...notification, subject: event.target.value },
												shown.history.subject,
												`${at}.subject`,
											)
										}
										className={INPUT_LOOK}
										data-wc-notification-subject={index}
									/>
									<Problem id={`${id}-subject-problem`}>{problemAt(`${at}.subject`)}</Problem>
								</label>
								<label className="flex flex-col gap-1.5">
									<span className="text-chrome-muted text-[11px]">{shown.intro}</span>
									<textarea
										value={notification.intro}
										placeholder={shown.introPlaceholder}
										maxLength={FORM_EMAIL_LIMITS.introLength}
										aria-describedby={problemAt(`${at}.intro`) ? `${id}-intro-problem` : undefined}
										onChange={(event) =>
											setNotification(
												index,
												{ ...notification, intro: event.target.value },
												shown.history.intro,
												`${at}.intro`,
											)
										}
										className={WELL_LOOK}
										data-wc-notification-intro={index}
									/>
									<Problem id={`${id}-intro-problem`}>{problemAt(`${at}.intro`)}</Problem>
								</label>
							</Card>
						);
					})}

					<Card title={shown.autoReply} id={`${ids}-auto`}>
						<div className="flex items-center justify-between gap-2">
							<span id={`${ids}-auto-on`} className="text-[12px]">
								{shown.autoReplyOn}
							</span>
							<Switch
								on={autoReply.enabled}
								labelledBy={`${ids}-auto-on`}
								disabled={emailFields.length === 0}
								onChange={(on) => setAutoReply({ ...autoReply, enabled: on }, shown.history.autoReply)}
								data-wc-auto-reply=""
							/>
						</div>
						{emailFields.length === 0 ? (
							<p className="text-chrome-muted m-0 text-[11px]">{shown.noEmailField}</p>
						) : (
							<label className="flex items-center gap-2">
								<span className="text-[12px]">{shown.answers}</span>
								<select
									value={autoReply.field ?? ""}
									onChange={(event) =>
										setAutoReply(
											{ ...autoReply, field: event.target.value === "" ? null : event.target.value },
											shown.history.autoReplyField,
										)
									}
									className={`${INPUT_LOOK} w-auto grow [color-scheme:dark]`}
									data-wc-auto-reply-field=""
								>
									<option value="">{shown.firstEmailField}</option>
									{emailFields.map((field) => (
										<option key={field.key} value={field.key}>
											{field.label.text}
										</option>
									))}
								</select>
							</label>
						)}
						{languages.length > 1 ? (
							<LanguageTabs
								label={shown.languages}
								languages={languages}
								current={shownLanguage}
								panel={`${ids}-auto-texts`}
								onChoose={setLanguage}
							/>
						) : null}
						<div
							id={`${ids}-auto-texts`}
							role={languages.length > 1 ? "tabpanel" : undefined}
							className="flex flex-col gap-3"
						>
							<label className="flex flex-col gap-1.5">
								<span className="text-chrome-muted text-[11px]">{shown.subject}</span>
								<input
									lang={shownLanguage}
									value={textIn(autoReply.subject)}
									placeholder={shownLanguage === defaultLanguage ? "" : autoReply.subject.text}
									onChange={(event) =>
										setAutoReply(
											{
												...autoReply,
												subject: withText(
													autoReply.subject,
													shownLanguage === defaultLanguage ? null : shownLanguage,
													event.target.value,
												),
											},
											shown.history.autoReplyText,
											`autoReply.subject:${shownLanguage}`,
										)
									}
									className={INPUT_LOOK}
									data-wc-auto-reply-subject={shownLanguage}
								/>
							</label>
							<label className="flex flex-col gap-1.5">
								<span className="text-chrome-muted text-[11px]">{shown.text}</span>
								<textarea
									lang={shownLanguage}
									value={textIn(autoReply.text)}
									placeholder={shownLanguage === defaultLanguage ? "" : autoReply.text.text}
									maxLength={FORM_EMAIL_LIMITS.autoReplyTextLength}
									aria-describedby={problemAt("autoReply") ? `${ids}-auto-problem` : undefined}
									onChange={(event) =>
										setAutoReply(
											{
												...autoReply,
												text: withText(
													autoReply.text,
													shownLanguage === defaultLanguage ? null : shownLanguage,
													event.target.value,
												),
											},
											shown.history.autoReplyText,
											`autoReply.text:${shownLanguage}`,
										)
									}
									className={WELL_LOOK}
									data-wc-auto-reply-text={shownLanguage}
								/>
							</label>
							<Problem id={`${ids}-auto-problem`}>{problemAt("autoReply")}</Problem>
						</div>
					</Card>
				</div>
			</div>
		</div>
	);
}
