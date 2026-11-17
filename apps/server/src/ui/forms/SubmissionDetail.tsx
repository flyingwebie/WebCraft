import type { SubmissionDelivery } from "@webcraft/module-sdk";
import { type FormField, formTextIn } from "@webcraft/renderer/forms";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Separator } from "@webcraft/ui/components/separator.tsx";
import {
	CircleCheckIcon,
	ClockIcon,
	DownloadIcon,
	FileIcon,
	ImageIcon,
	InboxIcon,
	MailIcon,
	MailOpenIcon,
	RefreshCwIcon,
	TrashIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocale } from "use-intl";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { ConfirmDialog } from "../settings/confirm.tsx";
import {
	dateAnswer,
	detailTime,
	filesOf,
	formsApi,
	type Opened,
	type SubmissionValue,
	senderOf,
	sizeOf,
	type UploadValue,
} from "./mailbox.ts";

/** Why the Spam folder caught a Submission, in plain words, by the reason the Forms Module keeps. */
const CAUGHT_BECAUSE: Record<string, MessageKey> = {
	honeypot: "submissions.caughtBecause.honeypot",
	"too-fast": "submissions.caughtBecause.tooFast",
	token: "submissions.caughtBecause.token",
	"rate-limit": "submissions.caughtBecause.rateLimit",
	size: "submissions.caughtBecause.size",
	captcha: "submissions.caughtBecause.captcha",
};

/** What the mailbox's keys ask of the Submission open: U marks it unread, Delete asks to delete it. */
export type DetailActions = { markUnread(): void; askDelete(): void };

/**
 * The Submission chosen in the mailbox (frame 01, and 02 in the Spam folder): who sent it, large; when
 * it came, from which page, in which language; every answer by its label; its files as chips to
 * download (only through the admin, each download in the Audit log); "What happened next", each email
 * and Webhook call sent for it with its state in words. In the inbox: Mark as unread and Delete; in
 * Spam: why it was caught, that it is kept 30 days and told nobody, Not spam and Delete. Opening one
 * marks it read, for everyone. Deleting asks first, and says its files go with it.
 */
