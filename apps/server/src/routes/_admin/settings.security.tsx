import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { FieldError, FieldGroup } from "@webcraft/ui/components/field.tsx";
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
		return { security: await api.install.security.get() };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "securitySettings.pageTitle") }],
	}),
	component: SecuritySettingsPage,
});

/** Install settings › Security: how the Install checks people's passwords, and whether everyone must use two-factor authentication. */
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
function SecuritySettingsForm({ saved }: { saved: { leakedPasswordCheck: boolean; requireTwoFactor: boolean } }) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const { shell } = Route.useRouteContext();
	const [leakedPasswordCheck, setLeakedPasswordCheck] = useState(saved.leakedPasswordCheck);
	const [requireTwoFactor, setRequireTwoFactor] = useState(saved.requireTwoFactor);
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
