import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { ArrowLeftIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { slugFrom } from "../site-slug.ts";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

type FieldName = "workspaceName" | "siteName" | "siteSlug" | "form";

const FIELD_IDS: Record<Exclude<FieldName, "form">, string> = {
	workspaceName: "first-workspace-name",
	siteName: "first-site-name",
	siteSlug: "first-site-slug",
};

/**
 * The first client step, the wizard's last: the Install's first Workspace and, ticked, its first
 * Site, created as the New Workspace and New Site dialogs create them, together with finishing
 * setup (all of it or nothing). The admin then opens the new Site, or the Workspace. It can be
 * skipped: setup is finished and the admin opens the dashboard.
 */
export function FirstClientStep({ onBack }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const [workspaceName, setWorkspaceName] = useState("");
	const [withSite, setWithSite] = useState(true);
	const [siteName, setSiteName] = useState("");
	const [siteSlug, setSiteSlug] = useState("");
	const [slugEdited, setSlugEdited] = useState(false);
	const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({});
	const [busy, setBusy] = useState(false);

	const refuse = (field: Exclude<FieldName, "form">, message: MessageKey) => {
		setErrors({ [field]: message });
		document.getElementById(FIELD_IDS[field])?.focus();
	};

	const finish = async (workspace?: { name: string; site?: { name: string; slug: string } }) => {
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			const finished = await api.setup.finish(workspace ? { workspace } : {});
			if (finished.site) await router.navigate({ to: "/sites/$siteId", params: { siteId: finished.site.id } });
			else if (finished.workspace) {
				await router.navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: finished.workspace.id } });
			} else await router.navigate({ to: "/" });
		} catch (failure) {
			const code = errorCode(failure);
			const message = errorMessage(failure);
			if (code === "SLUG_TAKEN" || code === "SLUG_INVALID") refuse("siteSlug", message);
			else setErrors({ form: message });
			setBusy(false);
		}
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!workspaceName.trim()) return refuse("workspaceName", "workspaces.dialog.nameRequired");
		if (withSite && !siteName.trim()) return refuse("siteName", "sites.dialog.nameRequired");
		await finish({
			name: workspaceName,
			...(withSite ? { site: { name: siteName, slug: siteSlug } } : {}),
		});
	};

	const describedBy = (field: Exclude<FieldName, "form">, help?: string) =>
		[help, errors[field] ? `${FIELD_IDS[field]}-error` : undefined].filter(Boolean).join(" ") || undefined;

	return (
		<form onSubmit={submit} className="flex flex-1 flex-col gap-8" noValidate>
			<StepHeader heading={t("setup.steps.firstClient.heading")}>
				<p>{t("setup.steps.firstClient.intro")}</p>
				<p>{t("setup.steps.firstClient.later")}</p>
			</StepHeader>
			<FieldGroup className="gap-5">
				<Field data-invalid={errors.workspaceName ? true : undefined}>
					<FieldLabel htmlFor={FIELD_IDS.workspaceName}>{t("setup.steps.firstClient.workspaceName")}</FieldLabel>
					<Input
						id={FIELD_IDS.workspaceName}
						value={workspaceName}
						maxLength={100}
						onChange={(event) => setWorkspaceName(event.target.value)}
						autoComplete="organization"
						aria-invalid={errors.workspaceName ? true : undefined}
						aria-describedby={describedBy("workspaceName", `${FIELD_IDS.workspaceName}-help`)}
					/>
					<FieldDescription id={`${FIELD_IDS.workspaceName}-help`}>
						{t("setup.steps.firstClient.workspaceNameHelp")}
					</FieldDescription>
					{errors.workspaceName ? (
						<FieldError id={`${FIELD_IDS.workspaceName}-error`}>{t(errors.workspaceName)}</FieldError>
					) : null}
				</Field>
				<div className="flex items-center gap-3">
					<Checkbox
						id="first-site-wanted"
						checked={withSite}
						onCheckedChange={(checked) => {
							setWithSite(checked === true);
							setErrors({});
						}}
					/>
					<label htmlFor="first-site-wanted" className="font-medium">
						{t("setup.steps.firstClient.alsoSite")}
					</label>
				</div>
				{withSite ? (
					<div className="grid gap-5 border-s-2 ps-4 md:grid-cols-2">
						<Field data-invalid={errors.siteName ? true : undefined}>
							<FieldLabel htmlFor={FIELD_IDS.siteName}>{t("setup.steps.firstClient.siteName")}</FieldLabel>
							<Input
								id={FIELD_IDS.siteName}
								value={siteName}
								maxLength={100}
								onChange={(event) => {
									setSiteName(event.target.value);
									if (!slugEdited) setSiteSlug(slugFrom(event.target.value));
								}}
								aria-invalid={errors.siteName ? true : undefined}
								aria-describedby={describedBy("siteName")}
							/>
							{errors.siteName ? (
								<FieldError id={`${FIELD_IDS.siteName}-error`}>{t(errors.siteName)}</FieldError>
							) : null}
						</Field>
						<Field data-invalid={errors.siteSlug ? true : undefined}>
							<FieldLabel htmlFor={FIELD_IDS.siteSlug}>{t("sites.dialog.slug")}</FieldLabel>
							<Input
								id={FIELD_IDS.siteSlug}
								value={siteSlug}
								maxLength={63}
								spellCheck={false}
								autoCapitalize="none"
								onChange={(event) => {
									setSiteSlug(event.target.value);
									setSlugEdited(true);
								}}
								aria-invalid={errors.siteSlug ? true : undefined}
								aria-describedby={describedBy("siteSlug", `${FIELD_IDS.siteSlug}-help`)}
							/>
							<FieldDescription id={`${FIELD_IDS.siteSlug}-help`}>{t("sites.dialog.slugHelp")}</FieldDescription>
							{errors.siteSlug ? (
								<FieldError id={`${FIELD_IDS.siteSlug}-error`}>{t(errors.siteSlug)}</FieldError>
							) : null}
						</Field>
					</div>
				) : null}
				{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
			</FieldGroup>
			<div className="mt-auto flex flex-wrap items-center justify-end gap-2">
				{onBack ? (
					<Button type="button" variant="ghost" className="me-auto" onClick={onBack}>
						<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
						{t("setup.back")}
					</Button>
				) : null}
				<Button type="button" variant="outline" onClick={() => finish()} disabled={busy}>
					{t("setup.steps.firstClient.skip")}
				</Button>
				<Button type="submit" disabled={busy}>
					{t("setup.steps.firstClient.finish")}
				</Button>
			</div>
		</form>
	);
}