export function SubmissionDetail({
	siteId,
	submissionId,
	fields,
	defaultLanguage,
	canManage,
	canResend,
	actions,
	onChanged,
	onGone,
}: {
	siteId: string;
	submissionId: string | null;
	/** The Form's fields, to show a choice by its label. */
	fields: readonly FormField[];
	defaultLanguage: string;
	/** Whether the person may delete and take out of Spam (`forms.submissions.manage`). */
	canManage: boolean;
	/** Whether the person may send a failed Webhook call again (Staff). */
	canResend: boolean;
	/** Filled with what the mailbox's keys do to the Submission open. */
	actions: RefObject<DetailActions | null>;
	/** Something about the Submission changed (read, out of Spam): the list and the counts follow. */
	onChanged(): void;
	/** The Submission was deleted. */
	onGone(submissionId: string): void;
}) {
	const t = useT();
	const language = useLocale();
	const [opened, setOpened] = useState<Opened | null>(null);
	const [loaded, setLoaded] = useState(0);
	const [deleting, setDeleting] = useState<{ confirmation: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const deleteButton = useRef<HTMLButtonElement>(null);
	// The Submissions this pane marked read when they were first opened: never again (after Not spam).
	const marked = useRef(new Set<string>());
	const heading = useId();
	// The translator and the latest `onChanged`, for the effect that loads, without running it again.
	const words = useRef(t);
	words.current = t;
	const changed = useRef(onChanged);
	changed.current = onChanged;

	useEffect(() => {
		let current = true;
		if (!submissionId) {
			setOpened(null);
			return;
		}
		void (async () => {
			try {
				const api = formsApi(await getApi());
				let answer = await api.submissions.get({ siteId, id: submissionId });
				// Opening a Submission marks it read, for everyone.
				if (!answer.submission.read && !marked.current.has(submissionId) && loaded >= 0) {
					marked.current.add(submissionId);
					await api.submissions.setRead({ siteId, ids: [submissionId], read: true });
					answer = { ...answer, submission: { ...answer.submission, read: true } };
					changed.current();
				}
				if (current) setOpened(answer);
			} catch (error) {
				if (current) {
					setOpened(null);
					toast.error(words.current(errorMessage(error)));
				}
			}
		})();
		return () => {
			current = false;
		};
	}, [siteId, submissionId, loaded]);

	const submission = opened?.submission.id === submissionId ? opened.submission : null;

	const act = async (work: () => Promise<void>) => {
		setBusy(true);
		try {
			await work();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const setRead = (read: boolean) =>
		act(async () => {
			if (!opened || !submission || submission.read === read) return;
			const api = formsApi(await getApi());
			await api.submissions.setRead({ siteId, ids: [submission.id], read });
			setOpened({ ...opened, submission: { ...submission, read } });
			onChanged();
		});
	const askDelete = () =>
		act(async () => {
			if (!submission || !canManage) return;
			const api = formsApi(await getApi());
			const asked = await api.submissions.delete({ siteId, ids: [submission.id] });
			if (!asked.deleted) setDeleting({ confirmation: asked.confirmation.id });
		});

	// The keys act on what is open now.
	useEffect(() => {
		actions.current = submission
			? {
					markUnread: () => {
						if (submission.folder === "inbox") void setRead(false);
					},
					askDelete: () => void askDelete(),
				}
			: null;
	});

	if (!submissionId || !submission || !opened) {
		return (
			<p className="text-muted-foreground p-5 text-sm" aria-live="polite">
				{submissionId ? t("submissions.loading") : t("submissions.choose")}
			</p>
		);
	}

	const spam = submission.folder === "spam";
	const sender = senderOf(submission);
	const came = detailTime(submission.receivedAt, new Date(), language);
	const deleteAction = canManage ? (
		<Button
			ref={deleteButton}
			variant="outline"
			size={spam ? "default" : "sm"}
			className={spam ? "w-40" : undefined}
			disabled={busy}
			aria-keyshortcuts="Delete"
			onClick={() => void askDelete()}
		>
			<TrashIcon aria-hidden="true" data-icon="inline-start" />
			{t("submissions.delete")}
		</Button>
	) : null;

	return (
		<article aria-labelledby={heading} className="@container/detail flex min-w-0 flex-col gap-3 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="grid min-w-0 flex-1 gap-1">
					<h2
						id={heading}
						className={`text-xl font-semibold wrap-anywhere ${spam ? "text-muted-foreground" : ""} ${sender ? "" : "italic"}`}
					>
						{sender ?? t("submissions.noName")}
					</h2>
					<p className="text-muted-foreground text-[13px]">
						{spam
							? t("submissions.caught", { time: came, page: submission.page ?? "—" })
							: t("submissions.received", {
									time: came,
									page: submission.page ?? "—",
									language: languageName(submission.language),
								})}
					</p>
				</div>
				{spam ? null : (
					<div className="flex flex-wrap gap-2">
						{submission.read ? (
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								aria-keyshortcuts="U"
								onClick={() => void setRead(false)}
							>
								<MailIcon aria-hidden="true" data-icon="inline-start" />
								{t("submissions.markUnread")}
							</Button>
						) : (
							<Button variant="outline" size="sm" disabled={busy} onClick={() => void setRead(true)}>
								<MailOpenIcon aria-hidden="true" data-icon="inline-start" />
								{t("submissions.markRead")}
							</Button>
						)}
						{deleteAction}
					</div>
				)}
			</div>

			{spam ? (
				<>
					<div className="bg-destructive/10 dark:bg-destructive/20 grid gap-2 rounded-lg p-4 text-red-800 dark:text-red-200">
						<p className="flex items-center gap-2 text-[13px] font-medium">
							<TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
							{t(CAUGHT_BECAUSE[submission.spamReason ?? ""] ?? "submissions.caughtBecause.other")}
						</p>
					</div>
					<p className="text-muted-foreground text-[13px]">{t("submissions.spamKept")}</p>
				</>
			) : null}

			<Separator className="my-2" />

			<dl className={`grid gap-x-6 gap-y-3 ${spam ? "" : "@sm/detail:grid-cols-2"}`}>
				{submission.values.map((value) => (
					<div
						key={value.key}
						className={`grid min-w-0 content-start gap-1 ${value.type === "textarea" ? "@sm/detail:col-span-2" : ""}`}
					>
						<dt className="text-muted-foreground text-xs font-medium wrap-anywhere">{value.label}</dt>
						<dd className="min-w-0 text-sm leading-5 wrap-anywhere whitespace-pre-line">
							<Answer value={value} fields={fields} language={defaultLanguage} />
						</dd>
					</div>
				))}
			</dl>

			<Separator className="my-2" />

			{spam ? (
				canManage ? (
					<div className="grid justify-items-start gap-2">
						<Button
							className="w-40"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const api = formsApi(await getApi());
									await api.submissions.notSpam({ siteId, id: submission.id });
									toast.success(t("submissions.notSpamDone"));
									setLoaded((count) => count + 1);
									onChanged();
								})
							}
						>
							<InboxIcon aria-hidden="true" data-icon="inline-start" />
							{t("submissions.notSpam")}
						</Button>
						<p className="text-muted-foreground text-xs">{t("submissions.notSpamNote")}</p>
						{deleteAction}
					</div>
				) : null
			) : (
				<section aria-labelledby={`${heading}-next`} className="grid gap-2.5">
					<h3 id={`${heading}-next`} className="text-[13px] font-semibold">
						{t("submissions.delivery.heading")}
					</h3>
					{opened.deliveries.length === 0 ? (
						<p className="text-muted-foreground text-[13px]">{t("submissions.delivery.none")}</p>
					) : (
						<ul className="grid gap-2.5">
							{opened.deliveries.map((delivery) => (
								<DeliveryLine
									key={delivery.id}
									siteId={siteId}
									delivery={delivery}
									canResend={canResend}
									onResent={() => setLoaded((count) => count + 1)}
								/>
							))}
						</ul>
					)}
				</section>
			)}

			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => (open ? null : setDeleting(null))}
				title={t("submissions.deleteTitle")}
				confirm={t("submissions.delete")}
				finalFocus={deleteButton}
				onConfirm={async () => {
					if (!deleting) return;
					try {
						const api = formsApi(await getApi());
						await api.submissions.delete({ siteId, ids: [submission.id], confirmation: deleting.confirmation });
						setDeleting(null);
						toast.success(t("submissions.deleted"));
						onGone(submission.id);
					} catch (error) {
						setDeleting(null);
						toast.error(t(errorMessage(error)));
					}
				}}
			>
				{t("submissions.deleteBody")}
			</ConfirmDialog>
		</article>
	);
}

