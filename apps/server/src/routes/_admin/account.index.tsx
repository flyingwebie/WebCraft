import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { ADMIN_LANGUAGES, type AdminLanguageCode, isAdminLanguage } from "@webcraft/core/admin-languages";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
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
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { PasswordInput } from "../../ui/PasswordInput.tsx";
import { ConfirmDialog } from "../../ui/settings/confirm.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import {
	describedBy,
	SettingsCard,
	SettingsListRow,
	SettingsRow,
	SettingsRows,
	StateBadge,
	Switch,
} from "../../ui/settings/layout.tsx";
import { roleLabel, type SignedInPerson } from "../../ui/shell/context.ts";
import { TwoFactorCard } from "../../ui/two-factor/TwoFactorCard.tsx";

export const Route = createFileRoute("/_admin/account/")({
	staticData: { width: "form" },
	loader: async () => {
		const api = await getApi();
		const [{ emails }, { sessions }, twoFactor] = await Promise.all([
			api.me.emails.get(),
			api.me.sessions.list(),
			api.me.twoFactor.get(),
		]);
		return { emails, sessions, twoFactor };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "account.pageTitle") }] }),
	component: AccountPage,
});

type Theme = SignedInPerson["adminTheme"];

const THEMES: { value: Theme; label: MessageKey }[] = [
	{ value: "system", label: "account.preferences.themeSystem" },
	{ value: "light", label: "account.preferences.themeLight" },
	{ value: "dark", label: "account.preferences.themeDark" },
];

/**
 * Your account: who you are, your Admin language and theme, your password, the browsers signed in
 * to your account, your emails, two-factor authentication, and a way to your API tokens.
 */
function AccountPage() {
	const t = useT();
	const { person, shell } = Route.useRouteContext();
	const { twoFactor } = Route.useLoaderData();
	const role = t(roleLabel(person.installRole));
	return (
		<>
			<PageHeader heading={t("account.heading")}>
				{shell.impersonation ? t("impersonation.accountNotice", { name: person.name }) : null}
			</PageHeader>
			<SettingsForm>
				<div className="grid gap-6">
					<SettingsCard title={t("account.profile.heading")}>
						<dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
							<dt className="text-muted-foreground">{t("account.profile.name")}</dt>
							<dd>{person.name}</dd>
							<dt className="text-muted-foreground">{t("account.profile.email")}</dt>
							<dd>{person.email}</dd>
							<dt className="text-muted-foreground">{t("account.profile.role")}</dt>
							<dd>{role}</dd>
						</dl>
					</SettingsCard>
					<PreferencesCard person={person} />
					<PasswordCard />
					<TwoFactorCard state={twoFactor} account={person.email} />
					<SessionsCard />
					<SettingsCard
						id="api-tokens"
						tabIndex={-1}
						className="outline-none"
						title={t("account.apiTokens.heading")}
						description={t("account.apiTokens.cardIntro")}
						action={
							<Link to="/account/api-tokens" className={buttonVariants({ variant: "outline" })}>
								{t("account.apiTokens.manage")}
							</Link>
						}
					/>
					<SettingsCard
						id="ai-clients"
						tabIndex={-1}
						className="outline-none"
						title={t("account.aiClients.heading")}
						description={t("account.aiClients.cardIntro")}
						action={
							<Link to="/account/ai-clients" className={buttonVariants({ variant: "outline" })}>
								{t("account.aiClients.manage")}
							</Link>
						}
					/>
					<EmailsCard />
				</div>
			</SettingsForm>
		</>
	);
}

