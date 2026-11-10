import { Link, useRouter } from "@tanstack/react-router";
import type { SiteImportReport, SiteImportView } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@webcraft/ui/components/table.tsx";
import { ArrowLeftIcon, ExternalLinkIcon, ImportIcon, LoaderIcon, SendIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { formatBytes } from "../media/preview.ts";
import { PasswordInput } from "../PasswordInput.tsx";
import { Tabs } from "../Tabs.tsx";
import { ImportStatus, refusalText } from "./SiteImports.tsx";

/** How often an import under way is asked about again. */
const POLL_MS = 2000;

const going = (status: SiteImportView["status"]) => status === "waiting" || status === "running";

/** A slug made from a name, as a suggestion: lower-case letters, digits and dashes. */
function slugOf(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/**
 * One Site import: what the archive holds and the form that starts it as a new Site (name, slug and
 * the export passphrase); then its progress while the worker reads it in; then its Site import report.
 */
export function SiteImportPage({ workspaceId, initial }: { workspaceId: string; initial: SiteImportView }) {
	const t = useT();
	const [view, setView] = useState(initial);
	const heading = useRef<HTMLHeadingElement>(null);

	useEffect(() => setView(initial), [initial]);

	useEffect(() => {
		if (!going(view.status)) return;
		const timer = setInterval(async () => {
			try {
				const api = await getApi();
				const { import: latest } = await api.siteImports.get({ workspaceId, importId: view.id });
				setView(latest);
				if (!going(latest.status)) heading.current?.focus();
			} catch {
				// Asked again at the next tick.
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [view.status, view.id, workspaceId]);

	const archive = view.archive;
	return (
		<div className="grid gap-8">
			<header className="flex flex-wrap items-center gap-x-6 gap-y-4 border-b pb-6">
				<Button
					variant="ghost"
					size="icon"
					render={<Link to="/workspaces/$workspaceId/site-imports" params={{ workspaceId }} />}
					nativeButton={false}
					aria-label={t("siteImports.backToList")}
				>
					<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
				</Button>
				<div className="grid min-w-48 flex-1 gap-1">
					<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
						{view.status === "done" ? t("siteImportReport.heading") : view.fileName}
					</h1>
					<p className="text-muted-foreground text-sm">
						{archive
							? t("siteImports.from", {
									name: archive.site.name,
									slug: archive.site.slug,
									time: formatUtc(archive.exportedAt),
									version: archive.webcraft,
								})
							: view.fileName}
					</p>
				</div>
				<ImportStatus status={view.status} />
				{view.site ? (
					<Button render={<Link to="/sites/$siteId" params={{ siteId: view.site.id }} />} nativeButton={false}>
						<ExternalLinkIcon aria-hidden="true" />
						{t("siteImportReport.openSite")}
					</Button>
				) : null}
			</header>
			{view.status === "ready" && archive ? (
				<StartForm workspaceId={workspaceId} view={view} onStarted={setView} />
			) : null}
			{going(view.status) ? <Progress view={view} /> : null}
			{view.status === "refused" ? (
				<p role="alert" className="text-red-800 dark:text-red-200">
					{refusalText(t, view.refusal)}
				</p>
			) : null}
			{view.status === "failed" ? (
				<p role="alert" className="text-red-800 dark:text-red-200">
					{t(`siteImports.failure.${failureKey(view.failure?.reason)}`)}
				</p>
			) : null}
			{view.status === "done" && view.report ? (
				<Report workspaceId={workspaceId} view={view} report={view.report} onChange={setView} />
			) : null}
		</div>
	);
}

const FAILURES = ["access", "slug", "passphrase", "damaged", "not-an-export", "newer-format", "newer-version"] as const;

function failureKey(reason: string | undefined): (typeof FAILURES)[number] | "error" {
	return FAILURES.find((each) => each === reason) ?? "error";
}

/** What the archive holds, the Modules it needs, and the form that starts it as a new Site. */
function StartForm({
	workspaceId,
	view,
	onStarted,
}: {
	workspaceId: string;
	view: SiteImportView;
	onStarted(view: SiteImportView): void;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const archive = view.archive;
	const [name, setName] = useState(archive?.site.name ?? "");
	const [slug, setSlug] = useState(slugOf(archive?.site.slug ?? ""));
	const [passphrase, setPassphrase] = useState("");
	const [problem, setProblem] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const ids = { name: useId(), slug: useId(), passphrase: useId(), problem: useId() };
	if (!archive) return null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const { import: started } = await runSensitive(() =>
				api.siteImports.start({
					workspaceId,
					importId: view.id,
					name: name.trim(),
					slug,
					passphrase: archive.secrets.carried && passphrase !== "" ? passphrase : null,
				}),
			);
			onStarted(started);
		} catch (failure) {
			setProblem(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const counts = archive.counts;
	return (
		<div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_22rem]">
			<Card>
				<CardHeader>
					<CardTitle>
						<h2>{t("siteImports.readyTitle")}</h2>
					</CardTitle>
					<CardDescription>{t("siteImports.readyIntro")}</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="grid gap-4" onSubmit={submit} noValidate>
						<Field>
							<FieldLabel htmlFor={ids.name}>{t("siteImports.name")}</FieldLabel>
							<Input
								id={ids.name}
								value={name}
								maxLength={100}
								required
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={ids.slug}>{t("siteImports.slug")}</FieldLabel>
							<Input
								id={ids.slug}
								value={slug}
								maxLength={100}
								required
								aria-describedby={`${ids.slug}-help`}
								onChange={(event) => setSlug(event.target.value)}
							/>
							<FieldDescription id={`${ids.slug}-help`}>{t("siteImports.slugHelp")}</FieldDescription>
						</Field>
						{archive.secrets.carried ? (
							<Field>
								<FieldLabel htmlFor={ids.passphrase}>{t("siteImports.passphrase")}</FieldLabel>
								<PasswordInput
									id={ids.passphrase}
									value={passphrase}
									autoComplete="off"
									aria-describedby={`${ids.passphrase}-help`}
									onChange={(event) => setPassphrase(event.target.value)}
								/>
								<FieldDescription id={`${ids.passphrase}-help`}>{t("siteImports.passphraseHelp")}</FieldDescription>
							</Field>
						) : (
							<p className="text-muted-foreground text-sm">{t("siteImports.noSecrets")}</p>
						)}
						{problem ? (
							<FieldError id={ids.problem} role="alert">
								{t(problem)}
							</FieldError>
						) : null}
						<div>
							<Button type="submit" disabled={busy || !name.trim() || !slug}>
								{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <ImportIcon aria-hidden="true" />}
								{t("siteImports.start")}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
			<div className="grid content-start gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("siteImports.holds")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-2 text-sm">
						<p>
							{t("siteImports.counts", {
								entries: counts.entries ?? 0,
								media: counts.media ?? 0,
								members: (counts.members ?? 0) + (counts.invites ?? 0),
								submissions: counts.submissions ?? 0,
							})}
						</p>
						<p className="text-muted-foreground">
							{t("siteImports.size", { size: formatBytes(archive.files.mediaBytes) })}
						</p>
					</CardContent>
				</Card>
				{archive.modules.length > 0 ? (
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("siteImports.modulesTitle")}</h2>
							</CardTitle>
						</CardHeader>
						<CardContent>
							<ul className="grid gap-2 text-sm">
								{archive.modules.map((module) => (
									<li key={module.id}>
										<span className="font-medium">
											{module.id} {module.version}
										</span>
										<br />
										<span className="text-muted-foreground">{t(`siteImports.moduleStatus.${module.status}`)}</span>
									</li>
								))}
							</ul>
						</CardContent>
					</Card>
				) : null}
			</div>
		</div>
	);
}

function Progress({ view }: { view: SiteImportView }) {
	const t = useT();
	const step = view.progress?.step as "tables" | "files" | "people" | undefined;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("siteImports.progressTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("siteImports.progressIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<p aria-live="polite" className="flex items-center gap-2 text-sm">
					<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
					{step && view.progress
						? t(`siteImports.progress.${step}`, { done: view.progress.done, total: view.progress.total })
						: t("siteImports.status.waiting")}
				</p>
			</CardContent>
		</Card>
	);
}

/** One number of the report, with its label and a note under it. */
function Stat({ label, value, note }: { label: string; value: number; note: string }) {
	return (
		<Card>
			<CardContent className="grid gap-1 pt-6">
				<span className="text-muted-foreground text-sm">{label}</span>
				<span className="text-3xl font-semibold tabular-nums">{value}</span>
				<span className="text-muted-foreground text-xs">{note}</span>
			</CardContent>
		</Card>
	);
}

/** A simple table of the report's rows, with a caption for screen readers. */
function ReportTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: ReactNode[][] }) {
	const t = useT();
	if (rows.length === 0) return <p className="text-muted-foreground text-sm">{t("siteImportReport.none")}</p>;
	return (
		<Table>
			<TableCaption className="sr-only">{caption}</TableCaption>
			<TableHeader>
				<TableRow>
					{columns.map((column) => (
						<TableHead key={column}>{column}</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the report's rows never move.
					<TableRow key={index}>
						{row.map((cell, column) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a row's cells never move.
							<TableCell key={column}>{cell}</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/**
 * The Site import report: what came in, and what was reassigned, invited, paused, set or left out,
 * with the steps that put the Site live (as the Import report shows a run's).
 */
function Report({
	workspaceId,
	view,
	report,
	onChange,
}: {
	workspaceId: string;
	view: SiteImportView;
	report: SiteImportReport;
	onChange(view: SiteImportView): void;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [sending, setSending] = useState(false);
	const siteId = view.site?.id;
	const unsent = report.invited.filter((invite) => !invite.sent).length;

	const send = async () => {
		setSending(true);
		try {
			const api = await getApi();
			const { import: sent } = await runSensitive(() =>
				api.siteImports.sendInvitations({ workspaceId, importId: view.id }),
			);
			onChange(sent);
			toast.success(t("siteImportReport.sent"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setSending(false);
		}
	};

	const columns = (keys: (keyof typeof COLUMN_KEYS)[]) => keys.map((key) => t(COLUMN_KEYS[key]));
	const names = (list: readonly string[]) => (list.length > 0 ? list.join(", ") : t("siteImportReport.none"));
	const dropped = report.dropped;

	const tabs = [
		{
			id: "invited",
			label: t("siteImportReport.tabs.invited"),
			badge: String(report.invited.length),
			panel: (
				<div className="grid gap-4">
					<p className="text-muted-foreground text-sm">{t("siteImportReport.invitedIntro")}</p>
					{unsent > 0 ? (
						<div>
							<Button onClick={() => void send()} disabled={sending}>
								{sending ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <SendIcon aria-hidden="true" />}
								{t("siteImportReport.sendInvitations")}
							</Button>
						</div>
					) : null}
					<ReportTable
						caption={t("siteImportReport.tabs.invited")}
						columns={columns(["email", "role", "sent"])}
						rows={report.invited.map((invite) => [
							invite.email,
							t(`roles.${invite.role as "owner" | "editor" | "author"}`),
							invite.sent ? t("siteImportReport.inviteSent") : t("siteImportReport.inviteWaiting"),
						])}
					/>
				</div>
			),
		},
		{
			id: "matched",
			label: t("siteImportReport.tabs.matched"),
			badge: String(report.matched.length),
			panel: (
				<div className="grid gap-4">
					<p className="text-muted-foreground text-sm">{t("siteImportReport.matchedIntro")}</p>
					<ReportTable
						caption={t("siteImportReport.tabs.matched")}
						columns={columns(["name", "email", "role"])}
						rows={report.matched.map((member) => [
							member.name ?? "—",
							member.email,
							t(`roles.${member.role as "owner" | "editor" | "author"}`),
						])}
					/>
				</div>
			),
		},
		{
			id: "reassigned",
			label: t("siteImportReport.tabs.reassigned"),
			badge: String(report.reassigned.length),
			panel: (
				<div className="grid gap-4">
					<p className="text-muted-foreground text-sm">{t("siteImportReport.reassignedIntro")}</p>
					<ReportTable
						caption={t("siteImportReport.tabs.reassigned")}
						columns={columns(["name", "email", "was"])}
						rows={report.reassigned.map((person) => [
							person.name ?? "—",
							person.email,
							person.was ? t(`roles.${person.was as "owner" | "editor" | "author" | "staff" | "superadmin"}`) : "—",
						])}
					/>
				</div>
			),
		},
		{
			id: "paused",
			label: t("siteImportReport.tabs.paused"),
			badge: String(report.paused.length),
			panel: (
				<div className="grid gap-4">
					<p className="text-muted-foreground text-sm">{t("siteImportReport.pausedIntro")}</p>
					<ReportTable
						caption={t("siteImportReport.tabs.paused")}
						columns={columns(["domain", "kind"])}
						rows={report.paused.map((domain) => [
							domain.name,
							domain.language ? `${domain.role} (${domain.language})` : domain.role,
						])}
					/>
					{siteId && report.paused.length > 0 ? (
						<div>
							<Button
								variant="outline"
								render={<Link to="/sites/$siteId/domains" params={{ siteId }} />}
								nativeButton={false}
							>
								{t("siteImportReport.openDomains")}
							</Button>
						</div>
					) : null}
				</div>
			),
		},
		{
			id: "secrets",
			label: t("siteImportReport.tabs.secrets"),
			badge: String(report.secrets.set.length),
			panel: (
				<div className="grid gap-2 text-sm">
					<p>{t("siteImportReport.secretsSet", { names: names(report.secrets.set) })}</p>
					<p>{t("siteImportReport.secretsDropped", { names: names(report.secrets.dropped) })}</p>
					{report.secrets.reason ? (
						<p className="text-muted-foreground">{t(`siteImportReport.secretsReason.${report.secrets.reason}`)}</p>
					) : null}
					{report.webhooksOff.length > 0 ? (
						<p>{t("siteImportReport.webhooksOff", { names: names(report.webhooksOff) })}</p>
					) : null}
					{report.reportsPaused.length > 0 ? (
						<p>{t("siteImportReport.reportsPaused", { names: names(report.reportsPaused) })}</p>
					) : null}
				</div>
			),
		},
		{
			id: "dropped",
			label: t("siteImportReport.tabs.dropped"),
			panel: (
				<div className="grid gap-2 text-sm">
					<p className="text-muted-foreground">{t("siteImportReport.droppedIntro")}</p>
					<p>{t("siteImportReport.droppedContentKeys", { names: names(dropped.contentKeys) })}</p>
					<p>{t("siteImportReport.droppedShareLinks", { names: names(dropped.shareLinks) })}</p>
					<p>
						{t("siteImportReport.droppedSchedules", {
							names: names(
								dropped.scheduledPublishes.map(
									(schedule) => `${schedule.items.join(", ")} (${formatUtc(schedule.at)})`,
								),
							),
						})}
					</p>
					{dropped.stagingPassword ? <p>{t("siteImportReport.droppedStaging")}</p> : null}
				</div>
			),
		},
		{
			id: "modules",
			label: t("siteImportReport.tabs.modules"),
			badge: String(report.modules.length),
			panel: (
				<div className="grid gap-4">
					<p className="text-muted-foreground text-sm">{t("siteImportReport.modulesIntro")}</p>
					<ReportTable
						caption={t("siteImportReport.tabs.modules")}
						columns={columns(["module", "version", "status"])}
						rows={report.modules.map((module) => [
							module.id,
							module.version,
							t(`siteImports.moduleStatus.${module.status}`),
						])}
					/>
				</div>
			),
		},
	];

	return (
		<div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_20rem]">
			<div className="grid content-start gap-8">
				<div className="grid grid-cols-2 gap-4 md:grid-cols-3">
					<Stat
						label={t("siteImportReport.stats.drafts")}
						value={report.counts.entries ?? 0}
						note={t("siteImportReport.stats.draftsNote", { count: report.drafts.published })}
					/>
					<Stat
						label={t("siteImportReport.stats.files")}
						value={report.files.count}
						note={t("siteImportReport.stats.filesNote", { size: formatBytes(report.files.bytes) })}
					/>
					<Stat
						label={t("siteImportReport.stats.invited")}
						value={report.invited.length}
						note={t("siteImportReport.stats.invitedNote", { count: report.invited.length - unsent })}
					/>
					<Stat
						label={t("siteImportReport.stats.paused")}
						value={report.paused.length}
						note={t("siteImportReport.stats.pausedNote")}
					/>
					<Stat
						label={t("siteImportReport.stats.reassigned")}
						value={report.reassigned.length}
						note={t("siteImportReport.stats.reassignedNote")}
					/>
					<Stat
						label={t("siteImportReport.stats.secrets")}
						value={report.secrets.set.length}
						note={t("siteImportReport.stats.secretsNote", { count: report.secrets.dropped.length })}
					/>
				</div>
				<Card>
					<CardContent className="pt-6">
						<Tabs label={t("siteImportReport.tabsLabel")} tabs={tabs} />
					</CardContent>
				</Card>
			</div>
			<div className="grid content-start gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("siteImportReport.nextTitle")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<ol className="grid list-decimal gap-2 ps-5 text-sm">
							<li>{t("siteImportReport.next.staging")}</li>
							<li>{t("siteImportReport.next.publish")}</li>
							{report.paused.length > 0 ? <li>{t("siteImportReport.next.domains")}</li> : null}
							{unsent > 0 ? <li>{t("siteImportReport.next.invite")}</li> : null}
						</ol>
					</CardContent>
				</Card>
				<p className="text-muted-foreground text-sm">
					{t("siteImportReport.kept", { time: formatUtc(view.expiresAt) })}
				</p>
			</div>
		</div>
	);
}

const COLUMN_KEYS = {
	email: "siteImportReport.columns.email",
	name: "siteImportReport.columns.name",
	role: "siteImportReport.columns.role",
	sent: "siteImportReport.columns.sent",
	was: "siteImportReport.columns.was",
	domain: "siteImportReport.columns.domain",
	kind: "siteImportReport.columns.kind",
	module: "siteImportReport.columns.module",
	version: "siteImportReport.columns.version",
	status: "siteImportReport.columns.status",
} as const satisfies Record<string, MessageKey>;