/** One answer: a choice by its label (in the Site's Default language), consent Yes or No, files as chips. */
function Answer({
	value,
	fields,
	language,
}: {
	value: SubmissionValue;
	fields: readonly FormField[];
	language: string;
}) {
	const t = useT();
	const locale = useLocale();
	const files = filesOf(value);
	if (files) return <Files files={files} />;
	const raw = value.value;
	if (raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
		return <span className="text-muted-foreground">{t("submissions.notGiven")}</span>;
	}
	if (typeof raw === "boolean") return <>{raw ? t("submissions.yes") : t("submissions.no")}</>;
	if (value.type === "date" && typeof raw === "string") return <>{dateAnswer(raw, locale)}</>;
	const options = fields.find((field) => field.key === value.key)?.options ?? [];
	const label = (choice: string) => {
		const option = options.find((candidate) => candidate.value === choice);
		return option ? formTextIn(option.label, language) : choice;
	};
	if (Array.isArray(raw))
		return <>{raw.map((choice) => (typeof choice === "string" ? label(choice) : "")).join(", ")}</>;
	return <>{typeof raw === "string" ? label(raw) : String(raw)}</>;
}

/**
 * A Submission's files: each a chip that downloads it through the admin (only people who may read the
 * Submissions get it, and each download is in the Audit log), or "Not kept" when it came as spam.
 */
