import { createFileRoute } from "@tanstack/react-router";
import { FieldError } from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import { describedBy, SettingsCard, SettingsRow, SettingsRows, Switch } from "../../ui/settings/layout.tsx";

export const Route = createFileRoute("/_admin/settings/security")({
	staticData: { crumb: "securitySettings.pageTitle", width: "form" },
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
	return (
		<>
			<PageHeader heading={t("securitySettings.heading")}>{t("securitySettings.intro")}</PageHeader>
			<SettingsForm>
				<div className="flex flex-col gap-6">
					<SignInCard saved={security} />
					<AuditLogCard saved={security.auditRetentionDays} />
				</div>
			</SettingsForm>
		</>
	);
}

/**
 * Sign-in rules: the leaked-password check and two-factor authentication for everyone. Each is its own
 * procedure and a Sensitive action; requiring two-factor authentication needs the Superadmin's own
 * second factor first.
 */
function SignInCard({ saved }: { saved: { leakedPasswordCheck: boolean; requireTwoFactor: boolean } }) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const { shell } = Route.useRouteContext();
	const ownOff = shell.twoFactor?.on !== true;
	const section = useSettingsSection({
		saved,
		save: async (values, before) => {
			const api = await getApi();
			// A Sensitive action: switching the check changes how every password is checked.
			if (values.leakedPasswordCheck !== before.leakedPasswordCheck) {
				await runSensitive(() => api.install.security.update({ leakedPasswordCheck: values.leakedPasswordCheck }));
			}
			if (values.requireTwoFactor !== before.requireTwoFactor) {
				await runSensitive(() => api.install.security.requireTwoFactor({ required: values.requireTwoFactor }));
			}
		},
	});
	return (
		<SettingsCard title={t("securitySettings.signInCard")} description={t("securitySettings.signInCardIntro")}>
			<SettingsRows>
				<SettingsRow
					label={t("securitySettings.leakedPasswordCheck")}
					help={t("securitySettings.leakedPasswordCheckHelp")}
					htmlFor="leaked-password-check"
				>
					<Switch
						id="leaked-password-check"
						checked={section.values.leakedPasswordCheck}
						onCheckedChange={(leakedPasswordCheck) => section.set({ leakedPasswordCheck })}
						aria-describedby={describedBy("leaked-password-check")}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("securitySettings.requireTwoFactor")}
					help={
						<>
							{t("securitySettings.requireTwoFactorHelp")}
							{ownOff && !saved.requireTwoFactor ? ` ${t("securitySettings.requireTwoFactorOwnFirst")}` : ""}
						</>
					}
					htmlFor="require-two-factor"
				>
					<Switch
						id="require-two-factor"
						checked={section.values.requireTwoFactor}
						onCheckedChange={(requireTwoFactor) => section.set({ requireTwoFactor })}
						aria-describedby={describedBy("require-two-factor")}
					/>
				</SettingsRow>
			</SettingsRows>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</SettingsCard>
	);
}

/** How long the Audit log keeps entries: a Sensitive action, since a shorter time removes entries for good. */
function AuditLogCard({ saved }: { saved: number }) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const section = useSettingsSection({
		saved: { days: saved },
		save: async ({ days }) => {
			const api = await getApi();
			await runSensitive(() => api.install.security.setAuditRetention({ days }));
		},
	});
	return (
		<SettingsCard title={t("securitySettings.auditCard")}>
			<SettingsRows>
				<SettingsRow
					label={t("securitySettings.auditRetention")}
					help={t("securitySettings.auditRetentionHelp")}
					htmlFor="audit-retention"
				>
					<NativeSelect
						id="audit-retention"
						value={String(section.values.days)}
						onChange={(event) => section.set({ days: Number(event.target.value) })}
						aria-describedby={describedBy("audit-retention")}
					>
						{retentionChoices(saved).map((days) => (
							<NativeSelectOption key={days} value={String(days)}>
								{days % 365 === 0
									? t("securitySettings.auditRetentionYears", { years: days / 365 })
									: t("securitySettings.auditRetentionDays", { days })}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</SettingsRow>
			</SettingsRows>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</SettingsCard>
	);
}

/** How long the Audit log may keep entries, from 90 days to 10 years, with the one saved among them. */
function retentionChoices(saved: number): number[] {
	const choices = [90, 180, 365, 730, 1095, 1825, 3650];
	return choices.includes(saved) ? choices : [...choices, saved].sort((a, b) => a - b);
}
