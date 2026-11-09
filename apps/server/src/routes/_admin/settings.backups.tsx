import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { ArchiveIcon, LockIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { PasswordInput } from "../../ui/PasswordInput.tsx";

export const Route = createFileRoute("/_admin/settings/backups")({
	staticData: { crumb: "backupSettings.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		return (await getApi()).install.backups.get();
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "backupSettings.pageTitle") }],
	}),
	component: BackupSettingsPage,
});

type BackupsView = Awaited<ReturnType<ApiClient["install"]["backups"]["get"]>>;
type BackupLine = BackupsView["backups"][number];

/**
 * Install settings › Backups: whether the worker takes a Backup every day, where Backups go, the
 * Backup log, and how to restore one (a server command).
 */
function BackupSettingsPage() {
	const t = useT();
	const data = Route.useLoaderData();
	// A new form after each save, so it starts from what was saved.
	const [version, setVersion] = useState(0);
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("backupSettings.heading")}>{t("backupSettings.intro")}</PageHeader>
			<div className="flex max-w-4xl flex-col gap-10">
				<BackupForm key={version} view={data.settings} onSaved={() => setVersion((current) => current + 1)} />
				<BackupLog backups={data.backups} />
				<section aria-labelledby="backup-restore-heading" className="grid max-w-3xl gap-3">
					<h2 id="backup-restore-heading" className="text-lg font-semibold tracking-tight">
						{t("backupSettings.restore.heading")}
					</h2>
					<p className="text-muted-foreground text-sm">{t("backupSettings.restore.body")}</p>
					<pre className="bg-muted overflow-x-auto rounded-md border px-3 py-2 text-sm">
						<code>webcraft admin restore /var/lib/webcraft/backups/webcraft-backup-….tar</code>
					</pre>
					<p className="text-muted-foreground text-sm">{t("backupSettings.restore.site")}</p>
				</section>
			</div>
		</>
	);
}

type FieldName = "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey";

const S3_FIELDS: readonly FieldName[] = ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"];