function Files({ files }: { files: readonly UploadValue[] }) {
	const t = useT();
	if (files.length === 0) return <span className="text-muted-foreground">{t("submissions.notGiven")}</span>;
	if (files.every((file) => !file.url)) {
		return <span className="text-muted-foreground text-[13px]">{t("submissions.notKept")}</span>;
	}
	return (
		<ul className="grid gap-2">
			{files.map((file, index) => {
				const Icon = file.contentType.startsWith("image/") ? ImageIcon : FileIcon;
				return (
					// oxlint-disable-next-line react/no-array-index-key -- a Submission's files never change order.
					<li key={index}>
						{file.url ? (
							<a
								href={file.url}
								download={file.name}
								className="bg-muted hover:bg-muted/70 focus-visible:ring-ring/50 flex h-10 items-center gap-2 rounded-lg px-3 outline-none focus-visible:ring-3"
								aria-label={t("forms.uploadFiles.download", { name: file.name })}
							>
								<Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate text-[13px]">{file.name}</span>
								<span className="text-muted-foreground text-xs">{sizeOf(file.size)}</span>
								<DownloadIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
							</a>
						) : (
							<span className="text-muted-foreground text-[13px]">
								{t("forms.uploadFiles.notKept", { name: file.name })}
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * One line of "What happened next": an email or Webhook call, its state in words and an icon (sent;
 * waiting; could not send), why the last attempt failed, and "Send again" for a failed Webhook call
 * when the person may send it again (Staff).
 */
function DeliveryLine({
	siteId,
	delivery,
	canResend,
	onResent,
}: {
	siteId: string;
	delivery: SubmissionDelivery;
	canResend: boolean;
	onResent(): void;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const state = delivery.status;
	const icon: ReactNode =
		state === "sent" ? (
			<CircleCheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
		) : state === "failed" ? (
			<TriangleAlertIcon className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
		) : state === "logged" ? (
			<MailIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		) : (
			<ClockIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		);
	const resend = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			// The call is sent again under the Webhook it went to, whatever that Webhook is called now.
			if (!delivery.webhookId) throw new Error("WEBHOOK_NOT_FOUND");
			await api.webhooks.redeliver({ siteId, webhookId: delivery.webhookId, deliveryId: delivery.id });
			toast.success(t("submissions.delivery.sentAgain"));
			onResent();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<li className="grid gap-1.5">
			<p className="flex items-start gap-2 text-[13px]">
				<span className="mt-0.5">{icon}</span>
				<span className="min-w-0 wrap-anywhere">
					{t(`submissions.delivery.${state}.${delivery.kind}`, { to: delivery.to })}
				</span>
			</p>
			{delivery.problem && state !== "sent" ? (
				<p className="text-muted-foreground ms-6 text-xs wrap-anywhere">
					{t("submissions.delivery.problem", { problem: delivery.problem })}
				</p>
			) : null}
			{delivery.nextAttemptAt && state === "retrying" ? (
				<p className="text-muted-foreground ms-6 text-xs">
					{t("emailLog.nextAttempt", { time: formatUtc(delivery.nextAttemptAt) })}
				</p>
			) : null}
			{state === "failed" && delivery.kind === "webhook" && canResend ? (
				<div className="ms-6">
					<Button variant="outline" size="sm" disabled={busy} onClick={() => void resend()}>
						<RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
						{t("submissions.delivery.sendAgain")}
					</Button>
				</div>
			) : null}
		</li>
	);
}
