import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { FieldError } from "@webcraft/ui/components/field.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { ArrowLeftIcon, InfoIcon, ListIcon, LoaderIcon, RefreshCwIcon, SquareIcon, Undo2Icon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { Tabs } from "../Tabs.tsx";
import { ProblemList } from "./CsvMapping.tsx";
import { StatusBadge } from "./ImportsList.tsx";
import { isGoing, type RunReport } from "./model.ts";
import { Stepper } from "./Stepper.tsx";

/** How often a running run's progress is asked for again. */
const POLL_MS = 2000;

/**
 * An Import run: while it runs, its progress (rows done of the total) with Stop; once it ended, its
 * Import report (counts, problem rows, what it created, updated and skipped, the columns it skipped),
 * Undo and Run again. The run goes on in the background: leaving the page changes nothing.
 */
export function RunReportPage({ siteId, initial }: { siteId: string; initial: RunReport }) {
	const t = useT();
	const router = useRouter();
	const [run, setRun] = useState(initial);
	const going = isGoing(run.status);
	const heading = useRef<HTMLHeadingElement>(null);

	useEffect(() => setRun(initial), [initial]);

	useEffect(() => {
		if (!going) return;
		const timer = setInterval(async () => {
			try {
				const api = await getApi();
				const { run: latest } = await api.imports.report({ siteId, runId: run.id });
				setRun(latest);
				if (!isGoing(latest.status)) heading.current?.focus();
			} catch {
				// Asked again at the next tick.
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [going, siteId, run.id]);

	return (
		<div className="grid gap-8">
			<header className="flex flex-wrap items-center gap-x-6 gap-y-4 border-b pb-6">
				<Button
					variant="ghost"
					size="icon"
					render={<Link to="/sites/$siteId/imports" params={{ siteId }} />}
					aria-label={t("imports.flow.backToList")}
				>
					<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
				</Button>
				<div className="grid min-w-48 flex-1 gap-1">
					<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
						{going ? run.importName : t("imports.report.title", { name: run.importName })}
					</h1>
					<p className="text-muted-foreground text-sm">
						{t("imports.report.started", {
							number: run.number,
							at: formatUtc(run.startedAt),
							name: run.startedBy?.name ?? "—",
						})}
					</p>
				</div>
				<Stepper current={going ? "run" : "report"} />
				<div className="flex items-center gap-2">
					{going ? (
						<StopButton siteId={siteId} run={run} onStopped={setRun} />
					) : (
						<>
							{run.postType ? (
								<Button
									variant="outline"
									render={
										<Link to="/sites/$siteId/entries/$postTypeId" params={{ siteId, postTypeId: run.postType.id }} />
									}
								>
									<ListIcon aria-hidden="true" />
									{t("imports.report.openEntries", { name: run.postType.name })}
								</Button>
							) : null}
							<Button
								render={<Link to="/sites/$siteId/imports/$importId" params={{ siteId, importId: run.importId }} />}
							>
								<RefreshCwIcon aria-hidden="true" />
								{t("imports.report.runAgain")}
							</Button>
						</>
					)}
				</div>
			</header>
			{going ? (
				<Progress run={run} />
			) : (
				<Report siteId={siteId} run={run} onUndone={async (next) => setRun(next)} after={() => router.invalidate()} />
			)}
		</div>
	);
}

/** Stop: the run finishes the row it is on and keeps what's done. */
function StopButton({ siteId, run, onStopped }: { siteId: string; run: RunReport; onStopped(run: RunReport): void }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			variant="outline"
			disabled={busy || run.stopRequested}
			onClick={async () => {
				setBusy(true);
				try {
					const api = await getApi();
					onStopped((await api.imports.stop({ siteId, runId: run.id })).run);
					toast.success(t("imports.run.stopping"));
				} catch (failure) {
					toast.error(t(errorMessage(failure)));
				} finally {
					setBusy(false);
				}
			}}
		>
			<SquareIcon aria-hidden="true" />
			{run.stopRequested ? t("imports.run.stopRequested") : t("imports.run.stop")}
		</Button>
	);
}

/** A run going on: how far it got, and what to know while it runs. */
function Progress({ run }: { run: RunReport }) {
	const t = useT();
	const { done, total } = run.progress;
	const percent = total === 0 ? 0 : Math.floor((done / total) * 100);
	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<Card>
				<CardHeader>
					<CardTitle>
						<h2 className="flex items-center gap-2">
							<LoaderIcon className="text-primary size-4 animate-spin" aria-hidden="true" />
							{run.status === "waiting" ? t("imports.run.waiting") : t("imports.run.importing")}
						</h2>
					</CardTitle>
					<CardDescription>{t("imports.run.leave")}</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-3">
					<div
						role="progressbar"
						aria-label={t("imports.run.progressLabel")}
						aria-valuemin={0}
						aria-valuemax={total}
						aria-valuenow={done}
						aria-valuetext={t("imports.run.progress", { done, total, percent })}
						className="bg-muted h-2 overflow-hidden rounded-full"
					>
						<div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
					</div>
					<p className="text-sm" aria-live="polite">
						{t("imports.run.progress", { done, total, percent })}
					</p>
					<Counts run={run} />
				</CardContent>
			</Card>
			<div className="grid content-start gap-3">
				<Note>{t("imports.run.noteDrafts")}</Note>
				<Note>{t("imports.run.noteStop")}</Note>
			</div>
		</div>
	);
}

/** A run that ended: what it did, its lists, Undo and Run again. */
function Report({
	siteId,
	run,
	onUndone,
	after,
}: {
	siteId: string;
	run: RunReport;
	onUndone(run: RunReport): Promise<void>;
	after(): Promise<void>;
}) {
	const t = useT();
	const outcome: MessageKey =
		run.status === "failed"
			? `imports.report.failed.${failureOf(run.failure?.reason)}`
			: run.status === "stopped"
				? "imports.report.stopped"
				: run.status === "undone"
					? "imports.report.undone"
					: "imports.report.done";
	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<div className="grid content-start gap-6">
				<p className="flex flex-wrap items-center gap-2" role="status">
					<StatusBadge status={run.status} />
					{t(outcome, {
						name: run.undoneBy?.name ?? "—",
						at: run.undoneAt ? formatUtc(run.undoneAt) : "",
						done: run.progress.done,
						total: run.progress.total,
					})}
				</p>
				<Counts run={run} />
				<Tabs
					label={t("imports.report.listsLabel")}
					tabs={[
						{
							id: "problems",
							label: t("imports.report.tabs.problems", { count: run.problemsTotal }),
							panel: <ProblemList problems={run.problems} total={run.problemsTotal} />,
						},
						{
							id: "created",
							label: t("imports.report.tabs.created", { count: run.counts.created }),
							panel: <ChangeList siteId={siteId} run={run} changes={run.created} total={run.counts.created} />,
						},
						{
							id: "updated",
							label: t("imports.report.tabs.updated", { count: run.counts.updated }),
							panel: <ChangeList siteId={siteId} run={run} changes={run.updated} total={run.counts.updated} />,
						},
						{
							id: "skipped",
							label: t("imports.report.tabs.skipped", { count: run.counts.skipped }),
							panel: <ChangeList siteId={siteId} run={run} changes={run.skipped} total={run.counts.skipped} />,
						},
						{
							id: "columns",
							label: t("imports.report.tabs.columns", { count: run.skippedColumns.length }),
							panel:
								run.skippedColumns.length === 0 ? (
									<p className="text-muted-foreground text-sm">{t("imports.report.noSkippedColumns")}</p>
								) : (
									<ul className="flex flex-wrap gap-2">
										{run.skippedColumns.map((column) => (
											<li key={column}>
												<code className="bg-muted rounded px-1.5 py-0.5 text-xs">{column}</code>
											</li>
										))}
									</ul>
								),
						},
					]}
				/>
			</div>
			<div className="grid content-start gap-4">
				<UndoCard siteId={siteId} run={run} onUndone={onUndone} after={after} />
				<Card size="sm">
					<CardHeader>
						<CardTitle>
							<h2>{t("imports.report.againTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("imports.report.againBody")}</CardDescription>
					</CardHeader>
				</Card>
				<Note>{t("imports.report.kept", { at: run.expiresAt ? formatUtc(run.expiresAt).slice(0, 10) : "—" })}</Note>
			</div>
		</div>
	);
}

function failureOf(reason: string | undefined): "access" | "settings" | "file" | "error" {
	return reason === "access" || reason === "settings" || reason === "file" ? reason : "error";
}

/** The run's counts, each with its label. */
function Counts({ run }: { run: RunReport }) {
	const t = useT();
	const items: { key: MessageKey; value: number }[] = [
		{ key: "imports.report.counts.created", value: run.counts.created },
		{ key: "imports.report.counts.updated", value: run.counts.updated },
		{ key: "imports.report.counts.unchanged", value: run.counts.unchanged },
		{ key: "imports.report.counts.skipped", value: run.counts.skipped },
		{ key: "imports.report.counts.problemRows", value: run.counts.problemRows },
		{ key: "imports.report.counts.files", value: run.files },
	];
	return (
		<dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
			{items.map((item) => (
				<div key={item.key} className="grid gap-1 rounded-lg border p-3">
					<dt className="text-muted-foreground text-sm">{t(item.key)}</dt>
					<dd className="text-2xl font-semibold tabular-nums">{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Entries a run created, updated or skipped, by row, each opening in the Entry editor. */
function ChangeList({
	siteId,
	run,
	changes,
	total,
}: {
	siteId: string;
	run: RunReport;
	changes: RunReport["created"];
	total: number;
}) {
	const t = useT();
	if (changes.length === 0) return <p className="text-muted-foreground text-sm">{t("imports.report.noEntries")}</p>;
	return (
		<div className="grid gap-2">
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="ps-4">{t("imports.report.row")}</TableHead>
							<TableHead>{t("imports.report.entry")}</TableHead>
							<TableHead className="pe-4">{t("imports.report.note")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{changes.map((change) => (
							<TableRow key={change.row}>
								<TableCell className="ps-4">{change.row}</TableCell>
								<TableCell className="whitespace-normal">
									{change.entryId && run.postType ? (
										<Link
											to="/sites/$siteId/entries/$postTypeId/$entryId"
											params={{ siteId, postTypeId: run.postType.id, entryId: change.entryId }}
											className="focus-visible:ring-ring/50 rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
										>
											{change.title || t("content.relationship.untitled")}
										</Link>
									) : (
										<span className="text-muted-foreground">{t("imports.report.entryGone")}</span>
									)}
								</TableCell>
								<TableCell className="text-muted-foreground pe-4">
									{change.reason === "edited" ? t("imports.report.editedSince") : ""}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{total > changes.length ? (
				<p className="text-muted-foreground text-sm">
					{t("imports.report.moreEntries", { count: total - changes.length })}
				</p>
			) : null}
		</div>
	);
}

/**
 * Undo this run: in two steps, while nothing it brought in was published or edited. The dialog asks
 * the server what Undo would do first, then sends the confirmation back.
 */
function UndoCard({
	siteId,
	run,
	onUndone,
	after,
}: {
	siteId: string;
	run: RunReport;
	onUndone(run: RunReport): Promise<void>;
	after(): Promise<void>;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [asked, setAsked] = useState<{ removes: number; restores: number; files: number; confirmation: string } | null>(
		null,
	);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const reason = run.undo.reason;

	const ask = async () => {
		setAsked(null);
		setError(null);
		try {
			const api = await getApi();
			const answer = await api.imports.undo({ siteId, runId: run.id });
			if ("confirmation" in answer) setAsked({ ...answer.preview, confirmation: answer.confirmation.id });
		} catch (failure) {
			setError(undoError(failure));
		}
	};

	const confirm = async () => {
		if (!asked) return;
		setBusy(true);
		try {
			const api = await getApi();
			const answer = await api.imports.undo({ siteId, runId: run.id, confirmation: asked.confirmation });
			toast.success(t("imports.undo.done"));
			setOpen(false);
			await onUndone(answer.run);
			await after();
			document.getElementById("main")?.focus();
		} catch (failure) {
			setError(undoError(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					<h2>{t("imports.undo.title")}</h2>
				</CardTitle>
				<CardDescription>
					{run.undo.available
						? t("imports.undo.available")
						: reason === "status" && run.status === "undone"
							? t("imports.undo.undoneAlready")
							: t(`imports.undo.refused.${reason ?? "status"}`)}
				</CardDescription>
			</CardHeader>
			{run.undo.available ? (
				<CardContent>
					<Button
						ref={trigger}
						variant="outline"
						className="border-destructive text-destructive w-full"
						onClick={() => {
							setOpen(true);
							void ask();
						}}
					>
						<Undo2Icon aria-hidden="true" />
						{t("imports.undo.button")}
					</Button>
					<Dialog open={open} onOpenChange={setOpen}>
						<DialogContent closeLabel={t("imports.undo.close")} finalFocus={trigger}>
							<DialogHeader>
								<DialogTitle>{t("imports.undo.dialogTitle", { number: run.number })}</DialogTitle>
								<DialogDescription>
									{asked
										? t("imports.undo.preview", {
												removes: asked.removes,
												restores: asked.restores,
												files: asked.files,
											})
										: error
											? ""
											: t("imports.undo.asking")}
								</DialogDescription>
							</DialogHeader>
							{error ? <FieldError>{t(error)}</FieldError> : null}
							<DialogFooter>
								<DialogClose render={<Button variant="outline" type="button" />}>
									{t("imports.undo.cancel")}
								</DialogClose>
								<Button variant="destructive" onClick={confirm} disabled={!asked || busy}>
									{t("imports.undo.confirm")}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				</CardContent>
			) : null}
		</Card>
	);
}

/** Why Undo was refused, worded. */
function undoError(error: unknown): MessageKey {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { reason?: unknown } };
	if (code === "IMPORT_UNDO_REFUSED") {
		const reason = data?.reason;
		return reason === "published" || reason === "edited" || reason === "linked"
			? `imports.undo.refused.${reason}`
			: "imports.undo.refused.status";
	}
	return errorMessage(error);
}

function Note({ children }: { children: ReactNode }) {
	return (
		<p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
			<InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{children}
		</p>
	);
}
