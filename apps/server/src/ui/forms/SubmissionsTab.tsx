import type { ApiClient } from "@webcraft/api";
import type forms from "@webcraft/module-forms";
import type { ModuleApi, SubmissionDelivery } from "@webcraft/module-sdk";
import { type FormField, formTextIn } from "@webcraft/renderer/forms";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import {
	DownloadIcon,
	InboxIcon,
	MailIcon,
	ReplyIcon,
	ShieldAlertIcon,
	ShieldCheckIcon,
	TrashIcon,
	WebhookIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";

/** The Forms Module's procedures, as the admin calls them (`m.forms.…`). */
function formsApi(api: ApiClient): ModuleApi<typeof forms> {
	return (api as unknown as { m: { forms: ModuleApi<typeof forms> } }).m.forms;
}

type Listed = Awaited<ReturnType<ModuleApi<typeof forms>["submissions"]["list"]>>;
type Submission = Listed["submissions"][number];
type Folder = "inbox" | "spam";
type ReadFilter = "all" | "unread" | "read";

/** How many Submissions a page of the list shows. */
const PAGE_SIZE = 25;

/** How long a Form may keep its Submissions: forever (null), or a number of days. */
const KEEP_CHOICES = [null, 30, 90, 365] as const;

const SPAM_REASONS: Record<string, MessageKey> = {
	honeypot: "submissions.spamReasons.honeypot",
	"too-fast": "submissions.spamReasons.tooFast",
	token: "submissions.spamReasons.token",
	"rate-limit": "submissions.spamReasons.rateLimit",
	size: "submissions.spamReasons.size",
	captcha: "submissions.spamReasons.captcha",
};

const DELIVERY_STATUS: Record<SubmissionDelivery["status"], MessageKey> = {
	queued: "emailLog.status.queued",
	retrying: "emailLog.status.retrying",
	sent: "emailLog.status.sent",
	failed: "emailLog.status.failed",
	logged: "emailLog.status.logged",
};

/**
 * The Submissions tab (the Forms Module, for Staff, Owners and Editors): the Form's inbox and Spam
 * folder, searched and filtered (read or unread, a language), a page at a time; the Submission chosen
 * (from the list, or the address's `submission`) with its values and its delivery log; marking it read
 * or unread, Not spam, deleting it (two steps), exporting the list as CSV, and how long the Form keeps
 * them. Opening a Submission marks it read.
 */
export function SubmissionsTab({
	siteId,
	formId,
	fields,
	languages,
	defaultLanguage,
	canManage,
	initialSubmission,
	onSelect,
}: {
	siteId: string;
	formId: string;
	/** The Form's fields, to show a choice by its label. */
	fields: readonly FormField[];
	languages: readonly string[];
	defaultLanguage: string;
	/** Whether the person may delete, take out of spam and choose how long they are kept. */
	canManage: boolean;
	initialSubmission?: string;
	onSelect?(submissionId: string | null): void;
}) {
	const t = useT();
	const [folder, setFolder] = useState<Folder>("inbox");
	const [typed, setTyped] = useState("");
	const [search, setSearch] = useState("");
	const [read, setRead] = useState<ReadFilter>("all");
	const [language, setLanguage] = useState("");
	const [offset, setOffset] = useState(0);
	const [listed, setListed] = useState<Listed | null>(null);
	const [selected, setSelected] = useState<string | null>(initialSubmission ?? null);
	const [refreshed, setRefreshed] = useState(0);
	const ids = useId();
	// The translator, for effects that report a failure without running again when it changes.
	const words = useRef(t);
	words.current = t;

	// What is typed in the search box is searched for once typing pauses.
	useEffect(() => {
		const timer = setTimeout(() => {
			setSearch(typed.trim());
			setOffset(0);
		}, 300);
		return () => clearTimeout(timer);
	}, [typed]);

	useEffect(() => {
		let current = true;
		void (async () => {
			try {
				const api = formsApi(await getApi());
				const answer = await api.submissions.list({
					siteId,
					formId,
					folder,
					read,
					search: search || undefined,
					language: language || undefined,
					limit: PAGE_SIZE,
					offset,
				});
				// `refreshed` asks for the list again after a change.
				if (current && refreshed >= 0) setListed(answer);
			} catch (error) {
				if (current) toast.error(words.current(errorMessage(error)));
			}
		})();
		return () => {
			current = false;
		};
	}, [siteId, formId, folder, read, search, language, offset, refreshed]);

	const refresh = useCallback(() => setRefreshed((count) => count + 1), []);
	const choose = (id: string | null) => {
		setSelected(id);
		onSelect?.(id);
	};

	const exportCsv = async () => {
		try {
			const api = formsApi(await getApi());
			const { filename, csv, count } = await api.submissions.export({
				siteId,
				formId,
				folder,
				read,
				search: search || undefined,
				language: language || undefined,
			});
			const link = document.createElement("a");
			link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
			link.download = filename;
			link.click();
			URL.revokeObjectURL(link.href);
			toast.success(t("submissions.exported", { count }));
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};

	const keepDays = listed?.keepDays ?? null;
	const total = listed?.total ?? 0;

	return (
		<div className="grid gap-6 xl:grid-cols-[12rem_minmax(0,1fr)_22rem]">
			<nav aria-label={t("submissions.folders")} className="grid content-start gap-2">
				{(["inbox", "spam"] as const).map((each) => (
					<Button
						key={each}
						variant={folder === each ? "secondary" : "ghost"}
						className="justify-between"
						aria-current={folder === each ? "true" : undefined}
						onClick={() => {
							setFolder(each);
							setOffset(0);
						}}
					>
						<span className="flex items-center gap-2">
							{each === "inbox" ? (
								<InboxIcon aria-hidden="true" data-icon="inline-start" />
							) : (
								<ShieldAlertIcon aria-hidden="true" data-icon="inline-start" />
							)}
							{each === "inbox" ? t("submissions.inbox") : t("submissions.spam")}
						</span>
						<span className="text-muted-foreground tabular-nums">
							{each === "inbox" ? (listed?.counts.inbox ?? "") : (listed?.counts.spam ?? "")}
						</span>
					</Button>
				))}
				<p className="text-muted-foreground mt-2 rounded-md border p-3 text-xs">{t("submissions.spamNote")}</p>
			</nav>

			<section aria-labelledby={`${ids}-list`} className="grid min-w-0 content-start gap-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1">
						<h2 id={`${ids}-list`} className="text-lg font-semibold">
							{folder === "inbox" ? t("submissions.inbox") : t("submissions.spam")}
						</h2>
						<p className="text-muted-foreground text-sm" aria-live="polite">
							{listed
								? t("submissions.summary", {
										total: listed.counts.inbox,
										unread: listed.counts.unread,
										kept:
											keepDays === null ? t("submissions.keptForever") : t("submissions.keptDays", { days: keepDays }),
									})
								: t("submissions.loading")}
						</p>
					</div>
					<div className="flex flex-wrap items-end gap-2">
						<Retention siteId={siteId} formId={formId} keepDays={keepDays} canManage={canManage} onChanged={refresh} />
						<Button variant="outline" onClick={() => void exportCsv()} disabled={total === 0}>
							<DownloadIcon aria-hidden="true" data-icon="inline-start" />
							{t("submissions.export")}
						</Button>
					</div>
				</div>

				<div className="flex flex-wrap items-end gap-3">
					<Field className="min-w-48 flex-1">
						<FieldLabel htmlFor={`${ids}-search`}>{t("submissions.search")}</FieldLabel>
						<Input
							id={`${ids}-search`}
							type="search"
							value={typed}
							maxLength={200}
							onChange={(event) => setTyped(event.target.value)}
						/>
					</Field>
					<fieldset className="flex rounded-md border p-0.5">
						<legend className="sr-only">{t("submissions.show")}</legend>
						{(["all", "unread", "read"] as const).map((each) => (
							<Button
								key={each}
								size="sm"
								variant={read === each ? "secondary" : "ghost"}
								aria-pressed={read === each}
								onClick={() => {
									setRead(each);
									setOffset(0);
								}}
							>
								{t(`submissions.filter.${each}`)}
							</Button>
						))}
					</fieldset>
					{languages.length > 1 ? (
						<Field className="w-44">
							<FieldLabel htmlFor={`${ids}-language`}>{t("submissions.language")}</FieldLabel>
							<NativeSelect
								id={`${ids}-language`}
								value={language}
								onChange={(event) => {
									setLanguage(event.target.value);
									setOffset(0);
								}}
							>
								<NativeSelectOption value="">{t("submissions.allLanguages")}</NativeSelectOption>
								{languages.map((code) => (
									<NativeSelectOption key={code} value={code}>
										{languageName(code)}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
					) : null}
				</div>

				{listed && listed.submissions.length === 0 ? (
					<p className="text-muted-foreground rounded-md border p-6 text-center text-sm">
						{search || read !== "all" || language
							? t("submissions.noMatch")
							: folder === "spam"
								? t("submissions.emptySpam")
								: t("submissions.empty")}
					</p>
				) : null}
				{listed && listed.submissions.length > 0 ? (
					<div className="overflow-x-auto rounded-md border">
						<Table>
							<caption className="sr-only">{t("submissions.tableLabel")}</caption>
							<TableHeader>
								<TableRow>
									<TableHead>{t("submissions.columns.submitter")}</TableHead>
									<TableHead>{t("submissions.columns.language")}</TableHead>
									<TableHead>{t("submissions.columns.received")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{listed.submissions.map((submission) => (
									<TableRow key={submission.id} data-state={submission.id === selected ? "selected" : undefined}>
										<TableCell className="min-w-56">
											<button
												type="button"
												className="focus-visible:ring-ring/50 flex w-full items-start gap-2 rounded-sm text-start outline-none focus-visible:ring-3"
												aria-current={submission.id === selected ? "true" : undefined}
												onClick={() => choose(submission.id)}
											>
												<span
													className={`mt-1.5 size-2 shrink-0 rounded-full ${submission.read ? "bg-transparent" : "bg-primary"}`}
													aria-hidden="true"
												/>
												<span className="grid min-w-0">
													<span className={submission.read ? "" : "font-semibold"}>{titleOf(submission, t)}</span>
													<span className="text-muted-foreground truncate text-sm">{detailOf(submission)}</span>
													{submission.read ? null : <span className="sr-only">{t("submissions.unread")}</span>}
												</span>
											</button>
										</TableCell>
										<TableCell>
											<Badge variant="outline" lang={submission.language}>
												{submission.language.toUpperCase()}
											</Badge>
										</TableCell>
										<TableCell className="whitespace-nowrap">{formatUtc(submission.receivedAt)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				) : null}
				{listed && total > 0 ? (
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm">
							{t("submissions.showing", {
								from: offset + 1,
								to: Math.min(offset + PAGE_SIZE, total),
								total,
							})}
						</p>
						<div className="flex gap-2">
							<Button
								variant="outline"
								onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
								disabled={offset === 0}
							>
								{t("submissions.previous")}
							</Button>
							<Button
								variant="outline"
								onClick={() => setOffset(offset + PAGE_SIZE)}
								disabled={offset + PAGE_SIZE >= total}
							>
								{t("submissions.next")}
							</Button>
						</div>
					</div>
				) : null}
			</section>

			<SubmissionPanel
				siteId={siteId}
				submissionId={selected}
				fields={fields}
				defaultLanguage={defaultLanguage}
				canManage={canManage}
				onChanged={refresh}
				onGone={() => {
					choose(null);
					refresh();
				}}
			/>
		</div>
	);
}

/** A Submission's name in the list: its first text value (a name), else its first value, else when it came. */
function titleOf(submission: Submission, t: ReturnType<typeof useT>): string {
	const text = submission.values.find(
		(value) => value.type === "text" && typeof value.value === "string" && value.value,
	);
	const any = submission.values.find((value) => typeof value.value === "string" && value.value);
	return String(text?.value ?? any?.value ?? t("submissions.noName"));
}

/** The line under its name: its first email address, else its page. */
function detailOf(submission: Submission): string {
	const email = submission.values.find((value) => value.type === "email" && typeof value.value === "string");
	return String(email?.value ?? submission.page ?? "");
}

/** A Form upload as the Submission's procedures answer it: never its bytes, a link to download it. */
type UploadValue = { uploadId: string | null; name: string; size: number; contentType: string; url: string | null };

/** A file field's uploads, or null for any other value. */
function filesOf(value: Submission["values"][number]): UploadValue[] | null {
	const raw = value.value;
	return Array.isArray(raw) && raw.some((item) => typeof item === "object" && item !== null)
		? (raw as unknown as UploadValue[])
		: null;
}

/** A size as people read it: `3 KB`, `2.4 MB`. */
function sizeOf(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A Submission's files: each a link to download it through the admin (only people who may read the
 * Submissions get it, and each download is in the Audit log), or its name when it wasn't kept (spam).
 */
function Uploads({ files }: { files: readonly UploadValue[] }) {
	const t = useT();
	if (files.length === 0) return <>—</>;
	return (
		<ul className="grid gap-1">
			{files.map((file, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a Submission's files never change order.
				<li key={index}>
					{file.url ? (
						<a
							href={file.url}
							download={file.name}
							className="text-primary underline underline-offset-4"
							aria-label={t("forms.uploadFiles.download", { name: file.name })}
						>
							{file.name}
						</a>
					) : (
						t("forms.uploadFiles.notKept", { name: file.name })
					)}{" "}
					<span className="text-muted-foreground">({sizeOf(file.size)})</span>
				</li>
			))}
		</ul>
	);
}

/** A value as the panel shows it: a choice by its label (in the Site's Default language), a consent Yes or No. */
function shown(
	value: Submission["values"][number],
	fields: readonly FormField[],
	language: string,
	t: ReturnType<typeof useT>,
): string {
	const raw = value.value;
	if (raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) return "—";
	if (typeof raw === "boolean") return raw ? t("submissions.yes") : t("submissions.no");
	const options = fields.find((field) => field.key === value.key)?.options ?? [];
	const label = (choice: string) => {
		const option = options.find((candidate) => candidate.value === choice);
		return option ? formTextIn(option.label, language) : choice;
	};
	if (Array.isArray(raw)) return raw.map((choice) => (typeof choice === "string" ? label(choice) : "")).join(", ");
	return typeof raw === "string" ? label(raw) : String(raw);
}

function Retention({
	siteId,
	formId,
	keepDays,
	canManage,
	onChanged,
}: {
	siteId: string;
	formId: string;
	keepDays: number | null;
	canManage: boolean;
	onChanged(): void;
}) {
	const t = useT();
	const id = useId();
	if (!canManage) return null;
	return (
		<Field className="w-44">
			<FieldLabel htmlFor={id}>{t("submissions.retention")}</FieldLabel>
			<NativeSelect
				id={id}
				value={keepDays === null ? "" : String(keepDays)}
				onChange={async (event) => {
					const days = event.target.value === "" ? null : (Number(event.target.value) as 30 | 90 | 365);
					try {
						const api = formsApi(await getApi());
						await api.retention.set({ siteId, formId, keepDays: days });
						toast.success(t("submissions.retentionSaved"));
						onChanged();
					} catch (error) {
						toast.error(t(errorMessage(error)));
					}
				}}
			>
				{KEEP_CHOICES.map((days) => (
					<NativeSelectOption key={String(days)} value={days === null ? "" : String(days)}>
						{days === null ? t("submissions.retentionForever") : t("submissions.retentionDays", { days })}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Field>
	);
}

type Opened = Awaited<ReturnType<ModuleApi<typeof forms>["submissions"]["get"]>>;

function SubmissionPanel({
	siteId,
	submissionId,
	fields,
	defaultLanguage,
	canManage,
	onChanged,
	onGone,
}: {
	siteId: string;
	submissionId: string | null;
	fields: readonly FormField[];
	defaultLanguage: string;
	canManage: boolean;
	onChanged(): void;
	onGone(): void;
}) {
	const t = useT();
	const [opened, setOpened] = useState<Opened | null>(null);
	const [loaded, setLoaded] = useState(0);
	const [deleting, setDeleting] = useState<{ confirmation: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const deleteButton = useRef<HTMLButtonElement>(null);
	// The Submissions this panel marked read when they were first opened: never again (after Not spam).
	const marked = useRef(new Set<string>());
	const heading = useId();
	const words = useRef(t);
	words.current = t;

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
					onChanged();
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
	}, [siteId, submissionId, loaded, onChanged]);

	if (!submissionId || !opened) {
		return (
			<aside className="text-muted-foreground self-start rounded-md border p-6 text-sm" aria-live="polite">
				{submissionId ? t("submissions.loading") : t("submissions.choose")}
			</aside>
		);
	}
	const { submission, deliveries } = opened;
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

	return (
		<aside aria-labelledby={heading} className="flex min-w-0 flex-col gap-5 self-start rounded-md border p-4">
			<div className="grid gap-1">
				<h2 id={heading} className="text-lg font-semibold break-words">
					{titleOf(submission, t)}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("submissions.came", {
						time: formatUtc(submission.receivedAt),
						language: languageName(submission.language),
						page: submission.page ?? "—",
					})}
				</p>
			</div>
			{submission.folder === "spam" ? (
				<p className="border-warning-border bg-warning text-warning-foreground rounded-md border p-3 text-sm">
					{t("submissions.inSpam", {
						reason: t(SPAM_REASONS[submission.spamReason ?? ""] ?? "submissions.spamReasons.other"),
					})}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() =>
						act(async () => {
							const api = formsApi(await getApi());
							await api.submissions.setRead({ siteId, ids: [submission.id], read: !submission.read });
							setOpened({ ...opened, submission: { ...submission, read: !submission.read } });
							onChanged();
						})
					}
				>
					<MailIcon aria-hidden="true" data-icon="inline-start" />
					{submission.read ? t("submissions.markUnread") : t("submissions.markRead")}
				</Button>
				{canManage && submission.folder === "spam" ? (
					<Button
						variant="outline"
						size="sm"
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
						<ShieldCheckIcon aria-hidden="true" data-icon="inline-start" />
						{t("submissions.notSpam")}
					</Button>
				) : null}
				{canManage ? (
					<Button
						ref={deleteButton}
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() =>
							act(async () => {
								const api = formsApi(await getApi());
								const asked = await api.submissions.delete({ siteId, ids: [submission.id] });
								if (!asked.deleted) setDeleting({ confirmation: asked.confirmation.id });
							})
						}
					>
						<TrashIcon aria-hidden="true" data-icon="inline-start" />
						{t("submissions.delete")}
					</Button>
				) : null}
			</div>

			<dl className="grid gap-3 rounded-md border p-3">
				{submission.values.map((value) => (
					<div key={value.key} className="grid gap-0.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3">
						<dt className="text-muted-foreground min-w-0 text-sm break-words">{value.label}</dt>
						<dd className="min-w-0 text-sm break-words whitespace-pre-line">
							{filesOf(value) ? <Uploads files={filesOf(value) ?? []} /> : shown(value, fields, defaultLanguage, t)}
						</dd>
					</div>
				))}
			</dl>

			<section aria-labelledby={`${heading}-log`} className="grid gap-2">
				<h3 id={`${heading}-log`} className="font-semibold">
					{t("submissions.deliveries")}
				</h3>
				{deliveries.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("submissions.deliveriesNone")}</p>
				) : (
					<ul className="grid gap-2">
						{deliveries.map((delivery) => (
							<DeliveryLine key={delivery.id} delivery={delivery} />
						))}
					</ul>
				)}
			</section>

			{submission.folder === "spam" && canManage ? (
				<p className="text-muted-foreground text-xs">{t("submissions.notSpamNote")}</p>
			) : null}

			{deleting ? (
				<Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
					<DialogContent closeLabel={t("submissions.cancel")} finalFocus={deleteButton}>
						<DialogHeader>
							<DialogTitle>{t("submissions.deleteTitle")}</DialogTitle>
							<DialogDescription>{t("submissions.deleteBody")}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" />}>{t("submissions.cancel")}</DialogClose>
							<Button
								variant="destructive"
								disabled={busy}
								onClick={() =>
									act(async () => {
										const api = formsApi(await getApi());
										await api.submissions.delete({
											siteId,
											ids: [submission.id],
											confirmation: deleting.confirmation,
										});
										setDeleting(null);
										toast.success(t("submissions.deleted"));
										onGone();
									})
								}
							>
								{t("submissions.delete")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</aside>
	);
}

function DeliveryLine({ delivery }: { delivery: SubmissionDelivery }) {
	const t = useT();
	const icon: ReactNode =
		delivery.kind === "notification" ? (
			<MailIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		) : delivery.kind === "autoReply" ? (
			<ReplyIcon className="mt-0.5 size-4 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
		) : (
			<WebhookIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		);
	const what =
		delivery.kind === "notification"
			? t("submissions.deliveryNotification", { to: delivery.to })
			: delivery.kind === "autoReply"
				? t("submissions.deliveryAutoReply", { to: delivery.to })
				: t("submissions.deliveryWebhook", { name: delivery.to });
	return (
		<li className="flex items-start justify-between gap-3 text-sm">
			<span className="flex min-w-0 flex-1 items-start gap-2">
				{icon}
				<span className="grid min-w-0">
					<span className="wrap-anywhere">{what}</span>
					{delivery.problem ? (
						<span className="text-muted-foreground text-xs break-words">
							{t("submissions.deliveryProblem", { problem: delivery.problem })}
						</span>
					) : null}
					{delivery.nextAttemptAt && delivery.status === "retrying" ? (
						<span className="text-muted-foreground text-xs">
							{t("emailLog.nextAttempt", { time: formatUtc(delivery.nextAttemptAt) })}
						</span>
					) : null}
				</span>
			</span>
			<Badge
				variant={delivery.status === "sent" ? "secondary" : "outline"}
				className={`shrink-0 ${delivery.status === "failed" ? "border-destructive/60" : ""}`}
			>
				{t(DELIVERY_STATUS[delivery.status])}
			</Badge>
		</li>
	);
}
