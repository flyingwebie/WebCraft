import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { ADMIN_LANGUAGES, type AdminLanguageCode, isAdminLanguage } from "@webcraft/core/admin-languages";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { PasswordInput } from "../../ui/PasswordInput.tsx";
import { roleLabel, type SignedInPerson } from "../../ui/shell/context.ts";
import { TwoFactorCard } from "../../ui/two-factor/TwoFactorCard.tsx";

export const Route = createFileRoute("/_admin/account/")({
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
				<PasswordCard />
				<TwoFactorCard state={twoFactor} account={person.email} />
				<SessionsCard />
				<Card id="api-tokens" tabIndex={-1} className="outline-none">
					<CardHeader>
						<CardTitle>
							<h2>{t("account.apiTokens.heading")}</h2>
						</CardTitle>
						<CardDescription>{t("account.apiTokens.cardIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<Link to="/account/api-tokens" className={buttonVariants({ variant: "outline" })}>
							{t("account.apiTokens.manage")}
						</Link>
					</CardContent>
				</Card>
				<Card id="ai-clients" tabIndex={-1} className="outline-none">
					<CardHeader>
						<CardTitle>
							<h2>{t("account.aiClients.heading")}</h2>
						</CardTitle>
						<CardDescription>{t("account.aiClients.cardIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<Link to="/account/ai-clients" className={buttonVariants({ variant: "outline" })}>
							{t("account.aiClients.manage")}
						</Link>
					</CardContent>
				</Card>
				<EmailsCard />
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
			await runSensitive(() => api.me.changePassword({ newPassword: password }));
			setPassword("");
			setRepeat("");
			toast.success(t("account.password.saved"));
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
		<Card id="password" tabIndex={-1} className="outline-none">
			<CardHeader>
				<CardTitle>
					<h2>{t("account.password.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("account.password.intro")}</CardDescription>
			</CardHeader>
			<CardContent>
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
							<Button type="submit" disabled={busy}>
								{t("account.password.save")}
							</Button>
						</div>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}

type SessionRow = Awaited<ReturnType<ApiClient["me"]["sessions"]["list"]>>["sessions"][number];

/** The browsers signed in to the account, with a way to sign each out, or every other one. */
function SessionsCard() {
	const t = useT();
	const router = useRouter();
	const { sessions } = Route.useLoaderData();
	const [busy, setBusy] = useState(false);
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
		<Card id="sessions" tabIndex={-1} className="outline-none">
			<CardHeader>
				<CardTitle>
					<h2>{t("account.sessions.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("account.sessions.intro")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t("account.sessions.browser")}</TableHead>
							<TableHead>{t("account.sessions.network")}</TableHead>
							<TableHead>{t("account.sessions.lastUsed")}</TableHead>
							<TableHead>
								<span className="sr-only">{t("account.sessions.actions")}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sessions.map((session) => (
							<TableRow key={session.id}>
								<TableCell>
									<span className="flex flex-wrap items-center gap-2">
										{device(session)}
										{session.current ? <Badge variant="outline">{t("account.sessions.current")}</Badge> : null}
									</span>
								</TableCell>
								<TableCell className="font-mono text-xs">
									{session.network ?? t("account.sessions.networkUnknown")}
								</TableCell>
								<TableCell>{formatUtc(session.lastUsedAt)}</TableCell>
								<TableCell className="text-end">
									{session.current ? null : (
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => revoke(session)}
											aria-label={t("account.sessions.signOutLabel", {
												device: device(session),
												lastUsed: formatUtc(session.lastUsedAt),
											})}
										>
											{t("account.sessions.signOut")}
										</Button>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
				{others.length > 0 ? (
					<div>
						<Button variant="outline" disabled={busy} onClick={revokeOthers}>
							{t("account.sessions.signOutOthers")}
						</Button>
					</div>
				) : null}
			</CardContent>
		</Card>
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
	const router = useRouter();
	const { emails } = Route.useLoaderData();
	const [off, setOff] = useState<Set<EmailSwitch["type"]>>(
		() => new Set(emails.filter((email) => !email.on).map((email) => email.type)),
	);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const toggle = (type: EmailSwitch["type"], on: boolean) => {
		setOff((current) => {
			const next = new Set(current);
			if (on) next.delete(type);
			else next.add(type);
			return next;
		});
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.me.emails.update({ turnedOff: [...off] });
			toast.success(t("account.emails.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card id="emails" tabIndex={-1} className="outline-none">
			<CardHeader>
				<CardTitle>
					<h2>{t("account.emails.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("account.emails.intro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} noValidate>
					<FieldGroup className="gap-6">
						{EMAIL_GROUPS.map((group) => (
							<FieldSet key={group.category}>
								<FieldLegend variant="label">{t(group.legend)}</FieldLegend>
								<div className="flex flex-col gap-3">
									{emails
										.filter((email) => email.category === group.category)
										.map((email) => (
											<label key={email.type} className="flex items-start gap-3 text-sm">
												<input
													type="checkbox"
													checked={!off.has(email.type)}
													onChange={(event) => toggle(email.type, event.target.checked)}
													aria-describedby={`email-${email.type}-description`}
													className="accent-primary mt-0.5 size-4 shrink-0"
												/>
												<span className="flex flex-col gap-0.5">
													<span className="font-medium">{t(`emailTypes.${email.type}.name` as MessageKey)}</span>
													<span id={`email-${email.type}-description`} className="text-muted-foreground">
														{t(`emailTypes.${email.type}.description` as MessageKey)}
													</span>
												</span>
											</label>
										))}
								</div>
							</FieldSet>
						))}
						<p className="text-muted-foreground text-sm">{t("account.emails.security")}</p>
						{error ? <FieldError>{t(error)}</FieldError> : null}
						<div>
							<Button type="submit" disabled={busy}>
								{t("account.emails.save")}
							</Button>
						</div>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