function BackupForm({ view, onSaved }: { view: BackupsView["settings"]; onSaved(): void }) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [scheduled, setScheduled] = useState(view.scheduled);
	const [target, setTarget] = useState<"folder" | "s3">(view.target);
	const [endpoint, setEndpoint] = useState(view.s3?.endpoint ?? "");
	const [region, setRegion] = useState(view.s3?.region ?? "");
	const [bucket, setBucket] = useState(view.s3?.bucket ?? "");
	const [prefix, setPrefix] = useState(view.s3?.prefix ?? "");
	const [pathStyle, setPathStyle] = useState(view.s3?.pathStyle ?? true);
	const [accessKeyId, setAccessKeyId] = useState(view.s3?.accessKeyId ?? "");
	const stored = view.s3?.secretAccessKey.set ? view.s3.secretAccessKey : null;
	const [replacing, setReplacing] = useState(!stored);
	const [secretAccessKey, setSecretAccessKey] = useState("");
	const [errors, setErrors] = useState<Partial<Record<FieldName | "form", MessageKey>>>({});
	const [busy, setBusy] = useState(false);
	const [focusSecret, setFocusSecret] = useState(false);

	useEffect(() => {
		if (focusSecret) document.getElementById("backups-secretAccessKey")?.focus();
		setFocusSecret(false);
	}, [focusSecret]);

	const save = async (event: FormEvent) => {
		event.preventDefault();
		const found: Partial<Record<FieldName, MessageKey>> = {};
		if (target === "s3") {
			const values: Record<FieldName, string> = { endpoint, region, bucket, accessKeyId, secretAccessKey };
			for (const field of S3_FIELDS) {
				if (field === "secretAccessKey" && !replacing) continue;
				if (values[field].trim() === "") found[field] = "storageSettings.errors.required";
			}
			if (!found.endpoint && !/^https?:\/\/\S+$/i.test(endpoint.trim())) {
				found.endpoint = "storageSettings.errors.endpointInvalid";
			}
		}
		setErrors(found);
		const first = S3_FIELDS.find((field) => found[field]);
		if (first) {
			document.getElementById(`backups-${first}`)?.focus();
			return;
		}
		setBusy(true);
		try {
			const api = await getApi();
			// A Sensitive action: a bucket's secret access key is a secret.
			await runSensitive(() =>
				api.install.backups.update({
					scheduled,
					target:
						target === "folder"
							? { kind: "folder" }
							: {
									kind: "s3",
									endpoint: endpoint.trim(),
									region: region.trim(),
									bucket: bucket.trim(),
									prefix: prefix.trim(),
									pathStyle,
									accessKeyId: accessKeyId.trim(),
									secretAccessKey: replacing ? secretAccessKey : undefined,
								},
				}),
			);
			toast.success(t("backupSettings.saved"));
			await router.invalidate();
			onSaved();
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	const describedBy = (field: FieldName, help?: string) =>
		[help, errors[field] ? `backups-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;
	const invalid = (field: FieldName) => (errors[field] ? true : undefined);
	const error = (field: FieldName) => {
		const message = errors[field];
		return message ? <FieldError id={`backups-${field}-error`}>{t(message)}</FieldError> : null;
	};
	const textField = (
		field: Exclude<FieldName, "secretAccessKey">,
		value: string,
		set: (value: string) => void,
		help?: MessageKey,
	) => (
		<Field data-invalid={invalid(field)}>
			<FieldLabel htmlFor={`backups-${field}`}>{t(`storageSettings.${field}`)}</FieldLabel>
			<Input
				id={`backups-${field}`}
				value={value}
				onChange={(event) => set(event.target.value)}
				autoComplete="off"
				spellCheck={false}
				required
				aria-invalid={invalid(field)}
				aria-describedby={describedBy(field, help ? `backups-${field}-help` : undefined)}
			/>
			{help ? <FieldDescription id={`backups-${field}-help`}>{t(help)}</FieldDescription> : null}
			{error(field)}
		</Field>
	);

	return (
		<form onSubmit={save} className="flex max-w-3xl flex-col gap-6" noValidate>
			<label className="flex items-start gap-3 text-sm">
				<input
					type="checkbox"
					checked={scheduled}
					onChange={(event) => setScheduled(event.target.checked)}
					aria-describedby="backups-scheduled-help"
					className="accent-primary mt-0.5 size-4 shrink-0"
				/>
				<span className="flex flex-col gap-1">
					<span className="font-medium">{t("backupSettings.scheduled")}</span>
					<span id="backups-scheduled-help" className="text-muted-foreground">
						{t("backupSettings.scheduledHelp", { daily: view.keep.daily, weekly: view.keep.weekly })}
					</span>
				</span>
			</label>

			<fieldset className="grid gap-3">
				<legend className="mb-3 text-sm font-medium">{t("backupSettings.where")}</legend>
				<TargetOption
					value="folder"
					checked={target === "folder"}
					onChange={setTarget}
					label={t("backupSettings.folder")}
					help={t("backupSettings.folderHelp", { directory: view.folder })}
				/>
				<TargetOption
					value="s3"
					checked={target === "s3"}
					onChange={setTarget}
					label={t("backupSettings.s3")}
					help={t("backupSettings.s3Help")}
				/>
			</fieldset>

			{target === "s3" ? (
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("storageSettings.bucketHeading")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<FieldGroup className="gap-5">
							{textField("endpoint", endpoint, setEndpoint, "storageSettings.endpointHelp")}
							<div className="grid gap-5 md:grid-cols-2">
								{textField("region", region, setRegion, "storageSettings.regionHelp")}
								{textField("bucket", bucket, setBucket)}
							</div>
							<Field>
								<FieldLabel htmlFor="backups-prefix">{t("storageSettings.prefix")}</FieldLabel>
								<Input
									id="backups-prefix"
									value={prefix}
									onChange={(event) => setPrefix(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									aria-describedby="backups-prefix-help"
								/>
								<FieldDescription id="backups-prefix-help">{t("backupSettings.prefixHelp")}</FieldDescription>
							</Field>
							<label className="flex items-start gap-3 text-sm">
								<input
									type="checkbox"
									checked={pathStyle}
									onChange={(event) => setPathStyle(event.target.checked)}
									aria-describedby="backups-pathStyle-help"
									className="accent-primary mt-0.5 size-4 shrink-0"
								/>
								<span className="flex flex-col gap-1">
									<span className="font-medium">{t("storageSettings.pathStyle")}</span>
									<span id="backups-pathStyle-help" className="text-muted-foreground">
										{t("storageSettings.pathStyleHelp")}
									</span>
								</span>
							</label>
							<div className="grid gap-5 md:grid-cols-2">
								{textField("accessKeyId", accessKeyId, setAccessKeyId)}
								{stored && !replacing ? (
									<Field>
										<p id="backups-secret-label" className="text-sm font-medium">
											{t("storageSettings.secretAccessKey")}
										</p>
										<div className="flex items-center gap-3">
											<p
												id="backups-secret-status"
												className="bg-muted text-muted-foreground flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm"
											>
												<LockIcon className="size-4 shrink-0" aria-hidden="true" />
												{stored.lastFour
													? t("storageSettings.secretSet", { lastFour: stored.lastFour })
													: t("storageSettings.secretSetHidden")}
											</p>
											<Button
												type="button"
												variant="outline"
												onClick={() => {
													setReplacing(true);
													setFocusSecret(true);
												}}
												aria-describedby="backups-secret-label backups-secret-status"
											>
												{t("storageSettings.replace")}
											</Button>
										</div>
										<FieldDescription>{t("storageSettings.secretHelp")}</FieldDescription>
									</Field>
								) : (
									<Field data-invalid={invalid("secretAccessKey")}>
										<FieldLabel htmlFor="backups-secretAccessKey">{t("storageSettings.secretAccessKey")}</FieldLabel>
										<PasswordInput
											id="backups-secretAccessKey"
											value={secretAccessKey}
											onChange={(event) => setSecretAccessKey(event.target.value)}
											autoComplete="new-password"
											aria-invalid={invalid("secretAccessKey")}
											aria-describedby={describedBy("secretAccessKey", "backups-secretAccessKey-help")}
										/>
										<FieldDescription id="backups-secretAccessKey-help">
											{t("storageSettings.secretHelp")}
										</FieldDescription>
										{error("secretAccessKey")}
										{stored ? (
											<div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() => {
														setReplacing(false);
														setSecretAccessKey("");
													}}
												>
													{t("storageSettings.keep")}
												</Button>
											</div>
										) : null}
									</Field>
								)}
							</div>
						</FieldGroup>
					</CardContent>
				</Card>
			) : null}

			{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
			<div>
				<Button type="submit" disabled={busy}>
					{t("backupSettings.save")}
				</Button>
			</div>
		</form>
	);
}

function TargetOption({
	value,
	checked,
	onChange,
	label,
	help,
}: {
	value: "folder" | "s3";
	checked: boolean;
	onChange(value: "folder" | "s3"): void;
	label: string;
	help: string;
}) {
	return (
		<label className="has-[:checked]:border-primary flex items-start gap-3 rounded-lg border p-4 text-sm">
			<input
				type="radio"
				name="backups-target"
				value={value}
				checked={checked}
				onChange={() => onChange(value)}
				aria-describedby={`backups-target-${value}-help`}
				className="accent-primary mt-0.5 size-4 shrink-0"
			/>
			<span className="flex flex-col gap-1">
				<span className="font-medium">{label}</span>
				<span id={`backups-target-${value}-help`} className="text-muted-foreground [overflow-wrap:anywhere]">
					{help}
				</span>
			</span>
		</label>
	);
}

const COLUMNS: readonly MessageKey[] = [
	"backupSettings.log.when",
	"backupSettings.log.reason",
	"backupSettings.log.status",
	"backupSettings.log.size",
	"backupSettings.log.where",
];

const REASONS: Record<BackupLine["reason"], MessageKey> = {
	scheduled: "backupSettings.log.reasons.scheduled",
	command: "backupSettings.log.reasons.command",
	"before-migrations": "backupSettings.log.reasons.beforeMigrations",
};

/** The Backup log, newest first: when each was taken, why, how it ended, its size and where it is. */
function BackupLog({ backups }: { backups: readonly BackupLine[] }) {
	const t = useT();
	return (
		<div className="grid gap-4">
			<h2 id="backup-log-heading" className="text-lg font-semibold tracking-tight">
				{t("backupSettings.log.heading")}
			</h2>
			{backups.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ArchiveIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>
							<h3>{t("backupSettings.log.emptyTitle")}</h3>
						</EmptyTitle>
						<EmptyDescription>{t("backupSettings.log.emptyBody")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				// Scrolls sideways on narrow screens: focusable, so keyboards can scroll it too.
				<section
					aria-labelledby="backup-log-caption"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					tabIndex={0}
					className="focus-visible:ring-ring/50 overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]"
				>
					<table className="w-full text-start text-sm">
						<caption id="backup-log-caption" className="sr-only">
							{t("backupSettings.log.heading")}
						</caption>
						<thead className="bg-muted/50">
							<tr>
								{COLUMNS.map((column) => (
									<th key={column} scope="col" className="px-3 py-2 text-start font-medium whitespace-nowrap">
										{t(column)}
									</th>
								))}
							</tr>
						</thead>
						<tbody className="divide-y">
							{backups.map((backup) => (
								<tr key={backup.id} className="align-top">
									<td className="px-3 py-2 whitespace-nowrap">{formatUtc(backup.startedAt)}</td>
									<td className="px-3 py-2 whitespace-nowrap">{t(REASONS[backup.reason])}</td>
									<td className="min-w-40 px-3 py-2">
										<BackupStatus backup={backup} />
									</td>
									<td className="px-3 py-2 text-end whitespace-nowrap tabular-nums">
										{backup.sizeBytes === null ? "" : megabytes(backup.sizeBytes)}
									</td>
									<td className="text-muted-foreground min-w-56 px-3 py-2 break-all">{backup.location}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
		</div>
	);
}

function BackupStatus({ backup }: { backup: BackupLine }) {
	const t = useT();
	if (backup.removedAt) return <Badge variant="outline">{t("backupSettings.log.statuses.removed")}</Badge>;
	if (backup.status === "failed") {
		return (
			<>
				<Badge variant="destructive">{t("backupSettings.log.statuses.failed")}</Badge>
				{backup.problem ? <p className="text-muted-foreground mt-1 text-xs break-words">{backup.problem}</p> : null}
			</>
		);
	}
	if (backup.status === "running") return <Badge variant="secondary">{t("backupSettings.log.statuses.running")}</Badge>;
	return <Badge variant="outline">{t("backupSettings.log.statuses.done")}</Badge>;
}

function megabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
