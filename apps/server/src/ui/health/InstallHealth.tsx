import { Link, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
import { CircleAlertIcon, CircleCheckIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { formatBytes } from "../media/preview.ts";

export type HealthReport = Awaited<ReturnType<ApiClient["installHealth"]["get"]>>;
type Part = HealthReport["parts"][number];
export type Queues = Awaited<ReturnType<ApiClient["installHealth"]["queues"]>>["queues"];
type Queue = Queues[number];
type Job = Queue["jobs"][number];

type Translate = ReturnType<typeof useT>;

/** Install health: every part with its status and why, then the failed and stuck jobs. */
export function InstallHealthScreen({ report, queues }: { report: HealthReport; queues: Queues }) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const checkNow = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.installHealth.get({ refresh: true });
			toast.success(t("installHealth.checked"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<p className="text-muted-foreground text-sm">
					{report.checkedAt ? t("installHealth.checkedAt", { time: formatUtc(report.checkedAt) }) : null}
				</p>
				<Button type="button" variant="outline" onClick={checkNow} disabled={busy}>
					<RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
					{t("installHealth.checkNow")}
				</Button>
			</div>
			<PartsTable parts={report.parts} />
			<JobsCard queues={queues} />
		</div>
	);
}

function PartsTable({ parts }: { parts: readonly Part[] }) {
	const t = useT();
	return (
		<section
			aria-labelledby="install-health-caption"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
			tabIndex={0}
			className="focus-visible:ring-ring/50 overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]"
		>
			<table className="w-full text-start text-sm">
				<caption id="install-health-caption" className="sr-only">
					{t("installHealth.tableLabel")}
				</caption>
				<thead className="bg-muted/50">
					<tr>
						<th scope="col" className="px-3 py-2 text-start font-medium">
							{t("installHealth.columns.part")}
						</th>
						<th scope="col" className="px-3 py-2 text-start font-medium">
							{t("installHealth.columns.status")}
						</th>
						<th scope="col" className="px-3 py-2 text-start font-medium">
							{t("installHealth.columns.reason")}
						</th>
					</tr>
				</thead>
				<tbody className="divide-y">
					{parts.map((part) => (
						<tr key={part.part} className="align-top">
							<th scope="row" className="px-3 py-3 text-start font-medium whitespace-nowrap">
								{t(`installHealth.parts.${part.part}` as MessageKey)}
							</th>
							<td className="px-3 py-3 whitespace-nowrap">
								<StatusBadge status={part.status} />
							</td>
							<td className="min-w-72 px-3 py-3">
								<p>{reasonText(t, part)}</p>
								{part.failingSince ? (
									<p className="text-muted-foreground mt-1 text-xs">
										{t("installHealth.failingSince", { time: formatUtc(part.failingSince) })}
									</p>
								) : null}
								<PartLink part={part} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

/** OK, Warning or Failing: in words and with an icon, never by colour alone. */
function StatusBadge({ status }: { status: Part["status"] }) {
	const t = useT();
	if (status === "failing") {
		return (
			<Badge variant="outline" className="border-destructive/60">
				<CircleAlertIcon className="text-destructive" aria-hidden="true" data-icon="inline-start" />
				{t("installHealth.status.failing")}
			</Badge>
		);
	}
	if (status === "warning") {
		return (
			<Badge variant="outline">
				<TriangleAlertIcon aria-hidden="true" data-icon="inline-start" />
				{t("installHealth.status.warning")}
			</Badge>
		);
	}
	return (
		<Badge variant="secondary">
			<CircleCheckIcon aria-hidden="true" data-icon="inline-start" />
			{t("installHealth.status.ok")}
		</Badge>
	);
}

/** Where to act on a part that isn't OK. */
function PartLink({ part }: { part: Part }) {
	const t = useT();
	if (part.status === "ok") return null;
	const className = "mt-1 inline-block text-sm underline underline-offset-4";
	switch (part.part) {
		case "jobQueue":
			return (
				<a href="#failed-jobs" className={className}>
					{t("installHealth.open.jobQueue")}
				</a>
			);
		case "storage":
			return (
				<Link to="/settings/storage" className={className}>
					{t("installHealth.open.storage")}
				</Link>
			);
		case "backups":
			return (
				<Link to="/settings/backups" className={className}>
					{t("installHealth.open.backups")}
				</Link>
			);
		case "smtp":
			return (
				<Link to="/settings/email" className={className}>
					{t("installHealth.open.smtp")}
				</Link>
			);
		case "errorLog":
			return (
				<Link to="/install/errors" className={className}>
					{t("installHealth.open.errorLog")}
				</Link>
			);
		case "moduleLog":
			return (
				<Link to="/settings/modules" className={className}>
					{t("installHealth.open.moduleLog")}
				</Link>
			);
		default:
			return null;
	}
}

/** A part's reason in words, its values made readable (times in UTC, sizes, names). */
export function reasonText(t: Translate, part: Pick<Part, "part" | "reason">): string {
	const key = `installHealth.reasons.${part.part}.${part.reason.code}` as MessageKey;
	if (!t.has(key)) return part.reason.code;
	const data = (part.reason.data ?? {}) as Record<string, unknown>;
	const time = (value: unknown) => (typeof value === "string" ? formatUtc(value) : t("installHealth.unknown"));
	const names = (value: unknown) =>
		Array.isArray(value)
			? value
					.map((item) =>
						typeof item === "string"
							? item
							: String((item as { name?: unknown }).name ?? (item as { site?: { name?: unknown } }).site?.name ?? ""),
					)
					.filter(Boolean)
					.join(", ")
			: "";
	const values: Record<string, string | number> = {
		version: String(data.version ?? ""),
		webVersion: String(data.webVersion ?? ""),
		hostname: String(data.hostname ?? ""),
		time: time(data.lastBeatAt ?? data.failedAt ?? data.lastDoneAt ?? data.since),
		pending: Number(data.pending ?? 0),
		failed: Number(data.failed ?? 0),
		stuck: Number(data.stuck ?? 0),
		waiting: Number(data.waiting ?? 0),
		count: Number(data.count ?? 0),
		free: typeof data.freeBytes === "number" ? formatBytes(data.freeBytes) : "",
		total: typeof data.totalBytes === "number" ? formatBytes(data.totalBytes) : "",
		problem: typeof data.problem === "string" ? data.problem : t("installHealth.unknown"),
		response: String(data.lastResponse ?? ""),
		sites: names(data.sites),
		domains: names(data.domains),
		modules: names(data.modules),
	};
	return t(key, values);
}

function JobsCard({ queues }: { queues: Queues }) {
	const t = useT();
	return (
		<Card id="failed-jobs">
			<CardHeader>
				<CardTitle>
					<h2>{t("installHealth.jobs.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("installHealth.jobs.intro")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-8">
				{queues.length === 0 ? <p className="text-muted-foreground text-sm">{t("installHealth.jobs.empty")}</p> : null}
				{queues.map((queue) => (
					<QueueSection key={queue.queue} queue={queue} />
				))}
			</CardContent>
		</Card>
	);
}

type Asked =
	| { kind: "retryAll" }
	| { kind: "discardAll" }
	| { kind: "discard"; job: Job; trigger: RefObject<HTMLButtonElement | null> };

function QueueSection({ queue }: { queue: Queue }) {
	const t = useT();
	const router = useRouter();
	const [asked, setAsked] = useState<Asked | null>(null);
	const retryAllButton = useRef<HTMLButtonElement>(null);
	const discardAllButton = useRef<HTMLButtonElement>(null);
	const headingId = `queue-${queue.queue.replaceAll(".", "-")}`;

	const act = async (action: "retry" | "discard", jobIds: string[] | "all") => {
		try {
			const api = await getApi();
			if (action === "retry") {
				const { retried } = await api.installHealth.retry({ queue: queue.queue, jobIds });
				toast.success(t("installHealth.jobs.retried", { count: retried }));
			} else {
				const { discarded } = await api.installHealth.discard({ queue: queue.queue, jobIds });
				toast.success(t("installHealth.jobs.discarded", { count: discarded }));
			}
			setAsked(null);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 id={headingId} className="font-mono text-sm font-semibold">
						{queue.queue}
					</h3>
					<p className="text-muted-foreground text-sm">
						{t("installHealth.jobs.queueSummary", { failed: queue.failed, stuck: queue.stuck })}
					</p>
				</div>
				{queue.failed > 0 ? (
					<div className="flex flex-wrap gap-2">
						<Button
							ref={retryAllButton}
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setAsked({ kind: "retryAll" })}
						>
							{t("installHealth.jobs.retryAll", { queue: queue.queue })}
						</Button>
						<Button
							ref={discardAllButton}
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setAsked({ kind: "discardAll" })}
						>
							{t("installHealth.jobs.discardAll", { queue: queue.queue })}
						</Button>
					</div>
				) : null}
			</div>
			{queue.jobs.length > 0 ? (
				<section
					aria-label={t("installHealth.jobs.tableLabel", { queue: queue.queue })}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					tabIndex={0}
					className="focus-visible:ring-ring/50 overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]"
				>
					<table className="w-full text-start text-sm">
						<thead className="bg-muted/50">
							<tr>
								<th scope="col" className="px-3 py-2 text-start font-medium whitespace-nowrap">
									{t("installHealth.jobs.columns.failedAt")}
								</th>
								<th scope="col" className="px-3 py-2 text-end font-medium">
									{t("installHealth.jobs.columns.attempts")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("installHealth.jobs.columns.error")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("installHealth.jobs.columns.actions")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{queue.jobs.map((job) => (
								<JobRow
									key={job.id}
									job={job}
									onRetry={() => act("retry", [job.id])}
									onDiscard={(trigger) => setAsked({ kind: "discard", job, trigger })}
								/>
							))}
						</tbody>
					</table>
				</section>
			) : null}
			{asked ? (
				<ConfirmDialog
					title={
						asked.kind === "retryAll"
							? t("installHealth.jobs.retryAllTitle", { queue: queue.queue })
							: asked.kind === "discardAll"
								? t("installHealth.jobs.discardAllTitle", { queue: queue.queue })
								: t("installHealth.jobs.discardTitle")
					}
					text={
						asked.kind === "retryAll"
							? t("installHealth.jobs.retryAllText", { count: queue.failed })
							: asked.kind === "discardAll"
								? t("installHealth.jobs.discardAllText", { count: queue.failed })
								: t("installHealth.jobs.discardText")
					}
					action={asked.kind === "retryAll" ? t("installHealth.jobs.retry") : t("installHealth.jobs.discard")}
					destructive={asked.kind !== "retryAll"}
					finalFocus={
						asked.kind === "retryAll" ? retryAllButton : asked.kind === "discardAll" ? discardAllButton : asked.trigger
					}
					onConfirm={() =>
						asked.kind === "retryAll"
							? act("retry", "all")
							: asked.kind === "discardAll"
								? act("discard", "all")
								: act("discard", [asked.job.id])
					}
					onClose={() => setAsked(null)}
				/>
			) : null}
		</section>
	);
}

function JobRow({
	job,
	onRetry,
	onDiscard,
}: {
	job: Job;
	onRetry: () => void;
	onDiscard: (trigger: RefObject<HTMLButtonElement | null>) => void;
}) {
	const t = useT();
	const discardButton = useRef<HTMLButtonElement>(null);
	const time = job.failedAt ? formatUtc(job.failedAt) : t("installHealth.unknown");
	return (
		<tr className="align-top">
			<td className="px-3 py-2 whitespace-nowrap">{time}</td>
			<td className="px-3 py-2 text-end tabular-nums">{job.attempts}</td>
			<td className="min-w-64 px-3 py-2 break-words">
				{job.error.name ? <span className="font-medium">{job.error.name}: </span> : null}
				<span className="text-muted-foreground">{job.error.message}</span>
			</td>
			<td className="px-3 py-2">
				<div className="flex gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onRetry}
						aria-label={t("installHealth.jobs.retryOf", { time })}
					>
						{t("installHealth.jobs.retry")}
					</Button>
					<Button
						ref={discardButton}
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onDiscard(discardButton)}
						aria-label={t("installHealth.jobs.discardOf", { time })}
					>
						{t("installHealth.jobs.discard")}
					</Button>
				</div>
			</td>
		</tr>
	);
}

function ConfirmDialog({
	title,
	text,
	action,
	destructive,
	finalFocus,
	onConfirm,
	onClose,
}: {
	title: string;
	text: string;
	action: string;
	destructive: boolean;
	finalFocus: RefObject<HTMLElement | null>;
	onConfirm: () => Promise<void>;
	onClose: () => void;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const confirm = async () => {
		setBusy(true);
		await onConfirm();
		setBusy(false);
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("installHealth.jobs.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{text}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("installHealth.jobs.cancel")}</DialogClose>
					<Button variant={destructive ? "destructive" : "default"} onClick={confirm} disabled={busy}>
						{action}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
