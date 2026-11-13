import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
import {
	ArrowLeftIcon,
	CheckIcon,
	DownloadIcon,
	EllipsisIcon,
	MailIcon,
	PencilIcon,
	PlusIcon,
	SendIcon,
	TrashIcon,
	UsersIcon,
} from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc, formatUtcDate } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
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

/** What the page shows: the Dashboard's Reports, one Report's history, and one entry held for review. */
export type ReportsData = {
	dashboard: { id: string; name: string };
	reports: ReportView[];
	selected: { report: ReportView; sends: ReportSend[] } | null;
	review: ReportSendDetail | null;
};

/**
 * A Dashboard's Reports (`…/dashboards/<id>/reports`): each one's schedule, language and recipients,
 * and the history of what each sent, with its PDF. Staff set Reports up, send a test to themselves,
 * review AI text that waits for it and send one again (`report.manage`); Owners see them and change who
 * they go to (`reportRecipients.edit`).
 */
export function ReportsPage({
	place,
	data,
	canManage,
	canEditRecipients,
	dashboardPath,
}: {
	place: ReportPlace;
	data: ReportsData;
	canManage: boolean;
	canEditRecipients: boolean;
	dashboardPath: { to: string; params: Record<string, string> };
}) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const newButton = useRef<HTMLButtonElement>(null);
	const [dialog, setDialog] = useState<
		| { kind: "new" }
		| { kind: "edit" | "recipients" | "delete"; report: ReportView; from: RefObject<HTMLElement | null> }
		| null
	>(null);
	const menuButtons = useRef(new Map<string, HTMLButtonElement>());
	const reload = () => router.invalidate();
	const { dashboard, reports, selected } = data;

	const sendTest = async (report: ReportView) => {
		try {
			await (await getApi()).reports.sendTest({ ...place, reportId: report.id });
			toast.success(t("reports.testQueued"));
			await navigate({ to: ".", search: { report: report.id }, replace: true });
			await reload();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};

	return (
		<div className="space-y-10">
			<div>
				<Button variant="ghost" size="sm" render={<Link to={dashboardPath.to} params={dashboardPath.params} />}>
					<ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
					{t("reports.backToDashboard", { name: dashboard.name })}
				</Button>
			</div>
			<PageHeader
				heading={t("reports.heading", { name: dashboard.name })}
				action={
					canManage ? (
						<Button ref={newButton} onClick={() => setDialog({ kind: "new" })}>
							<PlusIcon aria-hidden="true" />
							{t("reports.new")}
						</Button>
					) : null
				}
			>
				{t("reports.intro")}
			</PageHeader>

			{reports.length === 0 ? (
				<p className="text-muted-foreground">{canManage ? t("reports.emptyStaff") : t("reports.empty")}</p>
			) : (
				<Table aria-label={t("reports.listLabel")}>
					<TableHeader>
						<TableRow>
							<TableHead scope="col">{t("reports.columns.name")}</TableHead>
							<TableHead scope="col">{t("reports.columns.schedule")}</TableHead>
							<TableHead scope="col">{t("reports.columns.language")}</TableHead>
							<TableHead scope="col">{t("reports.columns.recipients")}</TableHead>
							<TableHead scope="col">{t("reports.columns.next")}</TableHead>
							<TableHead scope="col">
								<span className="sr-only">{t("reports.columns.actions")}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{reports.map((report) => (
							<TableRow key={report.id} aria-current={selected?.report.id === report.id ? "true" : undefined}>
								<TableCell className="font-medium break-all whitespace-normal">
									<Link to="." search={{ report: report.id }} className="underline-offset-4 hover:underline">
										{report.name}
									</Link>
									{report.review ? (
										<Badge variant="outline" className="ms-2">
											{t("reports.reviewBadge")}
										</Badge>
									) : null}
								</TableCell>
								<TableCell>{t(`reports.schedules.${report.schedule}`)}</TableCell>
								<TableCell>{REPORT_LANGUAGE_NAMES[report.language as ReportLanguage] ?? report.language}</TableCell>
								<TableCell className="whitespace-normal">
									{report.recipients.length === 0 ? t("reports.nobody") : report.recipients.join(", ")}
								</TableCell>
								<TableCell>{report.nextRunAt ? formatUtc(report.nextRunAt) : t("reports.off")}</TableCell>
								<TableCell className="text-end">
									{canManage || canEditRecipients ? (
										<DropdownMenu>
											<DropdownMenuTrigger
												ref={(button) => {
													if (button) menuButtons.current.set(report.id, button);
												}}
												render={
													<Button variant="ghost" size="icon" aria-label={t("reports.menu", { name: report.name })} />
												}
											>
												<EllipsisIcon aria-hidden="true" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className="w-auto min-w-56">
												{canManage ? (
													<DropdownMenuItem
														onClick={() =>
															setDialog({
																kind: "edit",
																report,
																from: { current: menuButtons.current.get(report.id) ?? null },
															})
														}
													>
														<PencilIcon aria-hidden="true" />
														{t("reports.edit")}
													</DropdownMenuItem>
												) : null}
												<DropdownMenuItem
													onClick={() =>
														setDialog({
															kind: "recipients",
															report,
															from: { current: menuButtons.current.get(report.id) ?? null },
														})
													}
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
															onClick={() =>
																setDialog({
																	kind: "delete",
																	report,
																	from: { current: menuButtons.current.get(report.id) ?? null },
																})
															}
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
						))}
					</TableBody>
				</Table>
			)}

			{selected ? (
				<History place={place} report={selected.report} sends={selected.sends} canManage={canManage} />
			) : null}

			{dialog?.kind === "new" ? (
				<ReportDialog place={place} dashboardId={dashboard.id} onClose={() => setDialog(null)} finalFocus={newButton} />
			) : null}
			{dialog?.kind === "edit" ? (
				<ReportDialog
					place={place}
					dashboardId={dashboard.id}
					report={dialog.report}
					onClose={() => setDialog(null)}
					finalFocus={dialog.from}
				/>
			) : null}
			{dialog?.kind === "recipients" ? (
				<RecipientsDialog
					place={place}
					report={dialog.report}
					onClose={() => setDialog(null)}
					finalFocus={dialog.from}
				/>
			) : null}
			{dialog?.kind === "delete" ? (
				<DeleteDialog place={place} report={dialog.report} onClose={() => setDialog(null)} finalFocus={dialog.from} />
			) : null}
			{data.review ? <ReviewDialog place={place} send={data.review} canManage={canManage} /> : null}
		</div>
	);
}

/** A Report's history, newest first. */
function History({
	place,
	report,
	sends,
	canManage,
}: {
	place: ReportPlace;
	report: ReportView;
	sends: ReportSend[];
	canManage: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
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
	return (
		<section aria-labelledby={`${id}-heading`} className="space-y-4">
			<div className="space-y-1">
				<h2 id={`${id}-heading`} className="text-lg font-semibold">
					{t("reports.historyOf", { name: report.name })}
				</h2>
				<p className="text-muted-foreground text-sm">{t("reports.historyIntro")}</p>
			</div>
			{sends.length === 0 ? (
				<p className="text-muted-foreground">{t("reports.noHistory")}</p>
			) : (
				<Table aria-labelledby={`${id}-heading`}>
					<TableHeader>
						<TableRow>
							<TableHead scope="col">{t("reports.historyColumns.made")}</TableHead>
							<TableHead scope="col">{t("reports.historyColumns.days")}</TableHead>
							<TableHead scope="col">{t("reports.historyColumns.status")}</TableHead>
							<TableHead scope="col">{t("reports.historyColumns.ai")}</TableHead>
							<TableHead scope="col">{t("reports.historyColumns.recipients")}</TableHead>
							<TableHead scope="col">
								<span className="sr-only">{t("reports.columns.actions")}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sends.map((send) => (
							<TableRow key={send.id}>
								<TableCell>
									{formatUtc(send.createdAt)}
									{send.kind === "test" ? (
										<Badge variant="outline" className="ms-2">
											{t("reports.test")}
										</Badge>
									) : null}
								</TableCell>
								<TableCell>
									{formatUtcDate(send.period.from)} – {formatUtcDate(new Date(new Date(send.period.to).getTime() - 1))}
								</TableCell>
								<TableCell className="whitespace-normal">
									<Badge
										variant={
											send.status === "failed" ? "destructive" : send.status === "sent" ? "secondary" : "outline"
										}
									>
										{t(`reports.statuses.${send.status}`)}
									</Badge>
									{send.problem ? <span className="text-muted-foreground block text-xs">{send.problem}</span> : null}
								</TableCell>
								<TableCell className="whitespace-normal">{send.ai ? t(`reports.ai.${send.ai}`) : "–"}</TableCell>
								<TableCell className="whitespace-normal">
									<ul className="space-y-1">
										{send.recipients.map((recipient) => (
											<li key={recipient.address} className="break-all">
												{recipient.address}
												<span className="text-muted-foreground">
													{" · "}
													{recipient.status
														? t(`reports.mailStatuses.${recipient.status}` as MessageKey)
														: t("reports.mailStatuses.waiting")}
												</span>
											</li>
										))}
									</ul>
								</TableCell>
								<TableCell className="text-end">
									<div className="flex flex-wrap justify-end gap-2">
										{send.status === "review" ? (
											<Button size="sm" render={<Link to="." search={{ report: report.id, review: send.id }} />}>
												{t("reports.review")}
											</Button>
										) : null}
										{send.pdf ? (
											<Button
												size="sm"
												variant="outline"
												onClick={() => void download(send)}
												aria-label={t("reports.downloadLabel", { day: formatUtc(send.createdAt) })}
											>
												<DownloadIcon aria-hidden="true" />
												{t("reports.download")}
											</Button>
										) : null}
										{canManage && (send.status === "sent" || send.status === "failed") ? (
											<Button
												size="sm"
												variant="outline"
												onClick={() => void resend(send)}
												aria-label={t("reports.resendLabel", { day: formatUtc(send.createdAt) })}
											>
												<SendIcon aria-hidden="true" />
												{t("reports.resend")}
											</Button>
										) : null}
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
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

/** Sets up a Report, or changes one. */
function ReportDialog({
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
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("reports.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>{report ? t("reports.editTitle", { name: report.name }) : t("reports.newTitle")}</DialogTitle>
						<DialogDescription>{t("reports.dialogIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-5">
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
					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>{t("reports.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{report ? t("reports.save") : t("reports.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
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
function RecipientsDialog({
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
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("reports.close")} finalFocus={finalFocus}>
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>{t("reports.recipientsTitle", { name: report.name })}</DialogTitle>
						<DialogDescription>{t("reports.recipientsIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6">
						<RecipientsField id={id} value={recipients} onChange={setRecipients} problem={problem} />
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>{t("reports.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("reports.save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

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
	const navigate = useNavigate();
	const remove = async () => {
		try {
			await (await getApi()).reports.delete({ ...place, reportId: report.id });
			toast.success(t("reports.deleted", { name: report.name }));
			onClose();
			await navigate({ to: ".", search: {}, replace: true });
			await router.invalidate();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("reports.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("reports.deleteTitle", { name: report.name })}</DialogTitle>
					<DialogDescription>{t("reports.deleteIntro")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button type="button" variant="outline" />}>{t("reports.cancel")}</DialogClose>
					<Button variant="destructive" onClick={() => void remove()}>
						{t("reports.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * A Report waiting for review: its AI text, which Staff edit (plain text), then approve to send it,
 * or discard. Owners read it.
 */
function ReviewDialog({ place, send, canManage }: { place: ReportPlace; send: ReportSendDetail; canManage: boolean }) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const id = useId();
	const text = send.text ?? { widgets: {}, whatHappened: "", suggestions: [] };
	const [widgets, setWidgets] = useState<Record<string, string>>(text.widgets);
	const [whatHappened, setWhatHappened] = useState(text.whatHappened);
	const [suggestions, setSuggestions] = useState(text.suggestions);
	const [busy, setBusy] = useState(false);
	const held = send.status === "review";
	const editable = canManage && held;
	const close = () => void navigate({ to: ".", search: { report: send.reportId }, replace: true });
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
	return (
		<Dialog open onOpenChange={(open) => !open && close()}>
			<DialogContent closeLabel={t("reports.close")} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void act("approve");
					}}
					noValidate
				>
					<DialogHeader>
						<DialogTitle>{t("reports.reviewTitle")}</DialogTitle>
						<DialogDescription>
							{held ? t("reports.reviewIntro") : t(`reports.statuses.${send.status}`)}
						</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-5">
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
						{send.widgets.map((widget) => (
							<Field key={widget.id}>
								<FieldLabel htmlFor={`${id}-${widget.id}`}>
									{t("reports.aboutWidget", { title: widget.title })}
								</FieldLabel>
								<Textarea
									id={`${id}-${widget.id}`}
									value={widgets[widget.id] ?? ""}
									rows={2}
									readOnly={!editable}
									onChange={(change) => setWidgets((current) => ({ ...current, [widget.id]: change.target.value }))}
								/>
							</Field>
						))}
						<FieldSet>
							<FieldLegend variant="label">{t("reports.suggestions")}</FieldLegend>
							{suggestions.length === 0 ? (
								<p className="text-muted-foreground text-sm">{t("reports.noSuggestions")}</p>
							) : null}
							{suggestions.map((suggestion, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: suggestions are kept in their order.
								<div key={index} className="grid gap-2 rounded-md border p-3">
									<Field>
										<FieldLabel htmlFor={`${id}-suggestion-${index}`}>
											{t("reports.suggestionN", { n: index + 1 })}
										</FieldLabel>
										<Textarea
											id={`${id}-suggestion-${index}`}
											value={suggestion.text}
											rows={2}
											readOnly={!editable}
											onChange={(change) =>
												setSuggestions((current) =>
													current.map((each, at) => (at === index ? { ...each, text: change.target.value } : each)),
												)
											}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor={`${id}-service-${index}`}>{t("reports.relatedService")}</FieldLabel>
										<NativeSelect
											id={`${id}-service-${index}`}
											value={suggestion.service ?? ""}
											disabled={!editable}
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
									{editable ? (
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
									) : null}
								</div>
							))}
						</FieldSet>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>{t("reports.close")}</DialogClose>
						{editable ? (
							<>
								<Button type="button" variant="destructive" disabled={busy} onClick={() => void act("discard")}>
									{t("reports.discard")}
								</Button>
								<Button type="submit" disabled={busy}>
									<CheckIcon aria-hidden="true" />
									{t("reports.approve")}
								</Button>
							</>
						) : null}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