/** The person's Admin language and theme, saved with the foot bar. */
function PreferencesCard({ person }: { person: SignedInPerson }) {
	const t = useT();
	const { shell } = Route.useRouteContext();
	const installDefault = ADMIN_LANGUAGES.find((option) => option.code === shell.install.defaultAdminLanguage)?.name;
	const section = useSettingsSection({
		saved: { language: (person.adminLanguage ?? "") as AdminLanguageCode | "", theme: person.adminTheme },
		save: async ({ language, theme }) =>
			(await getApi()).me.updatePreferences({ adminLanguage: language === "" ? null : language, adminTheme: theme }),
	});
	const { language, theme } = section.values;
	return (
		<SettingsCard title={t("account.preferences.heading")}>
			<form {...section.formProps}>
				<SettingsRows>
					<SettingsRow
						label={t("account.preferences.language")}
						help={t("account.preferences.languageHelp")}
						htmlFor="account-admin-language"
					>
						<NativeSelect
							id="account-admin-language"
							value={language}
							onChange={(event) => {
								const value = event.target.value;
								section.set({ language: isAdminLanguage(value) ? value : "" });
							}}
							aria-describedby={describedBy("account-admin-language")}
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
					</SettingsRow>
					<div className="pt-4">
						<FieldSet>
							<FieldLegend variant="label">{t("account.preferences.theme")}</FieldLegend>
							<div className="flex flex-wrap gap-x-5 gap-y-2">
								{THEMES.map((option) => (
									<label key={option.value} className="flex items-center gap-2 text-sm">
										<input
											type="radio"
											name="admin-theme"
											value={option.value}
											checked={theme === option.value}
											onChange={() => section.set({ theme: option.value })}
											className="accent-primary size-4"
										/>
										{t(option.label)}
									</label>
								))}
							</div>
						</FieldSet>
					</div>
				</SettingsRows>
				{section.error ? <FieldError className="mt-3">{t(section.error)}</FieldError> : null}
			</form>
		</SettingsCard>
	);
}

