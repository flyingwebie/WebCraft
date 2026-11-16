import type { SiteExportView } from "@webcraft/core";
import { PASSPHRASE_MAX_LENGTH, PASSPHRASE_MIN_LENGTH } from "@webcraft/core/site-transfer-rules";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
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
import { SettingsCard, SettingsListRow, SettingsRows, StateBadge } from "../settings/layout.tsx";

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
			<div className="grid grid-cols-1 gap-6">
				<SettingsCard title={t("siteExport.whatTitle")} description={t("siteExport.what")}>
					<div className="space-y-1 text-sm">
						<h3 className="font-medium">{t("siteExport.neverTitle")}</h3>
						<p className="text-muted-foreground">{t("siteExport.never")}</p>
					</div>
				</SettingsCard>
				<SettingsCard title={t("siteExport.start")}>
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
						<div className="grid gap-4 @2xl/page:grid-cols-2">
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
						</div>
						{problem ? <FieldError id={problemId}>{t(problem.key, problem.values)}</FieldError> : null}
						<div>
							<Button type="submit" variant="outline" disabled={busy || anyGoing}>
								{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <PackageIcon aria-hidden="true" />}
								{t("siteExport.start")}
							</Button>
						</div>
					</form>
				</SettingsCard>
				<SettingsCard title={t("siteExport.listTitle")} description={t("siteExport.listIntro")}>
					{exports.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("siteExport.listEmpty")}</p>
					) : (
						<SettingsRows>
							{exports.map((each) => (
								<ExportRow key={each.id} item={each} />
							))}
						</SettingsRows>
					)}
				</SettingsCard>
			</div>
		</>
	);
}

function ExportRow({ item }: { item: SiteExportView }) {
	const t = useT();
	const secrets = item.summary?.secrets;
	const tone =
		item.status === "failed"
			? "danger"
			: item.status === "done"
				? "success"
				: item.status === "expired"
					? "neutral"
					: "info";
	return (
		<SettingsListRow
			badge={<StateBadge tone={tone}>{t(`siteExport.status.${item.status}`)}</StateBadge>}
			detail={
				<div className="space-y-0.5">
					<p>
						{t("siteExport.columns.by")}: {item.requestedBy?.name ?? "—"}
						{secrets
							? ` · ${
									secrets.carried
										? t("siteExport.secretsCarried", { count: secrets.names.length })
										: t("siteExport.secretsDropped", { count: secrets.names.length })
								}`
							: null}
					</p>
					{item.progress ? (
						<p aria-live="polite">
							{t(`siteExport.progress.${item.progress.step as "tables" | "files" | "archive"}`, {
								done: item.progress.done,
								total: item.progress.total,
							})}
						</p>
					) : null}
					{item.failure ? (
						<p className="text-red-800 dark:text-red-200">
							{t(`siteExport.failure.${item.failure.reason === "access" ? "access" : "error"}`)}
						</p>
					) : null}
					{item.download ? (
						<>
							<p>
								{item.fileName} · {formatBytes(item.sizeBytes ?? 0)} ·{" "}
								{t("siteExport.until", { time: formatUtc(item.download.expiresAt) })}
							</p>
							{!item.withSubmissions ? <p>{t("siteExport.submissionsDropped")}</p> : null}
							{item.summary ? (
								<p>
									{t("siteExport.leftOut", {
										count: item.summary.leftOut.contentKeys.length,
										links: item.summary.leftOut.shareLinks.length,
										schedules: item.summary.leftOut.scheduledPublishes.length,
									})}
								</p>
							) : null}
						</>
					) : item.status === "expired" ? (
						<p>{item.fileName}</p>
					) : null}
				</div>
			}
			actions={
				item.download ? (
					<a
						href={item.download.url}
						download={item.fileName}
						aria-label={t("siteExport.downloadLabel", { file: item.fileName })}
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						<DownloadIcon aria-hidden="true" />
						{t("siteExport.download")}
					</a>
				) : null
			}
		>
			<span>{formatUtc(item.createdAt)}</span>
		</SettingsListRow>
	);
}
