import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { LockIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { PasswordInput } from "../../ui/PasswordInput.tsx";

export const Route = createFileRoute("/_admin/settings/storage")({
	staticData: { crumb: "storageSettings.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		const api = await getApi();
		return api.install.storage.get();
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "storageSettings.pageTitle") }],
	}),
	component: StorageSettingsPage,
});

type StorageView = Awaited<ReturnType<ApiClient["install"]["storage"]["get"]>>;

/** Install settings › Storage: local disk or an S3-compatible bucket, for files uploaded from now on. */
function StorageSettingsPage() {
	const t = useT();
	const view = Route.useLoaderData();
	// A new form after each save, so it starts from what was saved.
	const [version, setVersion] = useState(0);
	if (!view) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("storageSettings.heading")}>{t("storageSettings.intro")}</PageHeader>
			<StorageForm key={version} view={view} onSaved={() => setVersion((current) => current + 1)} />
		</>
	);
}

type FieldName = "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey";

const S3_FIELDS: readonly FieldName[] = ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"];

function StorageForm({ view, onSaved }: { view: StorageView; onSaved(): void }) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [kind, setKind] = useState<"disk" | "s3">(view.kind);
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
		if (focusSecret) document.getElementById("storage-secretAccessKey")?.focus();
		setFocusSecret(false);
	}, [focusSecret]);

	const save = async (event: FormEvent) => {
		event.preventDefault();
		const found: Partial<Record<FieldName, MessageKey>> = {};
		if (kind === "s3") {
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
			document.getElementById(`storage-${first}`)?.focus();
			return;
		}
		setBusy(true);
		try {
			const api = await getApi();
			// A Sensitive action: the bucket's secret key is a secret.
			await runSensitive(() =>
				api.install.storage.update(
					kind === "disk"
						? { kind: "disk" }
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
				),
			);
			toast.success(t("storageSettings.saved"));
			await router.invalidate();
			onSaved();
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	const describedBy = (field: FieldName, help?: string) =>
		[help, errors[field] ? `storage-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;
	const invalid = (field: FieldName) => (errors[field] ? true : undefined);
	const error = (field: FieldName) => {
		const message = errors[field];
		return message ? <FieldError id={`storage-${field}-error`}>{t(message)}</FieldError> : null;
	};
	const textField = (
		field: Exclude<FieldName, "secretAccessKey">,
		value: string,
		set: (value: string) => void,
		help?: MessageKey,
	) => (
		<Field data-invalid={invalid(field)}>
			<FieldLabel htmlFor={`storage-${field}`}>{t(`storageSettings.${field}`)}</FieldLabel>
			<Input
				id={`storage-${field}`}
				value={value}
				onChange={(event) => set(event.target.value)}
				autoComplete="off"
				spellCheck={false}
				required
				aria-invalid={invalid(field)}
				aria-describedby={describedBy(field, help ? `storage-${field}-help` : undefined)}
			/>
			{help ? <FieldDescription id={`storage-${field}-help`}>{t(help)}</FieldDescription> : null}
			{error(field)}
		</Field>
	);

	return (
		<form onSubmit={save} className="flex max-w-3xl flex-col gap-6" noValidate>
			<fieldset className="grid gap-3">
				<legend className="mb-3 text-sm font-medium">{t("storageSettings.where")}</legend>
				<KindOption
					value="disk"
					checked={kind === "disk"}
					onChange={setKind}
					label={t("storageSettings.disk")}
					help={t("storageSettings.diskHelp", { directory: view.directory })}
				/>
				<KindOption
					value="s3"
					checked={kind === "s3"}
					onChange={setKind}
					label={t("storageSettings.s3")}
					help={t("storageSettings.s3Help")}
				/>
			</fieldset>

			{kind === "s3" ? (
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
								<FieldLabel htmlFor="storage-prefix">{t("storageSettings.prefix")}</FieldLabel>
								<Input
									id="storage-prefix"
									value={prefix}
									onChange={(event) => setPrefix(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									aria-describedby="storage-prefix-help"
								/>
								<FieldDescription id="storage-prefix-help">{t("storageSettings.prefixHelp")}</FieldDescription>
							</Field>
							<label className="flex items-start gap-3 text-sm">
								<input
									type="checkbox"
									checked={pathStyle}
									onChange={(event) => setPathStyle(event.target.checked)}
									aria-describedby="storage-pathStyle-help"
									className="accent-primary mt-0.5 size-4 shrink-0"
								/>
								<span className="flex flex-col gap-1">
									<span className="font-medium">{t("storageSettings.pathStyle")}</span>
									<span id="storage-pathStyle-help" className="text-muted-foreground">
										{t("storageSettings.pathStyleHelp")}
									</span>
								</span>
							</label>
							<div className="grid gap-5 md:grid-cols-2">
								{textField("accessKeyId", accessKeyId, setAccessKeyId)}
								{stored && !replacing ? (
									<Field>
										<p id="storage-secret-label" className="text-sm font-medium">
											{t("storageSettings.secretAccessKey")}
										</p>
										<div className="flex items-center gap-3">
											<p
												id="storage-secret-status"
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
												aria-describedby="storage-secret-label storage-secret-status"
											>
												{t("storageSettings.replace")}
											</Button>
										</div>
										<FieldDescription>{t("storageSettings.secretHelp")}</FieldDescription>
									</Field>
								) : (
									<Field data-invalid={invalid("secretAccessKey")}>
										<FieldLabel htmlFor="storage-secretAccessKey">{t("storageSettings.secretAccessKey")}</FieldLabel>
										<PasswordInput
											id="storage-secretAccessKey"
											value={secretAccessKey}
											onChange={(event) => setSecretAccessKey(event.target.value)}
											autoComplete="new-password"
											aria-invalid={invalid("secretAccessKey")}
											aria-describedby={describedBy("secretAccessKey", "storage-secretAccessKey-help")}
										/>
										<FieldDescription id="storage-secretAccessKey-help">
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
					{t("storageSettings.save")}
				</Button>
			</div>
		</form>
	);
}

function KindOption({
	value,
	checked,
	onChange,
	label,
	help,
}: {
	value: "disk" | "s3";
	checked: boolean;
	onChange(value: "disk" | "s3"): void;
	label: string;
	help: string;
}) {
	return (
		<label className="has-[:checked]:border-primary flex items-start gap-3 rounded-lg border p-4 text-sm">
			<input
				type="radio"
				name="storage-kind"
				value={value}
				checked={checked}
				onChange={() => onChange(value)}
				aria-describedby={`storage-kind-${value}-help`}
				className="accent-primary mt-0.5 size-4 shrink-0"
			/>
			<span className="flex flex-col gap-1">
				<span className="font-medium">{label}</span>
				<span id={`storage-kind-${value}-help`} className="text-muted-foreground [overflow-wrap:anywhere]">
					{help}
				</span>
			</span>
		</label>
	);
}