/** Changing the password: a Sensitive action, which signs out every other session. */
function PasswordCard() {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [password, setPassword] = useState("");
	const [repeat, setRepeat] = useState("");
	const [error, setError] = useState<{ field: "password" | "repeat"; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (password !== repeat) {
			setError({ field: "repeat", message: "account.password.mismatch" });
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const changed = await runSensitive(() => api.me.changePassword({ newPassword: password }));
			setPassword("");
			setRepeat("");
			toast.success(t("account.password.saved"));
			// Other browsers are signed out; tokens and AI clients made with the account are not.
			if (changed.activeApiTokens + changed.activeAiClients > 0) {
				toast.warning(
					t("account.password.stillActive", { tokens: changed.activeApiTokens, clients: changed.activeAiClients }),
					{ duration: 20_000 },
				);
			}
			await router.invalidate();
		} catch (failure) {
			setError({ field: "password", message: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	const invalid = (field: "password" | "repeat") => (error?.field === field ? true : undefined);
	const describedBy = (field: "password" | "repeat", help?: string) =>
		[help, error?.field === field ? `account-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;

	return (
		<SettingsCard
			id="password"
			tabIndex={-1}
			className="outline-none"
			title={t("account.password.heading")}
			description={t("account.password.intro")}
		>
			<form onSubmit={submit} noValidate>
				<FieldGroup className="gap-6">
					<Field data-invalid={invalid("password")}>
						<FieldLabel htmlFor="account-password">{t("account.password.newPassword")}</FieldLabel>
						<PasswordInput
							id="account-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="new-password"
							required
							aria-invalid={invalid("password")}
							aria-describedby={describedBy("password", "account-password-help")}
						/>
						<FieldDescription id="account-password-help">{t("account.password.newPasswordHelp")}</FieldDescription>
						{error?.field === "password" ? (
							<FieldError id="account-password-error">{t(error.message)}</FieldError>
						) : null}
					</Field>
					<Field data-invalid={invalid("repeat")}>
						<FieldLabel htmlFor="account-repeat">{t("account.password.repeat")}</FieldLabel>
						<PasswordInput
							id="account-repeat"
							value={repeat}
							onChange={(event) => setRepeat(event.target.value)}
							autoComplete="new-password"
							required
							aria-invalid={invalid("repeat")}
							aria-describedby={describedBy("repeat")}
						/>
						{error?.field === "repeat" ? <FieldError id="account-repeat-error">{t(error.message)}</FieldError> : null}
					</Field>
					<div>
						<Button type="submit" variant="outline" disabled={busy}>
							{t("account.password.save")}
						</Button>
					</div>
				</FieldGroup>
			</form>
		</SettingsCard>
	);
}

type SessionRow = Awaited<ReturnType<ApiClient["me"]["sessions"]["list"]>>["sessions"][number];

/** The browsers signed in to the account, with a way to sign each out, or every other one. */
function SessionsCard() {
	const t = useT();
	const router = useRouter();
	const { sessions } = Route.useLoaderData();
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState<SessionRow | "others" | null>(null);
	const others = sessions.filter((session) => !session.current);

	const device = (session: SessionRow) =>
		session.browser && session.os
			? t("account.sessions.deviceBoth", { browser: session.browser, os: session.os })
			: session.browser
				? session.browser
				: session.os
					? t("account.sessions.deviceOs", { os: session.os })
					: t("account.sessions.deviceUnknown");

	const act = async (work: () => Promise<string>) => {
		setBusy(true);
		try {
			toast.success(await work());
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	const revoke = (session: SessionRow) =>
		act(async () => {
			await (await getApi()).me.sessions.revoke({ sessionId: session.id });
			return t("account.sessions.signedOut");
		});

	const revokeOthers = () =>
		act(async () => {
			const { revoked } = await (await getApi()).me.sessions.revokeOthers();
			return t("account.sessions.signedOutOthers", { count: revoked });
		});

	return (
		<SettingsCard
			id="sessions"
			tabIndex={-1}
			className="outline-none"
			title={t("account.sessions.heading")}
			description={t("account.sessions.intro")}
			action={
				others.length > 0 ? (
					<Button variant="outline" disabled={busy} onClick={() => setConfirming("others")}>
						{t("account.sessions.signOutOthers")}
					</Button>
				) : null
			}
		>
			<SettingsRows>
				{sessions.map((session) => (
					<SettingsListRow
						key={session.id}
						badge={session.current ? <StateBadge tone="success">{t("account.sessions.current")}</StateBadge> : null}
						detail={
							<>
								<span className="font-mono">{session.network ?? t("account.sessions.networkUnknown")}</span>
								{" · "}
								{t("account.sessions.lastUsed")}: {formatUtc(session.lastUsedAt)}
							</>
						}
						actions={
							session.current ? null : (
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => setConfirming(session)}
									aria-label={t("account.sessions.signOutLabel", {
										device: device(session),
										lastUsed: formatUtc(session.lastUsedAt),
									})}
								>
									{t("account.sessions.signOut")}
								</Button>
							)
						}
					>
						<span>{device(session)}</span>
					</SettingsListRow>
				))}
			</SettingsRows>
			<ConfirmDialog
				open={confirming !== null}
				onOpenChange={(open) => !open && setConfirming(null)}
				title={
					confirming === "others"
						? t("account.sessions.signOutOthersTitle", { count: others.length })
						: t("account.sessions.signOutTitle", { device: confirming ? device(confirming) : "" })
				}
				confirm={confirming === "others" ? t("account.sessions.signOutOthers") : t("account.sessions.signOut")}
				onConfirm={() => (confirming === "others" ? revokeOthers() : confirming ? revoke(confirming) : undefined)}
			>
				{t("account.sessions.signOutBody")}
			</ConfirmDialog>
		</SettingsCard>
	);
}

type EmailSwitch = Awaited<ReturnType<ApiClient["me"]["emails"]["get"]>>["emails"][number];

const EMAIL_GROUPS: { category: "work" | "alert"; legend: MessageKey }[] = [
	{ category: "work", legend: "account.emails.work" },
	{ category: "alert", legend: "account.emails.alerts" },
];

/** Which work and alert emails the person gets. Security emails always go, so they have no switch. */
function EmailsCard() {
	const t = useT();
	const { emails } = Route.useLoaderData();
	const section = useSettingsSection({
		saved: {
			turnedOff: emails
				.filter((email) => !email.on)
				.map((email) => email.type)
				.sort(),
		},
		save: async ({ turnedOff }) => (await getApi()).me.emails.update({ turnedOff }),
	});
	const off = section.values.turnedOff;
	const toggle = (type: EmailSwitch["type"], on: boolean) =>
		section.set({ turnedOff: on ? off.filter((each) => each !== type) : [...new Set([...off, type])].sort() });

	return (
		<SettingsCard
			id="emails"
			tabIndex={-1}
			className="outline-none"
			title={t("account.emails.heading")}
			description={t("account.emails.intro")}
		>
			<form {...section.formProps} className="grid gap-6">
				{EMAIL_GROUPS.map((group) => (
					<FieldSet key={group.category}>
						<FieldLegend variant="label">{t(group.legend)}</FieldLegend>
						<SettingsRows>
							{emails
								.filter((email) => email.category === group.category)
								.map((email) => (
									<SettingsRow
										key={email.type}
										label={t(`emailTypes.${email.type}.name` as MessageKey)}
										help={t(`emailTypes.${email.type}.description` as MessageKey)}
										htmlFor={`email-${email.type}`}
									>
										<Switch
											id={`email-${email.type}`}
											checked={!off.includes(email.type)}
											onCheckedChange={(on) => toggle(email.type, on)}
											aria-describedby={describedBy(`email-${email.type}`)}
										/>
									</SettingsRow>
								))}
						</SettingsRows>
					</FieldSet>
				))}
				<p className="text-muted-foreground text-sm">{t("account.emails.security")}</p>
				{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
			</form>
		</SettingsCard>
	);
}
