import { Link, type LinkProps, useNavigate, useRouter } from "@tanstack/react-router";
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
import { cn } from "@webcraft/ui/lib/utils.ts";
import { ArrowLeftIcon, EqualIcon, HistoryIcon, LockIcon, MinusIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { StateBadge } from "../settings/layout.tsx";
import { PageAside } from "../shell/page.tsx";
import { SecondarySidebar } from "../shell/SecondarySidebar.tsx";
import { RevisionsOff } from "./HistoryCard.tsx";
import {
	attributionText,
	type ComparedPart,
	type Comparison,
	copyKind,
	copyParam,
	type HistoryCopy,
	type HistoryItem,
	type HistoryPage,
	itemName,
	itemSearch,
	partLabel,
} from "./model.ts";
import { LineChanges, ShownValue } from "./ShownValue.tsx";

/** Where an item is edited in the admin, when it has a screen of its own. */
function editorOf(siteId: string, page: HistoryPage): LinkProps | null {
	const { item } = page;
	switch (item.kind) {
		case "entry":
			return item.postType && item.id
				? {
						to: "/sites/$siteId/entries/$postTypeId/$entryId",
						params: { siteId, postTypeId: item.postType.id, entryId: item.id },
					}
				: null;
		case "globals":
			return { to: "/sites/$siteId/globals", params: { siteId } };
		case "consentBanner":
			return { to: "/sites/$siteId/consent-banner", params: { siteId } };
		case "popup":
		case "popupContent":
			return { to: "/sites/$siteId/popups", params: { siteId } };
		case "form":
		case "formEmails":
			return item.id ? { to: "/sites/$siteId/forms/$formId", params: { siteId, formId: item.id } } : null;
		case "loop":
			return item.id ? { to: "/sites/$siteId/loops/$loopId", params: { siteId, loopId: item.id } } : null;
		case "component":
			return { to: "/sites/$siteId/components", params: { siteId } };
		case "template":
			return { to: "/sites/$siteId/templates", params: { siteId } };
		default:
			return null;
	}
}

const MINUTE_PAD = (part: number) => String(part).padStart(2, "0");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/**
 * When a copy was saved, as the history list says it: "Today, 11:20", "Yesterday, 16:40", "2 Nov,
 * 14:02" (the year once it is not this year's), in UTC as every admin time is.
 */
export function copyTime(t: Translate, value: Date | string, now = new Date()): string {
	const date = new Date(value);
	const time = `${MINUTE_PAD(date.getUTCHours())}:${MINUTE_PAD(date.getUTCMinutes())}`;
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	if (date.getTime() >= today) return t("history.time.today", { time });
	if (date.getTime() >= today - 86_400_000) return t("history.time.yesterday", { time });
	const month = t(`content.when.months.${MONTHS[date.getUTCMonth()] ?? "jan"}` as MessageKey);
	return date.getUTCFullYear() === now.getUTCFullYear()
		? t("history.time.day", { day: date.getUTCDate(), month, time })
		: t("history.time.dayYear", { day: date.getUTCDate(), month, year: date.getUTCFullYear(), time });
}

type Translate = ReturnType<typeof useT>;

/**
 * Site › an item's history (frame "Revisions"): its Revisions (the newest marked Live now) and its
 * Checkpoints in the list beside the page, and the one chosen compared with the Draft: the parts that
 * differ as rows of two columns, removed beside added, the parts that are the same folded into one
 * line, and Restore into the Draft, which never publishes.
 */
export function HistoryScreen({
	siteId,
	item,
	page: first,
	comparison,
	showAll,
}: {
	siteId: string;
	item: HistoryItem;
	page: HistoryPage;
	comparison: Comparison | null;
	showAll: boolean;
}) {
	const t = useT();
	const [older, setOlder] = useState<HistoryCopy[]>([]);
	const [cursor, setCursor] = useState(first.cursor);
	const [loading, setLoading] = useState(false);
	const copies = [...first.copies, ...older];
	const name = itemName(t, first.item);
	const editor = editorOf(siteId, first);

	const loadOlder = async () => {
		if (!cursor) return;
		setLoading(true);
		try {
			const api = await getApi();
			const next = await api.history.list({ siteId, item, cursor });
			setOlder((before) => [...before, ...next.copies]);
			setCursor(next.cursor);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setLoading(false);
		}
	};

	const list = (prefix: string) => (
		<CopyList
			prefix={prefix}
			siteId={siteId}
			item={item}
			name={name}
			editor={editor}
			copies={copies}
			selected={comparison ? copyParam(comparison.copy) : null}
			more={cursor ? { loading, load: loadOlder } : null}
			retention={t("history.retention", {
				days: first.retention.revisionDays,
				kept: first.retention.revisionsKept,
				checkpointDays: first.retention.checkpointDays,
			})}
		/>
	);
	return (
		<div className="grid gap-6">
			<h1 className="sr-only">{t("history.heading", { name })}</h1>
			<PageAside>
				<SecondarySidebar labelledBy="history-aside-title" className="w-80 gap-1 p-4">
					{list("history-aside")}
				</SecondarySidebar>
			</PageAside>
			{/* On a phone there is no room beside the page: the list comes first. */}
			<nav aria-labelledby="history-phone-title" className="grid gap-1 rounded-lg border p-3 md:hidden">
				{list("history-phone")}
			</nav>
			{first.revisions.on ? null : <RevisionsOff off={first.revisions.off} retention={first.retention} />}
			{comparison ? (
				<CompareView
					siteId={siteId}
					item={item}
					comparison={comparison}
					showAll={showAll}
					canRestore={first.canRestore}
					editor={editor}
				/>
			) : (
				<p className="text-muted-foreground text-sm">{t("history.compare.none")}</p>
			)}
		</div>
	);
}

/** The list's title: the item, as a link back to its editor when it has one. */
function CopyListTitle({ id, name, editor }: { id: string; name: string; editor: LinkProps | null }) {
	const t = useT();
	return (
		<div className="flex h-9 shrink-0 items-center gap-1 px-1">
			{editor ? (
				<Button variant="ghost" size="icon-sm" aria-label={t("history.back", { name })} render={<Link {...editor} />}>
					<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
				</Button>
			) : null}
			<p id={id} className="truncate text-sm font-semibold">
				<span className="sr-only">{t("history.heading", { name })}</span>
				<span aria-hidden="true">{name}</span>
			</p>
		</div>
	);
}

/** The Revisions, then the Checkpoints, newest first; the one compared is current. */
function CopyList({
	prefix,
	siteId,
	item,
	name,
	editor,
	copies,
	selected,
	more,
	retention,
}: {
	/** Its ids start with it: the list shows beside the page, or above it on a phone. */
	prefix: string;
	siteId: string;
	item: HistoryItem;
	name: string;
	editor: LinkProps | null;
	copies: readonly HistoryCopy[];
	selected: string | null;
	more: { loading: boolean; load: () => void } | null;
	retention: string;
}) {
	const t = useT();
	const revisions = copies.filter((copy) => copy.type === "revision");
	const checkpoints = copies.filter((copy) => copy.type === "checkpoint");
	// The newest Revision holds what visitors see now: it was published last.
	const live = revisions[0]?.id ?? null;
	const group = (key: "revisions" | "checkpoints", listed: readonly HistoryCopy[]) =>
		listed.length === 0 ? null : (
			<>
				<p id={`${prefix}-${key}`} className="text-muted-foreground flex h-7 items-center px-3 text-xs font-semibold">
					{t(`history.copies.${key}`)}
				</p>
				<ul aria-labelledby={`${prefix}-${key}`} className="grid gap-1">
					{listed.map((copy) => {
						const current = copyParam(copy) === selected;
						return (
							<li key={copy.id}>
								<Link
									to="/sites/$siteId/history"
									params={{ siteId }}
									search={(before) => ({ ...before, ...itemSearch(item), copy: copyParam(copy) })}
									aria-current={current ? "page" : undefined}
									className="focus-visible:ring-ring/50 hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:border-ring grid gap-0.5 rounded-lg border border-transparent px-3 py-2.5 transition-colors duration-150 outline-none focus-visible:ring-3"
								>
									<span className="flex items-center justify-between gap-2">
										<time
											dateTime={new Date(copy.at).toISOString()}
											title={formatUtc(copy.at)}
											className="text-sm font-medium"
											suppressHydrationWarning
										>
											{copyTime(t, copy.at)}
										</time>
										{copy.id === live ? <StateBadge tone="success">{t("history.liveNow")}</StateBadge> : null}
									</span>
									<span className="text-muted-foreground text-[13px]">
										{attributionText(t, copy.by)}
										{copy.type === "checkpoint" && copy.reason !== "activity" ? ` · ${copyKind(t, copy)}` : ""}
									</span>
								</Link>
							</li>
						);
					})}
				</ul>
			</>
		);
	return (
		<>
			<CopyListTitle id={`${prefix}-title`} name={name} editor={editor} />
			{copies.length === 0 ? (
				<p className="text-muted-foreground px-3 text-sm">{t("history.card.empty")}</p>
			) : (
				<>
					{group("revisions", revisions)}
					{revisions.length > 0 && checkpoints.length > 0 ? <div className="h-2" /> : null}
					{group("checkpoints", checkpoints)}
				</>
			)}
			{more ? (
				<div className="px-1 pt-2">
					<Button type="button" variant="outline" size="sm" disabled={more.loading} onClick={more.load}>
						{t("history.copies.older")}
					</Button>
				</div>
			) : null}
			<p className="text-muted-foreground mt-auto px-3 pt-4 text-xs">{retention}</p>
		</>
	);
}

/** The chosen copy compared with the Draft, with Restore. */
function CompareView({
	siteId,
	item,
	comparison,
	showAll,
	canRestore,
	editor,
}: {
	siteId: string;
	item: HistoryItem;
	comparison: Comparison;
	showAll: boolean;
	canRestore: boolean;
	editor: LinkProps | null;
}) {
	const t = useT();
	const { copy } = comparison;
	const differ = comparison.parts.filter((part) => part.changed);
	const same = comparison.parts.length - differ.length;
	const parts = showAll ? comparison.parts : differ;
	// Fields for what has Fields (an Entry, the Globals); parts for the rest (a Template's markup, …).
	const ofFields = item.kind === "entry" || item.kind === "globals";
	return (
		<section aria-labelledby="history-compare-heading" className="grid content-start gap-5">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid gap-1">
					<h2 id="history-compare-heading" className="text-lg font-semibold">
						{t("history.compare.title", { type: copy.type, time: copyTime(t, copy.at) })}
					</h2>
					<p className="text-muted-foreground text-sm">
						{copy.type === "revision"
							? t("history.compare.publishedBy", { by: attributionText(t, copy.by) })
							: t("history.compare.changedBy", {
									by: attributionText(t, copy.by),
									time: formatUtc(copy.changedAt),
								})}
					</p>
				</div>
				{canRestore ? <RestoreDialog siteId={siteId} item={item} copy={copy} editor={editor} /> : null}
			</div>

			{comparison.languages.length > 1 ? (
				<nav aria-label={t("history.compare.languages")} className="border-b">
					<ul className="-mb-px flex flex-wrap gap-4">
						{comparison.languages.map((language) => (
							<li key={language.code}>
								<Link
									to="/sites/$siteId/history"
									params={{ siteId }}
									search={(before) => ({ ...before, language: language.code })}
									aria-current={language.code === comparison.language ? "page" : undefined}
									className="focus-visible:ring-ring/50 aria-[current=page]:border-primary aria-[current=page]:text-foreground text-muted-foreground flex items-center gap-2 rounded-t-sm border-b-2 border-transparent px-1 pb-2 text-sm font-medium outline-none focus-visible:ring-3"
								>
									<span lang={language.code}>{languageName(language.code)}</span>
									<Badge variant={language.changes > 0 ? "default" : "outline"}>
										{t("history.compare.changes", { count: language.changes })}
									</Badge>
								</Link>
							</li>
						))}
					</ul>
				</nav>
			) : null}

			{differ.length === 0 ? <p className="text-sm font-medium">{t("history.compare.same")}</p> : null}

			{parts.length > 0 ? (
				<div className="grid">
					<div aria-hidden="true" className="hidden gap-4 pb-1 @2xl/page:grid @2xl/page:grid-cols-2">
						<p className="text-muted-foreground text-xs font-medium">
							{copy.type === "revision" ? t("history.compare.revisionColumn") : t("history.compare.checkpointColumn")}
						</p>
						<p className="text-muted-foreground text-xs font-medium">{t("history.compare.draftColumn")}</p>
					</div>
					{parts.map((part) => (
						<PartView
							key={part.key}
							kind={item.kind}
							part={part}
							copyColumn={
								copy.type === "revision" ? t("history.compare.revisionColumn") : t("history.compare.checkpointColumn")
							}
							language={comparison.language ?? undefined}
							languages={comparison.languages.length > 1}
						/>
					))}
				</div>
			) : null}

			{same > 0 ? (
				<Link
					to="/sites/$siteId/history"
					params={{ siteId }}
					search={(before) => ({ ...before, all: showAll ? undefined : true })}
					className="focus-visible:ring-ring/50 text-muted-foreground hover:text-foreground flex w-fit items-center gap-2 rounded-sm py-2 text-sm transition-colors duration-150 outline-none focus-visible:ring-3"
				>
					<EqualIcon aria-hidden="true" className="size-3.5 shrink-0" />
					{showAll
						? t("history.compare.showChanged")
						: t(ofFields ? "history.compare.sameFields" : "history.compare.sameParts", { count: same })}
				</Link>
			) : null}
		</section>
	);
}

/** One part: its name, then the copy's value beside the Draft's, removed and added, and who changed it. */
function PartView({
	kind,
	part,
	copyColumn,
	language,
	languages,
}: {
	kind: HistoryItem["kind"];
	part: ComparedPart;
	copyColumn: string;
	language: string | undefined;
	languages: boolean;
}) {
	const t = useT();
	const headingId = `history-part-${part.key}`;
	return (
		<section aria-labelledby={headingId} className="grid gap-2 border-b py-4">
			<div className="flex flex-wrap items-center gap-2">
				<h3 id={headingId} className="text-muted-foreground text-[13px] font-medium">
					{partLabel(t, kind, part)}
				</h3>
				{part.changed ? null : <span className="sr-only">{t("history.status.same")}</span>}
				{part.shared && languages ? (
					<Badge variant="outline">
						<LockIcon aria-hidden="true" />
						{t("history.compare.shared")}
					</Badge>
				) : null}
			</div>
			{part.lines ? (
				<LineChanges lines={part.lines} />
			) : (
				<div className="grid items-start gap-2 @2xl/page:grid-cols-2 @2xl/page:gap-4">
					<Side side="removed" changed={part.changed} column={copyColumn}>
						<ShownValue shown={part.copy} language={language} />
					</Side>
					<Side side="added" changed={part.changed} column={t("history.compare.draftColumn")}>
						<ShownValue shown={part.draft} language={language} />
					</Side>
				</div>
			)}
			{part.changed && part.changedBy ? (
				<p className="text-muted-foreground text-xs">
					{t("history.compare.partChangedBy", {
						by: attributionText(t, part.changedBy),
						time: part.changedAt ? formatUtc(part.changedAt) : "",
					})}
				</p>
			) : null}
		</section>
	);
}

/**
 * One side of a part that differs: the copy's value removed, the Draft's added, said by an icon and
 * a word as well as the tint. A part that is the same shows both sides plain.
 */
function Side({
	side,
	changed,
	column,
	children,
}: {
	side: "removed" | "added";
	changed: boolean;
	column: string;
	children: ReactNode;
}) {
	const t = useT();
	const Icon = side === "removed" ? MinusIcon : PlusIcon;
	return (
		<div
			data-side={changed ? side : "same"}
			className={cn(
				"flex min-w-0 items-start gap-2 rounded-lg p-2.5 text-sm",
				!changed && "bg-muted/50",
				changed &&
					side === "removed" &&
					"bg-destructive/10 dark:bg-destructive/20 text-red-800 dark:text-red-200 [&_.text-muted-foreground]:text-current",
				changed && side === "added" && "bg-success text-success-foreground [&_.text-muted-foreground]:text-current",
			)}
		>
			{changed ? <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : null}
			<div className="min-w-0 flex-1">
				{/* Its column and what happened to it, for those who don't see the columns or the tint. */}
				<span className="sr-only">
					{column}
					{changed ? `, ${t(`history.status.${side}`)}` : ""}:{" "}
				</span>
				{children}
			</div>
		</div>
	);
}

/**
 * Restore: copies the chosen Revision or Checkpoint into the Draft, after saying what happens: the
 * Draft as it is is kept as a Checkpoint first, and nothing is published.
 */
function RestoreDialog({
	siteId,
	item,
	copy,
	editor,
}: {
	siteId: string;
	item: HistoryItem;
	copy: Comparison["copy"];
	editor: LinkProps | null;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const router = useRouter();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	const restore = async () => {
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			// Restoring a Form's emails with other recipients is a Sensitive action.
			await runSensitive(() => api.history.restore({ siteId, item, copy: { type: copy.type, id: copy.id } }));
			setOpen(false);
			toast.success(t("history.restore.done"));
			if (editor) await navigate(editor);
			else await router.invalidate();
		} catch (failure) {
			setError(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div>
			<div className="grid justify-items-end gap-1.5">
				<Button ref={trigger} type="button" variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog">
					<HistoryIcon aria-hidden="true" />
					{t("history.restore.confirm")}
				</Button>
				<p className="text-muted-foreground text-xs">{t("history.restore.never")}</p>
			</div>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("history.restore.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>
							{copy.type === "revision" ? t("history.restore.titleRevision") : t("history.restore.titleCheckpoint")}
						</DialogTitle>
						<DialogDescription>{t("history.restore.body", { time: formatUtc(copy.at) })}</DialogDescription>
					</DialogHeader>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("history.restore.cancel")}</DialogClose>
						<Button type="button" disabled={busy} onClick={restore}>
							{t("history.restore.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
