import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/settings/security")({
	staticData: { crumb: "securitySettings.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return { security: null };
		const api = await getApi();
		const [security, retention] = await Promise.all([
			api.install.security.get(),
			api.install.security.auditRetention(),
		]);
		return { security: { ...security, auditRetentionDays: retention.days } };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "securitySettings.pageTitle") }],
	}),
	component: SecuritySettingsPage,
});

/**
 * Install settings › Security: how the Install checks people's passwords, whether everyone must use
 * two-factor authentication, and how long the Audit log keeps entries.
 */
function SecuritySettingsPage() {
	const t = useT();
	const { security } = Route.useLoaderData();
	if (!security) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <SecuritySettingsForm saved={security} />;
}

/**
 * One form, one Save: each setting that changed goes to its own procedure, each a Sensitive action.
 * Requiring two-factor authentication needs the Superadmin's own second factor first.
 */
function SecuritySettingsForm({
	saved,
}: {
	saved: { leakedPasswordCheck: boolean; requireTwoFactor: boolean; auditRetentionDays: number };
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const { shell } = Route.useRouteContext();
	const [leakedPasswordCheck, setLeakedPasswordCheck] = useState(saved.leakedPasswordCheck);
	const [requireTwoFactor, setRequireTwoFactor] = useState(saved.requireTwoFactor);
	const [auditRetentionDays, setAuditRetentionDays] = useState(saved.auditRetentionDays);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const ownOff = shell.twoFactor?.on !== true;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			// A Sensitive action: switching the check changes how every password is checked.
			if (leakedPasswordCheck !== saved.leakedPasswordCheck) {
				await runSensitive(() => api.install.security.update({ leakedPasswordCheck }));
			}
			if (requireTwoFactor !== saved.requireTwoFactor) {
				await runSensitive(() => api.install.security.requireTwoFactor({ required: requireTwoFactor }));
			}
			// A Sensitive action: a shorter time removes entries for good.
			if (auditRetentionDays !== saved.auditRetentionDays) {
				await runSensitive(() => api.install.security.setAuditRetention({ days: auditRetentionDays }));
			}
			toast.success(t("securitySettings.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeader heading={t("securitySettings.heading")}>{t("securitySettings.intro")}</PageHeader>
			<form onSubmit={submit} className="max-w-xl" noValidate>
				<FieldGroup className="gap-6">
					<label className="flex items-start gap-3 text-sm">
						<input
							type="checkbox"
							checked={leakedPasswordCheck}
							onChange={(event) => setLeakedPasswordCheck(event.target.checked)}
							aria-describedby="leaked-password-check-help"
							className="accent-primary mt-0.5 size-4 shrink-0"
						/>
						<span className="flex flex-col gap-1">
							<span className="font-medium">{t("securitySettings.leakedPasswordCheck")}</span>
							<span id="leaked-password-check-help" className="text-muted-foreground">
								{t("securitySettings.leakedPasswordCheckHelp")}
							</span>
						</span>
					</label>
					<label className="flex items-start gap-3 text-sm">
						<input
							type="checkbox"
							checked={requireTwoFactor}
							onChange={(event) => setRequireTwoFactor(event.target.checked)}
							aria-describedby="require-two-factor-help"
							className="accent-primary mt-0.5 size-4 shrink-0"
						/>
						<span className="flex flex-col gap-1">
							<span className="font-medium">{t("securitySettings.requireTwoFactor")}</span>
							<span id="require-two-factor-help" className="text-muted-foreground">
								{t("securitySettings.requireTwoFactorHelp")}
								{ownOff && !saved.requireTwoFactor ? ` ${t("securitySettings.requireTwoFactorOwnFirst")}` : ""}
							</span>
						</span>
					</label>
					<Field className="max-w-xs">
						<FieldLabel htmlFor="audit-retention">{t("securitySettings.auditRetention")}</FieldLabel>
						<NativeSelect
							id="audit-retention"
							value={String(auditRetentionDays)}
							onChange={(event) => setAuditRetentionDays(Number(event.target.value))}
							aria-describedby="audit-retention-help"
						>
							{retentionChoices(saved.auditRetentionDays).map((days) => (
								<NativeSelectOption key={days} value={String(days)}>
									{days % 365 === 0
										? t("securitySettings.auditRetentionYears", { years: days / 365 })
										: t("securitySettings.auditRetentionDays", { days })}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<FieldDescription id="audit-retention-help">{t("securitySettings.auditRetentionHelp")}</FieldDescription>
					</Field>
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<div>
						<Button type="submit" disabled={busy}>
							{t("securitySettings.save")}
						</Button>
					</div>
				</FieldGroup>
			</form>
		</>
	);
}

/** How long the Audit log may keep entries, from 90 days to 10 years, with the one saved among them. */
function retentionChoices(saved: number): number[] {
	const choices = [90, 180, 365, 730, 1095, 1825, 3650];
	return choices.includes(saved) ? choices : [...choices, saved].sort((a, b) => a - b);
}
