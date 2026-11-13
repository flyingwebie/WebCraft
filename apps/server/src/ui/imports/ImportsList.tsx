import { Link } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { FileCodeIcon, InfoIcon, PlusIcon, TableIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { getApi } from "../api.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { type ImportView, isGoing } from "./model.ts";

/**
 * Site › Imports: every Import of the Site with its last run (when, by whom, and what it did, or how
 * far it got), and the ways to start a new one. Reports are kept 90 days after their run ends.
 */
export function ImportsList({ siteId, imports }: { siteId: string; imports: readonly ImportView[] }) {
	const t = useT();
	const sources = useSources(siteId);
	const labelOf = (source: string) =>
		source === "csv"
			? t("imports.sourceNames.csv")
			: (sources.find((each) => each.id === source)?.label ?? t("imports.sourceNames.other"));
	return (
		<>
			<PageHeader
				heading={t("imports.heading")}
				action={
					<Button render={<Link to="/sites/$siteId/imports/new" params={{ siteId }} />}>
						<PlusIcon aria-hidden="true" />
						{t("imports.new")}
					</Button>
				}
			>
				{t("imports.intro")}
			</PageHeader>
			<div className="grid max-w-6xl gap-6">
				{imports.length === 0 ? (
					<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">{t("imports.none")}</p>
				) : (
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="ps-4">{t("imports.columns.import")}</TableHead>
									<TableHead>{t("imports.columns.source")}</TableHead>
									<TableHead>{t("imports.columns.lastRun")}</TableHead>
									<TableHead>{t("imports.columns.result")}</TableHead>
									<TableHead className="pe-4">
										<span className="sr-only">{t("imports.columns.open")}</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{imports.map((row) => (
									<ImportRow key={row.id} siteId={siteId} row={row} sourceLabel={labelOf(row.source)} />
								))}
							</TableBody>
						</Table>
					</div>
				)}
				<section aria-labelledby="import-sources" className="grid gap-3">
					<h2 id="import-sources" className="text-lg font-semibold">
						{t("imports.sources.heading")}
					</h2>
					<div className="grid gap-4 md:grid-cols-3">
						<Link
							to="/sites/$siteId/imports/new"
							params={{ siteId }}
							className="hover:bg-muted/50 focus-visible:ring-ring/50 grid gap-2 rounded-lg border p-4 outline-none focus-visible:ring-3"
						>
							<span className="flex items-center gap-2 font-medium">
								<TableIcon className="size-4" aria-hidden="true" />
								{t("imports.sources.csv.title")}
							</span>
							<span className="text-muted-foreground text-sm">{t("imports.sources.csv.body")}</span>
						</Link>
						{sources.map((source) => (
							<Link
								key={source.id}
								to="/sites/$siteId/imports/new"
								params={{ siteId }}
								search={{ source: source.id }}
								className="hover:bg-muted/50 focus-visible:ring-ring/50 grid gap-2 rounded-lg border p-4 outline-none focus-visible:ring-3"
							>
								<span className="flex items-center gap-2 font-medium">
									<FileCodeIcon className="size-4" aria-hidden="true" />
									{source.label}
								</span>
								<span className="text-muted-foreground text-sm">{t("imports.sources.module.body")}</span>
							</Link>
						))}
					</div>
				</section>
				<p className="bg-muted/50 flex items-start gap-2 rounded-lg border p-3 text-sm">
					<InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					{t("imports.kept")}
				</p>
			</div>
		</>
	);
}

/** The import sources Modules add on the Site that the person may import from. */
function useSources(siteId: string) {
	const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
	useEffect(() => {
		let current = true;
		void (async () => {
			try {
				const api = await getApi();
				const answer = await api.imports.sources({ siteId });
				if (current) setSources(answer.sources);
			} catch {
				// The list shows CSV only.
			}
		})();
		return () => {
			current = false;
		};
	}, [siteId]);
	return sources;
}

/** One Import: its name, file and Post Type, its last run and what it did. */
function ImportRow({ siteId, row, sourceLabel }: { siteId: string; row: ImportView; sourceLabel: string }) {
	const t = useT();
	const run = row.lastRun;
	return (
		<TableRow>
			<TableCell className="ps-4 whitespace-normal">
				<div className="grid">
					<span className="font-medium">{row.name}</span>
					<span className="text-muted-foreground text-sm">
						{t("imports.list.into", {
							file: run?.fileName ?? "—",
							postType:
								row.postType?.name ??
								(row.source === "csv" ? t("imports.list.noPostType") : t("imports.list.severalTypes")),
						})}
					</span>
				</div>
			</TableCell>
			<TableCell>
				<Badge variant="outline">{sourceLabel}</Badge>
			</TableCell>
			<TableCell className="whitespace-normal">
				{run ? (
					<div className="grid">
						<span>{formatUtc(run.startedAt)}</span>
						<span className="text-muted-foreground text-sm">
							{t("imports.list.runBy", { number: run.number, name: run.startedBy?.name ?? "—" })}
						</span>
					</div>
				) : (
					<span className="text-muted-foreground">
						{row.runs > 0 ? t("imports.list.purged", { count: row.runs }) : t("imports.list.notRun")}
					</span>
				)}
			</TableCell>
			<TableCell className="whitespace-normal">
				{run ? (
					isGoing(run.status) ? (
						<span className="flex items-center gap-2">
							<StatusBadge status={run.status} />
							{t("imports.list.progress", { done: run.progress.done, total: run.progress.total })}
						</span>
					) : (
						<span className="flex flex-wrap items-center gap-2">
							<StatusBadge status={run.status} />
							<span className="text-muted-foreground text-sm">
								{t("imports.list.counts", {
									created: run.counts.created,
									updated: run.counts.updated,
									skipped: run.counts.skipped,
								})}
							</span>
						</span>
					)
				) : null}
			</TableCell>
			<TableCell className="pe-4 text-end">
				{run ? (
					<Link
						to="/sites/$siteId/imports/$importId/runs/$runId"
						params={{ siteId, importId: row.id, runId: run.id }}
						className="focus-visible:ring-ring/50 rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
					>
						{isGoing(run.status)
							? t("imports.list.openRun", { name: row.name })
							: t("imports.list.openReport", { name: row.name })}
					</Link>
				) : (
					<Link
						to="/sites/$siteId/imports/$importId"
						params={{ siteId, importId: row.id }}
						className="focus-visible:ring-ring/50 rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
					>
						{t("imports.list.continue", { name: row.name })}
					</Link>
				)}
			</TableCell>
		</TableRow>
	);
}

/** A run's status as a badge. */
export function StatusBadge({ status }: { status: string }) {
	const t = useT();
	const known = ["waiting", "running", "stopped", "done", "failed", "undone"].includes(status)
		? (status as "waiting" | "running" | "stopped" | "done" | "failed" | "undone")
		: "failed";
	return (
		<Badge
			variant={known === "failed" ? "destructive" : known === "done" ? "default" : "outline"}
			className={
				known === "done" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : undefined
			}
		>
			{t(`imports.status.${known}`)}
		</Badge>
	);
}
