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
import { ArrowLeftIcon, LockIcon, RotateCcwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
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
import { LineChanges, ShownValue, StatusMark } from "./ShownValue.tsx";

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

/**
 * Site › an item's history: its Revisions and Checkpoints, newest first, and the one chosen next to
 * the Draft (Compare), part by part and language by language, with Restore. Only parts that differ are
 * shown unless "Show all" is on.
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
	const selected = comparison ? copyParam(comparison.copy) : null;

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

	return (
		<div className="grid gap-6">
			<div className="flex items-start gap-3">
				{editor ? (
					<Button
						variant="ghost"
						size="icon-sm"
						className="mt-1"
						aria-label={t("history.back", { name })}
						render={<Link {...editor} />}
					>
						<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
					</Button>
				) : null}
				<div className="grid gap-1">
					<h1 className="text-2xl font-semibold tracking-tight break-words">{t("history.heading", { name })}</h1>
					<p className="text-muted-foreground text-sm">
						{t("history.retention", {
							days: first.retention.revisionDays,
							kept: first.retention.revisionsKept,
							checkpointDays: first.retention.checkpointDays,
						})}
					</p>
				</div>
			</div>
			{first.revisions.on ? null : <RevisionsOff off={first.revisions.off} retention={first.retention} />}

			<div className="grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
				<nav aria-labelledby="history-copies-heading" className="grid content-start gap-3">
					<h2 id="history-copies-heading" className="text-lg font-semibold">
						{t("history.copies.heading")}
					</h2>
					{copies.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("history.card.empty")}</p>
					) : (
						<ul className="grid gap-1">
							{copies.map((copy) => {
								const current = copyParam(copy) === selected;
								return (
									<li key={copy.id}>
										<Link
											to="/sites/$siteId/history"
											params={{ siteId }}
											search={(before) => ({ ...before, ...itemSearch(item), copy: copyParam(copy) })}
											aria-current={current ? "page" : undefined}
											data-current={current || undefined}
											className="focus-visible:ring-ring/50 hover:bg-muted data-[current=true]:bg-muted data-[current=true]:border-primary grid gap-0.5 rounded-md border-s-4 border-transparent px-3 py-2 text-sm outline-none focus-visible:ring-3 data-[current=true]:font-medium"
										>
											<span className="font-medium">{copyKind(t, copy)}</span>
											<span>{formatUtc(copy.at)}</span>
											<span className="text-muted-foreground">{attributionText(t, copy.by)}</span>
										</Link>
									</li>
								);
							})}
						</ul>
					)}
					{cursor ? (
						<div>
							<Button type="button" variant="outline" disabled={loading} onClick={loadOlder}>
								{t("history.copies.older")}
							</Button>
						</div>
					) : null}
				</nav>

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
		</div>
	);
}

/** The chosen copy next to the Draft, with Restore. */
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
	const parts = showAll ? comparison.parts : comparison.parts.filter((part) => part.changed);
	const copyHeading =
		copy.type === "revision" ? t("history.compare.revisionSide") : t("history.compare.checkpointSide");
	return (
		<section aria-labelledby="history-compare-heading" className="grid content-start gap-5">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid gap-1">
					<h2 id="history-compare-heading" className="text-lg font-semibold">
						{t("history.compare.heading", { copy: `${copyKind(t, copy)} · ${formatUtc(copy.at)}` })}
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

			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm font-medium">
					{comparison.changes === 0
						? t("history.compare.same")
						: t("history.compare.differ", { count: comparison.changes })}
				</p>
				<Link
					to="/sites/$siteId/history"
					params={{ siteId }}
					search={(before) => ({ ...before, all: showAll ? undefined : true })}
					className="focus-visible:ring-ring/50 rounded-sm text-sm underline underline-offset-4 outline-none focus-visible:ring-3"
				>
					{showAll ? t("history.compare.showChanged") : t("history.compare.showAll")}
				</Link>
			</div>

			<div className="grid gap-4">
				{parts.map((part) => (
					<PartView
						key={part.key}
						kind={item.kind}
						part={part}
						copyHeading={copyHeading}
						language={comparison.language ?? undefined}
						languages={comparison.languages.length > 1}
					/>
				))}
			</div>
		</section>
	);
}

/** One part, its two sides, and who changed the Draft's value. */
function PartView({
	kind,
	part,
	copyHeading,
	language,
	languages,
}: {
	kind: HistoryItem["kind"];
	part: ComparedPart;
	copyHeading: string;
	language: string | undefined;
	languages: boolean;
}) {
	const t = useT();
	const headingId = `history-part-${part.key}`;
	return (
		<section
			aria-labelledby={headingId}
			className={`grid gap-3 rounded-lg border p-4 ${part.changed ? "border-primary" : ""}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<h3 id={headingId} className="font-medium">
					{partLabel(t, kind, part)}
				</h3>
				{part.changed ? <StatusMark status="changed" /> : <Badge variant="outline">{t("history.status.same")}</Badge>}
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
				<dl className="grid gap-4 md:grid-cols-2">
					<div className="grid content-start gap-1">
						<dt className="text-muted-foreground text-xs font-medium uppercase">{copyHeading}</dt>
						<dd>
							<ShownValue shown={part.copy} language={language} />
						</dd>
					</div>
					<div className="grid content-start gap-1">
						<dt className="text-muted-foreground text-xs font-medium uppercase">{t("history.compare.draftSide")}</dt>
						<dd>
							<ShownValue shown={part.draft} language={language} />
						</dd>
					</div>
				</dl>
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
			<Button ref={trigger} type="button" onClick={() => setOpen(true)}>
				<RotateCcwIcon aria-hidden="true" />
				{copy.type === "revision" ? t("history.restore.revision") : t("history.restore.checkpoint")}
			</Button>
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
