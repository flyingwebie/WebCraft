import type { SiteExportView } from "@webcraft/core";
import { PASSPHRASE_MAX_LENGTH, PASSPHRASE_MIN_LENGTH } from "@webcraft/core/site-transfer-rules";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@webcraft/ui/components/table.tsx";
import { DownloadIcon, LoaderIcon, PackageIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { formatBytes } from "../media/preview.ts";
import { PageHeader } from "../PageHeader.tsx";
import { PasswordInput } from "../PasswordInput.tsx";

/** How often an export being written is asked about again. */
const POLL_MS = 2000;

const going = (status: SiteExportView["status"]) => status === "waiting" || status === "running";

/**
 * Site › Export (Site settings, Staff: `site.export`): exports the Site as one file (ADR 0033), with or
 * without an export passphrase for its secrets, and lists its exports with their download links, which
 * work for 24 hours. The worker writes each one; this page follows its progress.
 */
export function SiteExportPage({ siteId, initial }: { siteId: string; initial: SiteExportView[] }) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const [exports, setExports] = useState(initial);
	const [includeSubmissions, setIncludeSubmissions] = useState(true);
	const [passphrase, setPassphrase] = useState("");
	const [repeat, setRepeat] = useState("");
	const [problem, setProblem] = useState<{ key: MessageKey; values?: Record<string, number> } | null>(null);
	const [busy, setBusy] = useState(false);
	const submissionsId = useId();
	const passphraseId = useId();
	const repeatId = useId();
	const problemId = useId();
	const anyGoing = exports.some((each) => going(each.status));

	useEffect(() => setExports(initial), [initial]);

	useEffect(() => {
		if (!anyGoing) return;
		const timer = setInterval(async () => {
			try {
				const api = await getApi();
				setExports((await api.siteExports.list({ siteId })).exports);
			} catch {
				// Asked again at the next tick.
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [anyGoing, siteId]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (passphrase !== "" && passphrase.length < PASSPHRASE_MIN_LENGTH) {
			setProblem({ key: "siteExport.passphraseShort", values: { min: PASSPHRASE_MIN_LENGTH } });
			return;
		}
		if (passphrase !== repeat) {
			setProblem({ key: "siteExport.passphraseMismatch" });
			return;
		}
		setProblem(null);
		setBusy(true);
		try {
			const api = await getApi();
			const { export: started } = await runSensitive(() =>
				api.siteExports.start({ siteId, includeSubmissions, passphrase: passphrase === "" ? null : passphrase }),
			);
			setExports((current) => [started, ...current]);
			setPassphrase("");
			setRepeat("");
			toast.success(t("siteExport.started"));
		} catch (failure) {
			setProblem({ key: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeader heading={t("siteExport.heading")}>{t("siteExport.intro")}</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-8">
				<div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("siteExport.whatTitle")}</h2>
							</CardTitle>
						</CardHeader>
						<CardContent className="grid gap-4 text-sm">
							<p>{t("siteExport.what")}</p>
							<h3 className="font-medium">{t("siteExport.neverTitle")}</h3>
							<p className="text-muted-foreground">{t("siteExport.never")}</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("siteExport.start")}</h2>
							</CardTitle>
						</CardHeader>
						<CardContent>
							<form className="grid gap-4" onSubmit={submit} noValidate>
								<Field orientation="horizontal">
									<Checkbox
										id={submissionsId}
										checked={includeSubmissions}
										onCheckedChange={setIncludeSubmissions}
										aria-describedby={`${submissionsId}-help`}
									/>
									<FieldContent>
										<FieldLabel htmlFor={submissionsId}>{t("siteExport.includeSubmissions")}</FieldLabel>
										<FieldDescription id={`${submissionsId}-help`}>{t("siteExport.submissionsHelp")}</FieldDescription>
									</FieldContent>
								</Field>
								<Field>
									<FieldLabel htmlFor={passphraseId}>{t("siteExport.passphrase")}</FieldLabel>
									<PasswordInput
										id={passphraseId}
										value={passphrase}
										autoComplete="new-password"
										maxLength={PASSPHRASE_MAX_LENGTH}
										aria-describedby={`${passphraseId}-help${problem ? ` ${problemId}` : ""}`}
										aria-invalid={problem ? true : undefined}
										onChange={(event) => setPassphrase(event.target.value)}
									/>
									<FieldDescription id={`${passphraseId}-help`}>{t("siteExport.passphraseHelp")}</FieldDescription>
								</Field>
								<Field>
									<FieldLabel htmlFor={repeatId}>{t("siteExport.passphraseRepeat")}</FieldLabel>
									<PasswordInput
										id={repeatId}
										value={repeat}
										autoComplete="new-password"
										maxLength={PASSPHRASE_MAX_LENGTH}
										aria-invalid={problem ? true : undefined}
										onChange={(event) => setRepeat(event.target.value)}
									/>
								</Field>
								{problem ? <FieldError id={problemId}>{t(problem.key, problem.values)}</FieldError> : null}
								<div>
									<Button type="submit" disabled={busy || anyGoing}>
										{busy ? (
											<LoaderIcon className="animate-spin" aria-hidden="true" />
										) : (
											<PackageIcon aria-hidden="true" />
										)}
										{t("siteExport.start")}
									</Button>
								</div>
							</form>
						</CardContent>
					</Card>
				</div>
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("siteExport.listTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("siteExport.listIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{exports.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("siteExport.listEmpty")}</p>
						) : (
							<Table>
								<TableCaption className="sr-only">{t("siteExport.caption")}</TableCaption>
								<TableHeader>
									<TableRow>
										<TableHead>{t("siteExport.columns.created")}</TableHead>
										<TableHead>{t("siteExport.columns.by")}</TableHead>
										<TableHead>{t("siteExport.columns.status")}</TableHead>
										<TableHead>{t("siteExport.columns.secrets")}</TableHead>
										<TableHead>{t("siteExport.columns.file")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{exports.map((each) => (
										<ExportRow key={each.id} item={each} />
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			</div>
		</>
	);
}

function ExportRow({ item }: { item: SiteExportView }) {
	const t = useT();
	const secrets = item.summary?.secrets;
	return (
		<TableRow>
			<TableCell>{formatUtc(item.createdAt)}</TableCell>
			<TableCell>{item.requestedBy?.name ?? "—"}</TableCell>
			<TableCell>
				<div className="grid gap-1">
					<span>
						<Badge
							variant={item.status === "failed" ? "destructive" : item.status === "done" ? "default" : "secondary"}
						>
							{t(`siteExport.status.${item.status}`)}
						</Badge>
					</span>
					{item.progress ? (
						<span className="text-muted-foreground text-xs" aria-live="polite">
							{t(`siteExport.progress.${item.progress.step as "tables" | "files" | "archive"}`, {
								done: item.progress.done,
								total: item.progress.total,
							})}
						</span>
					) : null}
					{item.failure ? (
						<span className="text-xs text-red-800 dark:text-red-200">
							{t(`siteExport.failure.${item.failure.reason === "access" ? "access" : "error"}`)}
						</span>
					) : null}
				</div>
			</TableCell>
			<TableCell>
				{secrets
					? secrets.carried
						? t("siteExport.secretsCarried", { count: secrets.names.length })
						: t("siteExport.secretsDropped", { count: secrets.names.length })
					: "—"}
			</TableCell>
			<TableCell>
				{item.download ? (
					<div className="grid gap-1">
						<span>
							<a
								href={item.download.url}
								download={item.fileName}
								aria-label={t("siteExport.downloadLabel", { file: item.fileName })}
								className={buttonVariants({ variant: "outline", size: "sm" })}
							>
								<DownloadIcon aria-hidden="true" />
								{t("siteExport.download")}
							</a>
						</span>
						<span className="text-muted-foreground text-xs">
							{formatBytes(item.sizeBytes ?? 0)} · {t("siteExport.until", { time: formatUtc(item.download.expiresAt) })}
						</span>
						{!item.withSubmissions ? (
							<span className="text-muted-foreground text-xs">{t("siteExport.submissionsDropped")}</span>
						) : null}
						{item.summary ? (
							<span className="text-muted-foreground text-xs">
								{t("siteExport.leftOut", {
									count: item.summary.leftOut.contentKeys.length,
									links: item.summary.leftOut.shareLinks.length,
									schedules: item.summary.leftOut.scheduledPublishes.length,
								})}
							</span>
						) : null}
					</div>
				) : (
					<span className="text-muted-foreground">{item.status === "expired" ? item.fileName : "—"}</span>
				)}
			</TableCell>
		</TableRow>
	);
}
