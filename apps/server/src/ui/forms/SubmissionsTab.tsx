import type { FormField } from "@webcraft/renderer/forms";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { DownloadIcon, InboxIcon, PaperclipIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocale } from "use-intl";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { Segmented } from "../filters/Segmented.tsx";
import { useT } from "../i18n.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import {
	type Folder,
	firstLineOf,
	formsApi,
	hasFiles,
	type Listed,
	type ReadFilter,
	rowTime,
	type Submission,
	senderOf,
	senderValueOf,
} from "./mailbox.ts";
import { type DetailActions, SubmissionDetail } from "./SubmissionDetail.tsx";

/** How many more Submissions "Show more" brings, and the most the list holds at once. */
const PAGE_SIZE = 25;
const LIST_MOST = 200;

/** How long a Form may keep its Submissions: forever (null), or a number of days. */
const KEEP_CHOICES = [null, 30, 90, 365] as const;

/**
 * The Submissions tab (the Forms Module, for Staff, Owners and Editors), a mailbox (frame 01): the
 * list on the left, 400 wide, the chosen Submission on the right, both filling the page. The list has
 * Inbox and Spam (with how many Spam holds), a search, All or Unread, the language when the Site has
 * more than one, and Export; each row has an unread dot, who sent it, the first line of what they
 * wrote, when, and a clip when files came. J and K move through the list, U marks the open one
 * unread, Delete removes it after asking. Opening one marks it read; whatever changes a
 * Submission's state tells the sidebar's counts (`onCountsChanged`).
 */
