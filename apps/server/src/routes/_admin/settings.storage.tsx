import { createFileRoute } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { LockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { PasswordInput } from "../../ui/PasswordInput.tsx";
import { SettingsForm, useSettingsPart, useSettingsSection } from "../../ui/settings/form.tsx";
import { describedBy as rowHelp, SettingsCard, SettingsRow, SettingsRows, Switch } from "../../ui/settings/layout.tsx";

export const Route = createFileRoute("/_admin/settings/storage")({
	staticData: { crumb: "storageSettings.pageTitle", width: "form" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		const api = await getApi();
		const [storage, media] = await Promise.all([api.install.storage.get(), api.install.media.get()]);
		return { storage, media };
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
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("storageSettings.heading")}>{t("storageSettings.intro")}</PageHeader>
			<SettingsForm>
				<div className="flex flex-col gap-6">
					{/* A new form after each save, so it starts from what was saved. */}
					<StorageForm key={JSON.stringify(data.storage)} view={data.storage} />
					<LargestFileCard maxFileBytes={data.media.maxFileBytes} />
				</div>
			</SettingsForm>
		</>
	);
}

const MB = 1024 * 1024;

/** The largest file the Media library takes, in MB (1 to 1024): the Superadmin's Install setting. */
function LargestFileCard({ maxFileBytes }: { maxFileBytes: number }) {
	const t = useT();
	const section = useSettingsSection({
		saved: { megabytes: String(Math.round(maxFileBytes / MB)) },
		check: ({ megabytes }) => {
			const value = Number(megabytes);
			if (/^\d+$/.test(megabytes.trim()) && value >= 1 && value <= 1024) return null;
			document.getElementById("storage-largest-file")?.focus();
			return "storageSettings.largestFile.invalid";
		},
		save: async ({ megabytes }) => (await getApi()).install.media.update({ maxFileBytes: Number(megabytes) * MB }),
	});
	const error = section.error;
	return (
		<SettingsCard title={t("storageSettings.largestFile.heading")}>
			<form {...section.formProps}>
				<SettingsRows>
					<SettingsRow
						label={t("storageSettings.largestFile.label")}
						help={t("storageSettings.largestFile.help")}
						htmlFor="storage-largest-file"
					>
						<Input
							id="storage-largest-file"
							type="number"
							inputMode="numeric"
							min={1}
							max={1024}
							step={1}
							className="w-28"
							value={section.values.megabytes}
							onChange={(event) => section.set({ megabytes: event.target.value })}
							aria-invalid={error ? true : undefined}
							aria-describedby={[rowHelp("storage-largest-file"), error ? "storage-largest-file-error" : null]
								.filter(Boolean)
								.join(" ")}
						/>
					</SettingsRow>
				</SettingsRows>
				{error ? (
					<FieldError id="storage-largest-file-error" className="mt-3">
						{t(error)}
					</FieldError>
				) : null}
			</form>
		</SettingsCard>
	);
}

type FieldName = "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey";

const S3_FIELDS: readonly FieldName[] = ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"];

function StorageForm({ view }: { view: StorageView }) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const initial = {
		kind: view.kind,
		endpoint: view.s3?.endpoint ?? "",
		region: view.s3?.region ?? "",
		bucket: view.s3?.bucket ?? "",
		prefix: view.s3?.prefix ?? "",
		pathStyle: view.s3?.pathStyle ?? true,
		accessKeyId: view.s3?.accessKeyId ?? "",
	};
	const [kind, setKind] = useState<"disk" | "s3">(initial.kind);
	const [endpoint, setEndpoint] = useState(initial.endpoint);
	const [region, setRegion] = useState(initial.region);
	const [bucket, setBucket] = useState(initial.bucket);
	const [prefix, setPrefix] = useState(initial.prefix);
	const [pathStyle, setPathStyle] = useState(initial.pathStyle);
	const [accessKeyId, setAccessKeyId] = useState(initial.accessKeyId);
	const stored = view.s3?.secretAccessKey.set ? view.s3.secretAccessKey : null;
	const [replacing, setReplacing] = useState(!stored);
	const [secretAccessKey, setSecretAccessKey] = useState("");
	const [errors, setErrors] = useState<Partial<Record<FieldName | "form", MessageKey>>>({});
	const [focusSecret, setFocusSecret] = useState(false);

	useEffect(() => {
		if (focusSecret) document.getElementById("storage-secretAccessKey")?.focus();
		setFocusSecret(false);
	}, [focusSecret]);

	const changed =
		kind !== initial.kind ||
		(kind === "s3" &&
			(endpoint !== initial.endpoint ||
				region !== initial.region ||
				bucket !== initial.bucket ||
				prefix !== initial.prefix ||
				pathStyle !== initial.pathStyle ||
				accessKeyId !== initial.accessKeyId ||
				(stored !== null && replacing) ||
				secretAccessKey !== ""));

	/** Saves the form; answers whether it was saved. */
	const store = async (): Promise<boolean> => {
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
			return false;
		}
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
			return true;
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
			return false;
		}
	};

	const part = useSettingsPart({
		changed,
		save: store,
		discard: () => {
			setKind(initial.kind);
			setEndpoint(initial.endpoint);
			setRegion(initial.region);
			setBucket(initial.bucket);
			setPrefix(initial.prefix);
			setPathStyle(initial.pathStyle);
			setAccessKeyId(initial.accessKeyId);
			setReplacing(!stored);
			setSecretAccessKey("");
			setErrors({});
		},
	});
	/** A setter that also tells the foot bar the person edited something. */
	const edit =
		<Value,>(set: (value: Value) => void) =>
		(value: Value) => {
			set(value);
			part.edited();
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
		<form {...part.formProps} className="flex flex-col gap-6">
			<SettingsCard title={t("storageSettings.where")}>
				<fieldset className="grid gap-3">
					<legend className="sr-only">{t("storageSettings.where")}</legend>
					<KindOption
						value="disk"
						checked={kind === "disk"}
						onChange={edit(setKind)}
						label={t("storageSettings.disk")}
						help={t("storageSettings.diskHelp", { directory: view.directory })}
					/>
					<KindOption
						value="s3"
						checked={kind === "s3"}
						onChange={edit(setKind)}
						label={t("storageSettings.s3")}
						help={t("storageSettings.s3Help")}
					/>
				</fieldset>
				{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
			</SettingsCard>

			{kind === "s3" ? (
				<SettingsCard title={t("storageSettings.bucketHeading")}>
					<FieldGroup className="gap-5">
						{textField("endpoint", endpoint, edit(setEndpoint), "storageSettings.endpointHelp")}
						<div className="grid gap-5 md:grid-cols-2">
							{textField("region", region, edit(setRegion), "storageSettings.regionHelp")}
							{textField("bucket", bucket, edit(setBucket))}
						</div>
						<Field>
							<FieldLabel htmlFor="storage-prefix">{t("storageSettings.prefix")}</FieldLabel>
							<Input
								id="storage-prefix"
								value={prefix}
								onChange={(event) => edit(setPrefix)(event.target.value)}
								autoComplete="off"
								spellCheck={false}
								aria-describedby="storage-prefix-help"
							/>
							<FieldDescription id="storage-prefix-help">{t("storageSettings.prefixHelp")}</FieldDescription>
						</Field>
						<SettingsRows>
							<SettingsRow
								label={t("storageSettings.pathStyle")}
								help={t("storageSettings.pathStyleHelp")}
								htmlFor="storage-pathStyle"
							>
								<Switch
									id="storage-pathStyle"
									checked={pathStyle}
									onCheckedChange={edit(setPathStyle)}
									aria-describedby={rowHelp("storage-pathStyle")}
								/>
							</SettingsRow>
						</SettingsRows>
						<div className="grid gap-5 md:grid-cols-2">
							{textField("accessKeyId", accessKeyId, edit(setAccessKeyId))}
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
												edit(setReplacing)(true);
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
										onChange={(event) => edit(setSecretAccessKey)(event.target.value)}
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
													edit(setReplacing)(false);
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
				</SettingsCard>
			) : null}
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
