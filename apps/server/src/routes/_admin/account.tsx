import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ADMIN_LANGUAGES, type AdminLanguageCode, isAdminLanguage } from "@webcraft/core/admin-languages";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { roleLabel, type SignedInPerson } from "../../ui/shell/context.ts";

export const Route = createFileRoute("/_admin/account")({
	staticData: { crumb: "account.pageTitle" },
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "account.pageTitle") }] }),
	component: AccountPage,
});

type Theme = SignedInPerson["adminTheme"];

const THEMES: { value: Theme; label: MessageKey }[] = [
	{ value: "system", label: "account.preferences.themeSystem" },
	{ value: "light", label: "account.preferences.themeLight" },
	{ value: "dark", label: "account.preferences.themeDark" },
];

/** Your account: who you are, your Admin language and theme, and two-factor authentication. */
function AccountPage() {
	const t = useT();
	const { person } = Route.useRouteContext();
	const role = t(roleLabel(person.installRole));
	return (
		<>
			<PageHeader heading={t("account.heading")} />
			<div className="grid max-w-2xl gap-6">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("account.profile.heading")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
							<dt className="text-muted-foreground">{t("account.profile.name")}</dt>
							<dd>{person.name}</dd>
							<dt className="text-muted-foreground">{t("account.profile.email")}</dt>
							<dd>{person.email}</dd>
							<dt className="text-muted-foreground">{t("account.profile.role")}</dt>
							<dd>{role}</dd>
						</dl>
					</CardContent>
				</Card>
				<PreferencesCard person={person} />
				<Card id="two-factor" tabIndex={-1} className="outline-none">
					<CardHeader>
						<CardTitle className="flex items-center gap-3">
							<h2>{t("account.twoFactor.heading")}</h2>
							<Badge variant="outline">{t("account.twoFactor.status")}</Badge>
						</CardTitle>
						<CardDescription>{t("account.twoFactor.body")}</CardDescription>
					</CardHeader>
				</Card>
			</div>
		</>
	);
}

function PreferencesCard({ person }: { person: SignedInPerson }) {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const [language, setLanguage] = useState<AdminLanguageCode | "">(person.adminLanguage ?? "");
	const [theme, setTheme] = useState<Theme>(person.adminTheme);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const installDefault = ADMIN_LANGUAGES.find((option) => option.code === shell.install.defaultAdminLanguage)?.name;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.me.updatePreferences({ adminLanguage: language === "" ? null : language, adminTheme: theme });
			toast.success(t("account.preferences.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("account.preferences.heading")}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} noValidate>
					<FieldGroup className="gap-6">
						<Field>
							<FieldLabel htmlFor="account-admin-language">{t("account.preferences.language")}</FieldLabel>
							<NativeSelect
								id="account-admin-language"
								value={language}
								onChange={(event) => {
									const value = event.target.value;
									setLanguage(isAdminLanguage(value) ? value : "");
								}}
								aria-describedby="account-admin-language-help"
							>
								<NativeSelectOption value="">
									{t("account.preferences.installDefault", { language: installDefault ?? "" })}
								</NativeSelectOption>
								{ADMIN_LANGUAGES.map((option) => (
									<NativeSelectOption key={option.code} value={option.code} lang={option.code}>
										{option.name}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<FieldDescription id="account-admin-language-help">
								{t("account.preferences.languageHelp")}
							</FieldDescription>
						</Field>
						<FieldSet>
							<FieldLegend variant="label">{t("account.preferences.theme")}</FieldLegend>
							<div className="flex flex-col gap-2">
								{THEMES.map((option) => (
									<label key={option.value} className="flex items-center gap-2 text-sm">
										<input
											type="radio"
											name="admin-theme"
											value={option.value}
											checked={theme === option.value}
											onChange={() => setTheme(option.value)}
											className="accent-primary size-4"
										/>
										{t(option.label)}
									</label>
								))}
							</div>
						</FieldSet>
						{error ? <FieldError>{t(error)}</FieldError> : null}
						<div>
							<Button type="submit" disabled={busy}>
								{t("account.preferences.save")}
							</Button>
						</div>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