export function SubmissionsTab({
	siteId,
	formId,
	fields,
	languages,
	defaultLanguage,
	canManage,
	canResend,
	placedOn,
	initialSubmission,
	onSelect,
	onCountsChanged,
}: {
	siteId: string;
	formId: string;
	/** The Form's fields, to show a choice by its label. */
	fields: readonly FormField[];
	languages: readonly string[];
	defaultLanguage: string;
	/** Whether the person may delete, take out of spam and choose how long they are kept. */
	canManage: boolean;
	/** Whether the person may send a failed Webhook call again (Staff). */
	canResend: boolean;
	/** Where the Form is placed, in words, for the empty inbox. */
	placedOn: readonly string[];
	initialSubmission?: string;
	onSelect?(submissionId: string | null): void;
	/** A Submission was read, marked unread, taken out of Spam or deleted. */
	onCountsChanged?(): void;
}) {
	const t = useT();
	const locale = useLocale();
	const [folder, setFolder] = useState<Folder>("inbox");
	const [typed, setTyped] = useState("");
	const [search, setSearch] = useState("");
	const [read, setRead] = useState<ReadFilter>("all");
	const [language, setLanguage] = useState("");
	const [shown, setShown] = useState(PAGE_SIZE);
	const [listed, setListed] = useState<Listed | null>(null);
	const [selected, setSelected] = useState<string | null>(initialSubmission ?? null);
	const [refreshed, setRefreshed] = useState(0);
	const [exporting, setExporting] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const actions = useRef<DetailActions | null>(null);
	// The translator, for effects that report a failure without running again when it changes.
	const words = useRef(t);
	words.current = t;

	// What is typed in the search box is searched for once typing pauses.
	useEffect(() => {
		const timer = setTimeout(() => {
			setSearch(typed.trim());
			setShown(PAGE_SIZE);
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
					limit: Math.min(shown, LIST_MOST),
					offset: 0,
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
	}, [siteId, formId, folder, read, search, language, shown, refreshed]);

	const items = listed?.submissions ?? [];
	const changed = useCallback(() => {
		setRefreshed((count) => count + 1);
		onCountsChanged?.();
	}, [onCountsChanged]);
	const choose = useCallback(
		(id: string | null) => {
			setSelected(id);
			onSelect?.(id);
		},
		[onSelect],
	);
	const filtersChange = () => {
		setShown(PAGE_SIZE);
		choose(null);
	};

	// The mailbox's keys, while its tab shows and nobody is typing or in a dialog.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
			const container = root.current;
			if (!container || container.closest("[hidden]") || container.offsetParent === null) return;
			const target = event.target as HTMLElement | null;
			if (
				target?.closest(
					'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
				)
			) {
				return;
			}
			const key = event.key.toLowerCase();
			if (key === "j" || key === "k") {
				if (items.length === 0) return;
				const at = items.findIndex((item) => item.id === selected);
				const next = at < 0 ? 0 : key === "j" ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0);
				const target = items[next];
				if (!target) return;
				event.preventDefault();
				choose(target.id);
				const row = list.current?.querySelector<HTMLButtonElement>(`[data-submission="${target.id}"]`);
				row?.scrollIntoView({ block: "nearest", inline: "nearest" });
				if (list.current?.contains(document.activeElement)) row?.focus();
			} else if (key === "u") {
				if (!actions.current) return;
				event.preventDefault();
				actions.current.markUnread();
			} else if (key === "delete" || key === "backspace") {
				if (!actions.current || !canManage) return;
				event.preventDefault();
				actions.current.askDelete();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [items, selected, choose, canManage]);

	// The labels of the fields that say who sent each Submission, so Export can leave them out.
	const senderLabels = useMemo(() => {
		const labels = new Set<string>();
		for (const submission of items) {
			const sender = senderValueOf(submission);
			if (sender) labels.add(sender.label);
			const email = submission.values.find((value) => value.type === "email");
			if (email) labels.add(email.label);
		}
		return labels;
	}, [items]);

	const filtered = Boolean(search || read !== "all" || language);
	const total = listed?.total ?? 0;
	const now = new Date();
	const timeWords = {
		yesterday: t("submissions.yesterday"),
		daysAgo: (days: number) => t("submissions.daysAgo", { days }),
	};

	return (
		<div
			ref={root}
			className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[10px] border @3xl/page:h-[calc(100dvh-15.5rem)] @3xl/page:min-h-[30rem] @3xl/page:grid-cols-[400px_minmax(0,1fr)]"
		>
			<section
				aria-label={t("submissions.listLabel")}
				className="flex min-h-0 min-w-0 flex-col gap-3 border-b p-4 @3xl/page:border-e @3xl/page:border-b-0"
			>
				<Segmented
					label={t("submissions.folders")}
					value={folder}
					options={[
						{ value: "inbox", label: t("submissions.inbox") },
						{
							value: "spam",
							label: listed?.counts.spam
								? t("submissions.spamCount", { count: listed.counts.spam })
								: t("submissions.spam"),
						},
					]}
					onChange={(next) => {
						setFolder(next);
						filtersChange();
					}}
				/>
				<div className="relative">
					<SearchIcon
						className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
						aria-hidden="true"
					/>
					<Input
						type="search"
						className="ps-9"
						value={typed}
						maxLength={200}
						placeholder={t("submissions.searchPlaceholder")}
						aria-label={t("submissions.search")}
						onChange={(event) => setTyped(event.target.value)}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Segmented
						label={t("submissions.show")}
						size="sm"
						value={read}
						options={[
							{ value: "all", label: t("submissions.filter.all") },
							{ value: "unread", label: t("submissions.filter.unread") },
						]}
						onChange={(next) => {
							setRead(next);
							filtersChange();
						}}
					/>
					{languages.length > 1 ? (
						<NativeSelect
							size="sm"
							aria-label={t("submissions.language")}
							value={language}
							onChange={(event) => {
								setLanguage(event.target.value);
								filtersChange();
							}}
						>
							<NativeSelectOption value="">{t("submissions.allLanguages")}</NativeSelectOption>
							{languages.map((code) => (
								<NativeSelectOption key={code} value={code}>
									{languageName(code)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					) : null}
					<Button
						variant="outline"
						size="sm"
						className="ms-auto"
						onClick={() => setExporting(true)}
						disabled={total === 0}
					>
						<DownloadIcon aria-hidden="true" data-icon="inline-start" />
						{t("submissions.export")}
					</Button>
				</div>

				<div className="-mx-1 max-h-[28rem] min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 @3xl/page:max-h-none">
					{listed && items.length === 0 ? (
						filtered ? (
							<p className="text-muted-foreground p-6 text-center text-sm">{t("submissions.noMatch")}</p>
						) : (
							<Empty className="p-6">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										{folder === "spam" ? <ShieldCheckIcon aria-hidden="true" /> : <InboxIcon aria-hidden="true" />}
									</EmptyMedia>
									<EmptyTitle>{folder === "spam" ? t("submissions.emptySpam") : t("submissions.empty")}</EmptyTitle>
									<EmptyDescription>
										{folder === "spam"
											? t("submissions.emptySpamNote")
											: placedOn.length > 0
												? t("submissions.emptyPlaced", { places: placedOn.join(", ") })
												: t("submissions.emptyNotPlaced")}
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						)
					) : null}
					{listed === null ? (
						<p className="text-muted-foreground p-6 text-center text-sm" aria-live="polite">
							{t("submissions.loading")}
						</p>
					) : null}
					{items.length > 0 ? (
						<ul
							ref={list}
							className="grid grid-cols-[minmax(0,1fr)] gap-0.5 py-1"
							aria-label={t("submissions.tableLabel")}
						>
							{items.map((submission) => (
								<Row
									key={submission.id}
									submission={submission}
									spam={folder === "spam"}
									current={submission.id === selected}
									time={rowTime(submission.receivedAt, now, locale, timeWords)}
									onOpen={() => choose(submission.id)}
								/>
							))}
						</ul>
					) : null}
					{items.length > 0 && items.length < total ? (
						<div className="grid justify-items-center gap-1 py-2">
							{items.length < LIST_MOST ? (
								<Button variant="ghost" size="sm" onClick={() => setShown((before) => before + PAGE_SIZE)}>
									{t("submissions.showMore")}
								</Button>
							) : (
								<p className="text-muted-foreground text-center text-xs">
									{t("submissions.showingNewest", { count: LIST_MOST })}
								</p>
							)}
						</div>
					) : null}
				</div>

				<Retention
					siteId={siteId}
					formId={formId}
					keepDays={listed?.keepDays ?? null}
					canManage={canManage}
					onChanged={() => setRefreshed((count) => count + 1)}
				/>
			</section>

			<div className="min-h-0 overflow-y-auto">
				<SubmissionDetail
					siteId={siteId}
					submissionId={selected}
					fields={fields}
					defaultLanguage={defaultLanguage}
					canManage={canManage}
					canResend={canResend}
					actions={actions}
					onChanged={changed}
					onGone={(gone) => {
						// The next Submission opens in its place, else the one before.
						const at = items.findIndex((item) => item.id === gone);
						const next = items[at + 1] ?? items[at - 1];
						choose(next && next.id !== gone ? next.id : null);
						changed();
					}}
				/>
			</div>

			<ExportDialog
				open={exporting}
				onOpenChange={setExporting}
				siteId={siteId}
				formId={formId}
				filters={{ folder, read, search: search || undefined, language: language || undefined }}
				senderLabels={senderLabels}
			/>
		</div>
	);
}

/** One row of the list (board 05): unread dot, who sent it, when, the first line, a clip for files. */
function Row({
	submission,
	spam,
	current,
	time,
	onOpen,
}: {
	submission: Submission;
	spam: boolean;
	current: boolean;
	time: string;
	onOpen(): void;
}) {
	const t = useT();
	const sender = senderOf(submission);
	const unread = !submission.read && !spam;
	const files = hasFiles(submission);
	return (
		<li>
			<button
				type="button"
				data-submission={submission.id}
				aria-current={current ? "true" : undefined}
				aria-keyshortcuts="J K"
				onClick={onOpen}
				className="hover:bg-muted aria-[current=true]:bg-accent focus-visible:ring-ring/50 grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-lg px-2.5 py-2 text-start outline-none focus-visible:ring-3"
			>
				<span className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className={`size-2 shrink-0 rounded-full ${unread ? "bg-orange-500" : "bg-transparent"}`}
					/>
					<span
						className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold" : "font-medium"} ${spam ? "text-muted-foreground" : ""}`}
					>
						{sender ?? t("submissions.noName")}
					</span>
					{unread ? <span className="sr-only">{t("submissions.unread")}</span> : null}
					<span className="text-muted-foreground shrink-0 text-xs">{time}</span>
				</span>
				<span className="flex items-center gap-1.5 ps-4">
					<span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">{firstLineOf(submission)}</span>
					{files ? (
						<>
							<PaperclipIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
							<span className="sr-only">{t("submissions.withFiles")}</span>
						</>
					) : null}
				</span>
			</button>
		</li>
	);
}

/**
 * How long the Form keeps its Submissions, at the foot of the list: a choice for those who may
 * manage them, else in words.
 */
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
	if (!canManage) {
		return (
			<p className="text-muted-foreground border-t pt-3 text-xs">
				{keepDays === null ? t("submissions.keptForever") : t("submissions.keptDays", { days: keepDays })}
			</p>
		);
	}
	return (
		<div className="flex items-center justify-between gap-2 border-t pt-3">
			<label htmlFor={id} className="text-muted-foreground text-xs">
				{t("submissions.retention")}
			</label>
			<NativeSelect
				id={id}
				size="sm"
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
		</div>
	);
}
