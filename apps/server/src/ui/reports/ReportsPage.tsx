import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	DownloadIcon,
	EllipsisIcon,
	EyeIcon,
	MailIcon,
	PencilIcon,
	PlusIcon,
	RotateCwIcon,
	SparklesIcon,
	TrashIcon,
	UsersIcon,
} from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { cellClass, headClass, headRowClass, TableFrame } from "../analytics/parts.tsx";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { StateBadge, type StateTone, Switch } from "../settings/layout.tsx";
import { PageSheet } from "../shell/page.tsx";
import {
	downloadPdf,
	REPORT_LANGUAGE_NAMES,
	type ReportLanguage,
	type ReportPlace,
	type ReportSend,
	type ReportSendDetail,
	type ReportView,
	recipientsFrom,
} from "./model.ts";

/** What the page shows: the Dashboard's Reports, what they sent (newest first), and one entry opened for review. */
export type ReportsData = {
	dashboard: { id: string; name: string };
	reports: ReportView[];
	sent: ReportSend[];
	review: ReportSendDetail | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/**
 * Days as the Reports page says them, in UTC as every admin date is (`ui/format.ts`), in words that
 * read the same on the server and in the browser: a period ("1–31 October 2026"), the day a Report
 * was made ("Today", "8 November") and the day it goes out next ("1 Dec").
 */
function useDays() {
	const t = useT();
	const month = (date: Date) => t(`reports.months.${MONTHS[date.getUTCMonth()] ?? "jan"}` as MessageKey);
	const short = (date: Date) => t(`content.when.months.${MONTHS[date.getUTCMonth()] ?? "jan"}` as MessageKey);
	return {
		/** A period, its last day counted: `to` is where it ends, the start of the day after. */
		period(range: { from: Date | string; to: Date | string }): string {
			const from = new Date(range.from);
			const last = new Date(new Date(range.to).getTime() - 1);
			if (from.getUTCFullYear() !== last.getUTCFullYear()) {
				return t("reports.period.other", {
					fromDay: from.getUTCDate(),
					fromMonth: month(from),
					fromYear: from.getUTCFullYear(),
					toDay: last.getUTCDate(),
					toMonth: month(last),
					toYear: last.getUTCFullYear(),
				});
			}
			if (from.getUTCMonth() !== last.getUTCMonth()) {
				return t("reports.period.sameYear", {
					fromDay: from.getUTCDate(),
					fromMonth: month(from),
					toDay: last.getUTCDate(),
					toMonth: month(last),
					year: last.getUTCFullYear(),
				});
			}
			return t("reports.period.sameMonth", {
				fromDay: from.getUTCDate(),
				toDay: last.getUTCDate(),
				month: month(last),
				year: last.getUTCFullYear(),
			});
		},
		/** The day something was made: today, yesterday, or the day. */
		made(value: Date | string, now = new Date()): string {
			const date = new Date(value);
			const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
			if (date.getTime() >= today) return t("reports.made.today");
			if (date.getTime() >= today - DAY_MS) return t("reports.made.yesterday");
			return date.getUTCFullYear() === now.getUTCFullYear()
				? t("reports.made.day", { day: date.getUTCDate(), month: month(date) })
				: t("reports.made.dayYear", { day: date.getUTCDate(), month: month(date), year: date.getUTCFullYear() });
		},
		/** The day something happens next, short. */
		next(value: Date | string, now = new Date()): string {
			const date = new Date(value);
			return date.getUTCFullYear() === now.getUTCFullYear()
				? t("content.when.day", { day: date.getUTCDate(), month: short(date) })
				: t("content.when.dayYear", { day: date.getUTCDate(), month: short(date), year: date.getUTCFullYear() });
		},
	};
}

/** A send's state as a badge: what it means, in words. */
const STATE_TONES: Record<ReportSend["status"], StateTone> = {
	preparing: "info",
	review: "warning",
	rendering: "info",
	sent: "success",
	failed: "danger",
	discarded: "neutral",
};

/**
 * A Dashboard's Reports (`…/dashboards/<id>/reports`): the schedules (each one's name, how often,
 * language, recipients, next run, and whether it goes out), then what they sent, each with its
 * period, when it was made, its state in words and what can be done with it (its PDF, sending it
 * again, reviewing its AI text). Staff set Reports up, send a test to themselves, review AI text that
 * waits for it and send one again (`report.manage`); Owners see them and change who they go to
 * (`reportRecipients.edit`).
 */
export function ReportsPage({
	place,
	data,
	canManage,
	canEditRecipients,
}: {
	place: ReportPlace;
	data: ReportsData;
	canManage: boolean;
	canEditRecipients: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const days = useDays();
	const runSensitive = useSensitiveAction();
	const newButton = useRef<HTMLButtonElement>(null);
	const [dialog, setDialog] = useState<
		| { kind: "new" }
		| { kind: "edit" | "recipients" | "delete"; report: ReportView; from: RefObject<HTMLElement | null> }
		| null
	>(null);
	const menuButtons = useRef(new Map<string, HTMLButtonElement>());
	const reload = () => router.invalidate();
	const { dashboard, reports } = data;
	const from = (report: ReportView) => ({ current: menuButtons.current.get(report.id) ?? null });

	const sendTest = async (report: ReportView) => {
		try {
			await (await getApi()).reports.sendTest({ ...place, reportId: report.id });
			toast.success(t("reports.testQueued"));
			await reload();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	// A switch shows its new state at once, until the page has loaded what was saved.
	const [switched, setSwitched] = useState<Record<string, boolean>>({});
	const setActive = async (report: ReportView, active: boolean) => {
		setSwitched((current) => ({ ...current, [report.id]: active }));
		try {
			const api = await getApi();
			await runSensitive(() => api.reports.update({ ...place, reportId: report.id, active }));
			toast.success(t(active ? "reports.turnedOn" : "reports.turnedOff", { name: report.name }));
			await reload();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setSwitched(({ [report.id]: _done, ...rest }) => rest);
		}
	};

	return (
		<>
			<PageHeader
				heading={t("reports.heading")}
				action={
					canManage ? (
						<Button ref={newButton} onClick={() => setDialog({ kind: "new" })}>
							<PlusIcon aria-hidden="true" />
							{t("reports.new")}
						</Button>
					) : null
				}
			>
				{t("reports.intro", { name: dashboard.name })}
			</PageHeader>

			<div className="grid gap-8">
				<TableFrame>
					<Table aria-label={t("reports.listLabel")} className="min-w-180 table-fixed">
						<colgroup>
							<col />
							<col className="w-28" />
							<col className="w-28" />
							<col className="w-34" />
							<col className="w-26" />
							<col className="w-20" />
							<col className="w-14" />
						</colgroup>
						<TableHeader>
							<TableRow className={headRowClass}>
								<TableHead scope="col" className={headClass}>
									{t("reports.columns.name")}
								</TableHead>
								<TableHead scope="col" className={headClass}>
									{t("reports.columns.schedule")}
								</TableHead>
								<TableHead scope="col" className={headClass}>
									{t("reports.columns.language")}
								</TableHead>
								<TableHead scope="col" className={headClass}>
									{t("reports.columns.recipients")}
								</TableHead>
								<TableHead scope="col" className={headClass}>
									{t("reports.columns.next")}
								</TableHead>
								<TableHead scope="col" className={headClass}>
									{t("reports.columns.active")}
								</TableHead>
								<TableHead scope="col" className={headClass}>
									<span className="sr-only">{t("reports.columns.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{reports.length === 0 ? (
								<TableRow className="hover:bg-transparent">
									<TableCell colSpan={7} className="text-muted-foreground px-4 py-8 text-center whitespace-normal">
										{canManage ? t("reports.emptyStaff") : t("reports.empty")}
									</TableCell>
								</TableRow>
							) : (
								reports.map((report) => (
									<TableRow key={report.id}>
										<TableCell className={cellClass}>
											<span className="flex min-w-0 items-center gap-2">
												<span className="truncate font-medium" title={report.name}>
													{report.name}
												</span>
												{report.review ? <StateBadge>{t("reports.reviewBadge")}</StateBadge> : null}
											</span>
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground")}>
											{t(`reports.howOften.${report.schedule}`)}
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground")}>
											{REPORT_LANGUAGE_NAMES[report.language as ReportLanguage] ?? report.language}
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground")} title={report.recipients.join(", ")}>
											{t("reports.recipientCount", { count: report.recipients.length })}
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground")}>
											{report.nextRunAt ? (
												<time dateTime={new Date(report.nextRunAt).toISOString()} title={formatUtc(report.nextRunAt)}>
													{days.next(report.nextRunAt)}
												</time>
											) : (
												t("reports.off")
											)}
										</TableCell>
										<TableCell className={cellClass}>
											<Switch
												checked={switched[report.id] ?? report.active}
												disabled={!canManage}
												onCheckedChange={(active) => void setActive(report, active)}
												aria-label={t("reports.activeLabel", { name: report.name })}
											/>
										</TableCell>
										<TableCell className={cn(cellClass, "text-end")}>
											{canManage || canEditRecipients ? (
												<DropdownMenu>
													<DropdownMenuTrigger
														ref={(button) => {
															if (button) menuButtons.current.set(report.id, button);
														}}
														render={
															<Button
																variant="ghost"
																size="icon-sm"
																aria-label={t("reports.menu", { name: report.name })}
															/>
														}
													>
														<EllipsisIcon aria-hidden="true" />
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end" className="w-auto min-w-56">
														{canManage ? (
															<DropdownMenuItem onClick={() => setDialog({ kind: "edit", report, from: from(report) })}>
																<PencilIcon aria-hidden="true" />
																{t("reports.edit")}
															</DropdownMenuItem>
														) : null}
														<DropdownMenuItem
															onClick={() => setDialog({ kind: "recipients", report, from: from(report) })}
														>
															<UsersIcon aria-hidden="true" />
															{t("reports.changeRecipients")}
														</DropdownMenuItem>
														{canManage ? (
															<>
																<DropdownMenuItem onClick={() => void sendTest(report)}>
																	<MailIcon aria-hidden="true" />
																	{t("reports.sendTest")}
																</DropdownMenuItem>
																<DropdownMenuSeparator />
																<DropdownMenuItem
																	variant="destructive"
																	onClick={() => setDialog({ kind: "delete", report, from: from(report) })}
																>
																	<TrashIcon aria-hidden="true" />
																	{t("reports.delete")}
																</DropdownMenuItem>
															</>
														) : null}
													</DropdownMenuContent>
												</DropdownMenu>
											) : null}
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</TableFrame>

				<Sent place={place} reports={reports} sent={data.sent} canManage={canManage} />
			</div>

			{dialog?.kind === "new" ? (
				<ReportSheet place={place} dashboardId={dashboard.id} onClose={() => setDialog(null)} finalFocus={newButton} />
			) : null}
			{dialog?.kind === "edit" ? (
				<ReportSheet
					place={place}
					dashboardId={dashboard.id}
					report={dialog.report}
					onClose={() => setDialog(null)}
					finalFocus={dialog.from}
				/>
			) : null}
			{dialog?.kind === "recipients" ? (
				<RecipientsSheet
					place={place}
					report={dialog.report}
					onClose={() => setDialog(null)}
					finalFocus={dialog.from}
				/>
			) : null}
			{dialog?.kind === "delete" ? (
				<DeleteDialog place={place} report={dialog.report} onClose={() => setDialog(null)} finalFocus={dialog.from} />
			) : null}
			{data.review ? <ReviewSheet place={place} send={data.review} canManage={canManage} /> : null}
		</>
	);
}

/** What the Dashboard's Reports sent, newest first: each one's period, when it was made, its state and its action. */
function Sent({
	place,
	reports,
	sent,
	canManage,
}: {
	place: ReportPlace;
	reports: ReportView[];
	sent: ReportSend[];
	canManage: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const days = useDays();
	const download = async (send: ReportSend) => {
		try {
			downloadPdf(await (await getApi()).reports.sends.pdf({ ...place, sendId: send.id }));
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	const resend = async (send: ReportSend) => {
		try {
			await (await getApi()).reports.sends.resend({ ...place, sendId: send.id });
			toast.success(t("reports.resent"));
			await router.invalidate();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	// With more than one Report, each entry says whose it is.
	const nameOf = (send: ReportSend) =>
		reports.length > 1 ? reports.find((report) => report.id === send.reportId)?.name : undefined;
	return (
		<section aria-labelledby={`${id}-heading`} className="grid gap-3">
			<h2 id={`${id}-heading`} className="text-base font-semibold">
				{t("reports.sent")}
			</h2>
			<TableFrame>
				<Table aria-labelledby={`${id}-heading`} className="min-w-180 table-fixed">
					<colgroup>
						<col />
						<col className="w-32" />
						<col className="w-52" />
						<col className="w-56" />
					</colgroup>
					<TableHeader>
						<TableRow className={headRowClass}>
							<TableHead scope="col" className={headClass}>
								{t("reports.sentColumns.period")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("reports.sentColumns.made")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("reports.sentColumns.state")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("reports.sentColumns.action")}
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sent.length === 0 ? (
							<TableRow className="hover:bg-transparent">
								<TableCell colSpan={4} className="text-muted-foreground px-4 py-8 text-center whitespace-normal">
									{t("reports.noHistory")}
								</TableCell>
							</TableRow>
						) : (
							sent.map((send) => {
								const period = days.period(send.period);
								const whose = nameOf(send);
								const note =
									send.problem ??
									(send.ai === "noKey" || send.ai === "cap" || send.ai === "failed"
										? t("reports.aiNote", { state: t(`reports.ai.${send.ai}`) })
										: null);
								const pdfButton = (label: boolean) =>
									send.pdf ? (
										<Button
											size={label ? "xs" : "icon-xs"}
											variant="outline"
											onClick={() => void download(send)}
											aria-label={t("reports.downloadLabel", { period })}
											title={label ? undefined : t("reports.downloadPdf")}
										>
											<DownloadIcon aria-hidden="true" />
											{label ? t("reports.downloadPdf") : null}
										</Button>
									) : null;
								const resendButton = (label: boolean) =>
									canManage && (send.status === "sent" || send.status === "failed") ? (
										<Button
											size={label ? "xs" : "icon-xs"}
											variant="outline"
											onClick={() => void resend(send)}
											aria-label={t("reports.resendLabel", { period })}
											title={label ? undefined : t("reports.resend")}
										>
											<RotateCwIcon aria-hidden="true" />
											{label ? t("reports.resend") : null}
										</Button>
									) : null;
								return (
									<TableRow key={send.id}>
										<TableCell className={cn(cellClass, "py-2")}>
											<span className="flex min-w-0 items-center gap-2">
												<span className="truncate font-medium">{period}</span>
												{send.kind === "test" ? <StateBadge>{t("reports.test")}</StateBadge> : null}
											</span>
											{whose ? <span className="text-muted-foreground block truncate text-xs">{whose}</span> : null}
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground")}>
											<time
												dateTime={new Date(send.createdAt).toISOString()}
												title={formatUtc(send.createdAt)}
												// The server draws first and the day may turn before the page wakes: only the words differ.
												suppressHydrationWarning
											>
												{days.made(send.createdAt)}
											</time>
										</TableCell>
										<TableCell className={cn(cellClass, "py-2 whitespace-normal")}>
											<StateBadge tone={STATE_TONES[send.status]}>{t(`reports.statuses.${send.status}`)}</StateBadge>
											{note ? (
												<span className="text-muted-foreground mt-1 block truncate text-xs" title={note}>
													{note}
												</span>
											) : null}
										</TableCell>
										<TableCell className={cellClass}>
											<span className="flex items-center gap-1.5">
												{send.status === "review" ? (
													<Button
														size="xs"
														variant="outline"
														render={<Link to="." search={{ review: send.id }} />}
														aria-label={t("reports.reviewLabel", { period })}
													>
														<EyeIcon aria-hidden="true" />
														{t("reports.review")}
													</Button>
												) : send.status === "failed" ? (
													<>
														{resendButton(true)}
														{pdfButton(false)}
													</>
												) : (
													<>
														{pdfButton(true)}
														{resendButton(false)}
													</>
												)}
											</span>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</TableFrame>
		</section>
	);
}

type Problem = { field: "name" | "recipients" | null; message: MessageKey };

function problemOf(error: unknown): Problem {
	const { code, data } = (error ?? {}) as { code?: string; data?: { field?: string } };
	if (code === "REPORT_INVALID" && (data?.field === "name" || data?.field === "recipients")) {
		return { field: data.field, message: errorMessage(error) };
	}
	return { field: null, message: errorMessage(error) };
}

/** Sets up a Report, or changes one: a sheet over the page. */
function ReportSheet({
	place,
	dashboardId,
	report,
	onClose,
	finalFocus,
}: {
	place: ReportPlace;
	dashboardId: string;
	report?: ReportView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(report?.name ?? "");
	const [schedule, setSchedule] = useState<"weekly" | "monthly">(report?.schedule ?? "weekly");
	const [language, setLanguage] = useState<ReportLanguage>((report?.language as ReportLanguage) ?? "en");
	const [recipients, setRecipients] = useState(report?.recipients.join("\n") ?? "");
	const [review, setReview] = useState(report?.review ?? false);
	const [active, setActive] = useState(report?.active ?? true);
	const runSensitive = useSensitiveAction();
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		const fields = { name, schedule, language, recipients: recipientsFrom(recipients), review, active };
		try {
			const api = await getApi();
			// Changing who receives it is a Sensitive action: "Confirm it's you" when the last check is old.
			await runSensitive(() =>
				report
					? api.reports.update({ ...place, reportId: report.id, ...fields })
					: api.reports.create({ ...place, dashboardId, ...fields }),
			);
			toast.success(t(report ? "reports.saved" : "reports.created", { name: name.trim() }));
			onClose();
			await router.invalidate();
		} catch (error) {
			const found = problemOf(error);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={report ? t("reports.editTitle", { name: report.name }) : t("reports.newTitle")}
			description={t("reports.dialogIntro")}
			finalFocus={finalFocus}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("reports.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy}>
						{report ? t("reports.save") : t("reports.create")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate>
				<FieldGroup className="gap-5">
					<Field data-invalid={problem?.field === "name" ? true : undefined}>
						<FieldLabel htmlFor={`${id}-name`}>{t("reports.name")}</FieldLabel>
						<Input
							id={`${id}-name`}
							value={name}
							required
							maxLength={100}
							onChange={(change) => setName(change.target.value)}
							aria-invalid={problem?.field === "name" ? true : undefined}
							aria-describedby={problem?.field === "name" ? `${id}-name-error` : undefined}
						/>
						{problem?.field === "name" ? <FieldError id={`${id}-name-error`}>{t(problem.message)}</FieldError> : null}
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-schedule`}>{t("reports.schedule")}</FieldLabel>
						<NativeSelect
							id={`${id}-schedule`}
							className="w-full"
							value={schedule}
							onChange={(change) => setSchedule(change.target.value as "weekly" | "monthly")}
							aria-describedby={`${id}-schedule-help`}
						>
							<NativeSelectOption value="weekly">{t("reports.schedules.weekly")}</NativeSelectOption>
							<NativeSelectOption value="monthly">{t("reports.schedules.monthly")}</NativeSelectOption>
						</NativeSelect>
						<FieldDescription id={`${id}-schedule-help`}>{t("reports.scheduleHelp")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-language`}>{t("reports.language")}</FieldLabel>
						<NativeSelect
							id={`${id}-language`}
							className="w-full"
							value={language}
							onChange={(change) => setLanguage(change.target.value as ReportLanguage)}
							aria-describedby={`${id}-language-help`}
						>
							{Object.entries(REPORT_LANGUAGE_NAMES).map(([code, label]) => (
								<NativeSelectOption key={code} value={code} lang={code}>
									{label}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<FieldDescription id={`${id}-language-help`}>{t("reports.languageHelp")}</FieldDescription>
					</Field>
					<RecipientsField id={id} value={recipients} onChange={setRecipients} problem={problem} />
					<FieldSet>
						<FieldLegend variant="label">{t("reports.sending")}</FieldLegend>
						<Field orientation="horizontal">
							<Checkbox
								id={`${id}-review`}
								checked={review}
								onCheckedChange={(checked) => setReview(checked === true)}
								aria-describedby={`${id}-review-help`}
							/>
							<div className="grid gap-1">
								<FieldLabel htmlFor={`${id}-review`}>{t("reports.holdForReview")}</FieldLabel>
								<FieldDescription id={`${id}-review-help`}>{t("reports.holdForReviewHelp")}</FieldDescription>
							</div>
						</Field>
						<Field orientation="horizontal">
							<Checkbox
								id={`${id}-active`}
								checked={active}
								onCheckedChange={(checked) => setActive(checked === true)}
							/>
							<FieldLabel htmlFor={`${id}-active`}>{t("reports.active")}</FieldLabel>
						</Field>
					</FieldSet>
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

function RecipientsField({
	id,
	value,
	onChange,
	problem,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	problem: Problem | null;
}) {
	const t = useT();
	const invalid = problem?.field === "recipients";
	return (
		<Field data-invalid={invalid ? true : undefined}>
			<FieldLabel htmlFor={`${id}-recipients`}>{t("reports.recipients")}</FieldLabel>
			<Textarea
				id={`${id}-recipients`}
				value={value}
				rows={4}
				spellCheck={false}
				onChange={(change) => onChange(change.target.value)}
				aria-invalid={invalid ? true : undefined}
				aria-describedby={`${id}-recipients-help${invalid ? ` ${id}-recipients-error` : ""}`}
			/>
			<FieldDescription id={`${id}-recipients-help`}>{t("reports.recipientsHelp")}</FieldDescription>
			{invalid && problem ? <FieldError id={`${id}-recipients-error`}>{t(problem.message)}</FieldError> : null}
		</Field>
	);
}

/** Changes who a Report goes to: what Owners may change too. */
function RecipientsSheet({
	place,
	report,
	onClose,
	finalFocus,
}: {
	place: ReportPlace;
	report: ReportView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [recipients, setRecipients] = useState(report.recipients.join("\n"));
	const runSensitive = useSensitiveAction();
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			// A Sensitive action: "Confirm it's you" when the last check is old.
			await runSensitive(() =>
				api.reports.setRecipients({ ...place, reportId: report.id, recipients: recipientsFrom(recipients) }),
			);
			toast.success(t("reports.recipientsSaved", { name: report.name }));
			onClose();
			await router.invalidate();
		} catch (error) {
			const found = problemOf(error);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("reports.recipientsTitle", { name: report.name })}
			description={t("reports.recipientsIntro")}
			finalFocus={finalFocus}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("reports.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy}>
						{t("reports.save")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate>
				<FieldGroup>
					<RecipientsField id={id} value={recipients} onChange={setRecipients} problem={problem} />
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

/** Deleting a Report: it names the Report, and focus starts on Cancel. */
function DeleteDialog({
	place,
	report,
	onClose,
	finalFocus,
}: {
	place: ReportPlace;
	report: ReportView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const cancel = useRef<HTMLButtonElement>(null);
	const remove = async () => {
		try {
			await (await getApi()).reports.delete({ ...place, reportId: report.id });
			toast.success(t("reports.deleted", { name: report.name }));
			onClose();
			await router.invalidate();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("reports.close")} initialFocus={cancel} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("reports.deleteTitle", { name: report.name })}</DialogTitle>
					<DialogDescription>{t("reports.deleteIntro")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose ref={cancel} render={<Button type="button" variant="outline" />}>
						{t("reports.cancel")}
					</DialogClose>
					<Button variant="destructive" onClick={() => void remove()}>
						{t("reports.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Review before it goes: a Report waiting for review, as a sheet over the page. What happened (which
 * Staff may change), a line per Widget and the suggestions, each with the Service it points to; Staff
 * may change those too ("Change the text"), then approve to send it, or discard it. Owners read it.
 */
function ReviewSheet({ place, send, canManage }: { place: ReportPlace; send: ReportSendDetail; canManage: boolean }) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const days = useDays();
	const id = useId();
	const text = send.text ?? { widgets: {}, whatHappened: "", suggestions: [] };
	const [widgets, setWidgets] = useState<Record<string, string>>(text.widgets);
	const [whatHappened, setWhatHappened] = useState(text.whatHappened);
	const [suggestions, setSuggestions] = useState(text.suggestions);
	const [changing, setChanging] = useState(false);
	const [busy, setBusy] = useState(false);
	const held = send.status === "review";
	const editable = canManage && held;
	const close = () => void navigate({ to: ".", search: {}, replace: true });
	const serviceName = (serviceId: string | null) =>
		serviceId ? send.services.find((service) => service.id === serviceId)?.name : undefined;
	const act = async (action: "approve" | "discard") => {
		setBusy(true);
		try {
			const api = await getApi();
			if (action === "approve") {
				await api.reports.sends.editText({ ...place, sendId: send.id, text: { widgets, whatHappened, suggestions } });
				await api.reports.sends.approve({ ...place, sendId: send.id });
				toast.success(t("reports.approved"));
			} else {
				await api.reports.sends.discard({ ...place, sendId: send.id });
				toast.success(t("reports.discarded"));
			}
			close();
			await router.invalidate();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const noted = send.widgets.filter((widget) => changing || (widgets[widget.id] ?? "").trim() !== "");
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && close()}
			title={t("reports.reviewTitle")}
			description={
				held ? t("reports.reviewIntro", { period: days.period(send.period) }) : t(`reports.statuses.${send.status}`)
			}
			className="data-[side=right]:sm:max-w-95"
			footer={
				editable ? (
					<>
						<Button type="button" variant="outline" disabled={busy} onClick={() => void act("discard")}>
							{t("reports.discard")}
						</Button>
						<Button type="submit" form={`${id}-form`} disabled={busy}>
							{t("reports.approve")}
						</Button>
					</>
				) : (
					<Button type="button" variant="outline" onClick={close}>
						{t("reports.close")}
					</Button>
				)
			}
		>
			<form
				id={`${id}-form`}
				onSubmit={(event) => {
					event.preventDefault();
					void act("approve");
				}}
				noValidate
			>
				<FieldGroup className="gap-5">
					<Field>
						<FieldLabel htmlFor={`${id}-what`}>{t("reports.whatHappened")}</FieldLabel>
						<Textarea
							id={`${id}-what`}
							value={whatHappened}
							rows={4}
							readOnly={!editable}
							onChange={(change) => setWhatHappened(change.target.value)}
						/>
					</Field>
					{noted.length > 0 ? (
						<FieldSet className="gap-2">
							<FieldLegend variant="label" className="mb-0">
								{t("reports.perWidget")}
							</FieldLegend>
							{changing
								? noted.map((widget) => (
										<Field key={widget.id}>
											<FieldLabel htmlFor={`${id}-${widget.id}`} className="text-[13px]">
												{t("reports.aboutWidget", { title: widget.title })}
											</FieldLabel>
											<Textarea
												id={`${id}-${widget.id}`}
												value={widgets[widget.id] ?? ""}
												rows={2}
												onChange={(change) =>
													setWidgets((current) => ({ ...current, [widget.id]: change.target.value }))
												}
											/>
										</Field>
									))
								: noted.map((widget) => (
										<p key={widget.id} className="text-[13px]">
											<span className="font-semibold">{widget.title}:</span>{" "}
											<span className="text-muted-foreground">{widgets[widget.id]}</span>
										</p>
									))}
						</FieldSet>
					) : null}
					<FieldSet className="gap-2.5">
						<FieldLegend variant="label" className="mb-0">
							{t("reports.suggestions")}
						</FieldLegend>
						{suggestions.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("reports.noSuggestions")}</p>
						) : null}
						{suggestions.map((suggestion, index) =>
							changing ? (
								// biome-ignore lint/suspicious/noArrayIndexKey: suggestions are kept in their order.
								<div key={index} className="bg-muted grid gap-2 rounded-[10px] p-3">
									<Field>
										<FieldLabel htmlFor={`${id}-suggestion-${index}`} className="text-[13px]">
											{t("reports.suggestionN", { n: index + 1 })}
										</FieldLabel>
										<Textarea
											id={`${id}-suggestion-${index}`}
											value={suggestion.text}
											rows={2}
											onChange={(change) =>
												setSuggestions((current) =>
													current.map((each, at) => (at === index ? { ...each, text: change.target.value } : each)),
												)
											}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor={`${id}-service-${index}`} className="text-[13px]">
											{t("reports.relatedService")}
										</FieldLabel>
										<NativeSelect
											id={`${id}-service-${index}`}
											className="w-full"
											value={suggestion.service ?? ""}
											onChange={(change) =>
												setSuggestions((current) =>
													current.map((each, at) =>
														at === index ? { ...each, service: change.target.value || null } : each,
													),
												)
											}
										>
											<NativeSelectOption value="">{t("reports.noService")}</NativeSelectOption>
											{send.services.map((service) => (
												<NativeSelectOption key={service.id} value={service.id}>
													{service.name}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</Field>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="justify-self-start"
										onClick={() => setSuggestions((current) => current.filter((_, at) => at !== index))}
									>
										<TrashIcon aria-hidden="true" />
										{t("reports.removeSuggestion", { n: index + 1 })}
									</Button>
								</div>
							) : (
								// biome-ignore lint/suspicious/noArrayIndexKey: suggestions are kept in their order.
								<div key={index} className="bg-muted grid justify-items-start gap-2 rounded-[10px] p-3">
									<p className="text-[13px]">{suggestion.text}</p>
									{serviceName(suggestion.service) ? (
										<StateBadge className="gap-1">
											<SparklesIcon aria-hidden="true" className="size-3" />
											<span className="sr-only">{t("reports.relatedService")}: </span>
											{serviceName(suggestion.service)}
										</StateBadge>
									) : null}
								</div>
							),
						)}
					</FieldSet>
					{editable && !changing ? (
						<div>
							<Button type="button" variant="ghost" size="sm" onClick={() => setChanging(true)}>
								<PencilIcon aria-hidden="true" />
								{t("reports.changeText")}
							</Button>
						</div>
					) : null}
				</FieldGroup>
			</form>
		</PageSheet>
	);
}
