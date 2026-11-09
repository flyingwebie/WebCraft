import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { SendIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { EMAIL, PasswordField, SECURITY_OPTIONS, Section, type Security, TestResult } from "./smtp-parts.tsx";

/** A Site's email settings as the API shows them. */
export type SiteSmtpView = Awaited<ReturnType<ApiClient["siteSmtp"]["get"]>>;

type FieldName = "fromName" | "host" | "port" | "fromAddress" | "replyTo" | "testTo" | "form";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what a sender name can't hold.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Site › Email (SMTP): which server sends the Site's mail (the Install SMTP, under the Site's name,
 * or the Site's own), the server's details, the sender, and a test email sent with what is in the
 * form before it is saved. Saving is a Sensitive action. The password is never shown: only whether
 * one is set, with its last 4 characters, and a way to replace it.
 */
export function SiteSmtpForm({
	siteId,
	view,
	testTo: initialTestTo,
	onSaved,
}: {
	siteId: string;
	view: SiteSmtpView;
	testTo: string;
	onSaved(view: SiteSmtpView): void | Promise<void>;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const { settings, siteName } = view;
	const server = settings.server;
	const [own, setOwn] = useState(server !== null);
	const [host, setHost] = useState(server?.host ?? "");
	const [port, setPort] = useState(String(server?.port ?? 587));
	const [security, setSecurity] = useState<Security>(server?.security ?? "starttls");
	const [username, setUsername] = useState(server?.username ?? "");
	const [password, setPassword] = useState("");
	const storedPassword = server?.password.set ? server.password : null;
	const [replacing, setReplacing] = useState(!storedPassword);
	const [fromName, setFromName] = useState(settings.fromName ?? "");
	const [fromAddress, setFromAddress] = useState(server?.fromAddress ?? "");
	const [replyTo, setReplyTo] = useState(settings.replyTo ?? "");
	const [testTo, setTestTo] = useState(initialTestTo);
	const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({});
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ status: "sent" | "failed"; response: string; to: string } | null>(
		null,
	);
	const replaceButton = useRef<HTMLButtonElement>(null);
	const [focusAfterChange, setFocusAfterChange] = useState<"password" | "replace" | null>(null);

	useEffect(() => {
		if (focusAfterChange === "password") document.getElementById("site-smtp-password")?.focus();
		if (focusAfterChange === "replace") replaceButton.current?.focus();
		if (focusAfterChange) setFocusAfterChange(null);
	}, [focusAfterChange]);

	const typedPassword = replacing && password !== "" ? password : undefined;

	/** What is in the form, or null after marking what's wrong and focusing the first such field. */
	const formSettings = (extra: Partial<Record<FieldName, MessageKey>> = {}) => {
		const found: Partial<Record<FieldName, MessageKey>> = {};
		const portNumber = Number(port);
		if (CONTROL.test(fromName) || fromName.trim().length > 100) found.fromName = "siteEmail.errors.fromNameInvalid";
		if (own) {
			if (host.trim() === "") found.host = "emailSettings.errors.hostRequired";
			if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
				found.port = "emailSettings.errors.portInvalid";
			}
			if (!EMAIL.test(fromAddress.trim())) found.fromAddress = "emailSettings.errors.emailInvalid";
		}
		if (replyTo.trim() !== "" && !EMAIL.test(replyTo.trim())) found.replyTo = "emailSettings.errors.emailInvalid";
		Object.assign(found, extra);
		setErrors(found);
		const first = (["fromName", "host", "port", "fromAddress", "replyTo", "testTo"] as const).find(
			(field) => found[field],
		);
		if (first) {
			document.getElementById(`site-smtp-${first}`)?.focus();
			return null;
		}
		return {
			fromName: fromName.trim() || null,
			replyTo: replyTo.trim() || null,
			server: own
				? {
						host: host.trim(),
						port: portNumber,
						security,
						username: username.trim() || null,
						fromAddress: fromAddress.trim(),
					}
				: null,
		};
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		const values = formSettings();
		if (!values) return;
		setBusy(true);
		try {
			const api = await getApi();
			// A Sensitive action: it changes a secret, so it may ask the person to confirm it's them.
			const saved = await runSensitive(() =>
				api.siteSmtp.update({
					siteId,
					...values,
					server: values.server ? { ...values.server, password: values.server.username ? typedPassword : null } : null,
				}),
			);
			setPassword("");
			setReplacing(!(saved.settings.server?.password.set ?? false));
			await onSaved(saved);
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	const sendTest = async () => {
		const values = formSettings(EMAIL.test(testTo.trim()) ? {} : { testTo: "emailSettings.errors.emailInvalid" });
		if (!values) return;
		setTesting(true);
		setTestResult(null);
		try {
			const api = await getApi();
			const result = await api.siteSmtp.sendTest({
				siteId,
				to: testTo.trim(),
				...values,
				server: values.server ? { ...values.server, password: typedPassword } : null,
			});
			setTestResult({ ...result, to: testTo.trim() });
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setTesting(false);
		}
	};

	const describedBy = (field: FieldName, help?: string) =>
		[help, errors[field] ? `site-smtp-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;
	const invalid = (field: FieldName) => (errors[field] ? true : undefined);
	const error = (field: FieldName) =>
		errors[field] ? <FieldError id={`site-smtp-${field}-error`}>{t(errors[field])}</FieldError> : null;

	return (
		<form onSubmit={save} className="flex flex-col gap-6" noValidate>
			<Section heading={t("siteEmail.server.heading")} intro={t("siteEmail.server.intro")}>
				<fieldset className="grid gap-3">
					<legend className="sr-only">{t("siteEmail.server.heading")}</legend>
					<RadioGroup
						value={own ? "site" : "install"}
						onValueChange={(value) => setOwn(value === "site")}
						className="grid gap-4 md:grid-cols-2"
					>
						{(["install", "site"] as const).map((mode) => (
							<Field key={mode} orientation="horizontal" className="rounded-lg border p-4">
								<RadioGroupItem
									value={mode}
									id={`site-smtp-mode-${mode}`}
									aria-describedby={`site-smtp-mode-${mode}-help`}
								/>
								<div className="grid gap-1">
									<FieldLabel htmlFor={`site-smtp-mode-${mode}`}>
										{mode === "install" ? t("siteEmail.server.install") : t("siteEmail.server.own")}
									</FieldLabel>
									<FieldDescription id={`site-smtp-mode-${mode}-help`}>
										{mode === "install"
											? t("siteEmail.server.installHelp", { name: siteName })
											: t("siteEmail.server.ownHelp")}
									</FieldDescription>
								</div>
							</Field>
						))}
					</RadioGroup>
				</fieldset>
			</Section>

			{own ? (
				<Section heading={t("emailSettings.server.heading")}>
					<FieldGroup className="gap-5">
						<div className="grid gap-5 md:grid-cols-[1fr_8rem_12rem]">
							<Field data-invalid={invalid("host")}>
								<FieldLabel htmlFor="site-smtp-host">{t("emailSettings.server.host")}</FieldLabel>
								<Input
									id="site-smtp-host"
									value={host}
									onChange={(event) => setHost(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									required
									aria-invalid={invalid("host")}
									aria-describedby={describedBy("host")}
								/>
								{error("host")}
							</Field>
							<Field data-invalid={invalid("port")}>
								<FieldLabel htmlFor="site-smtp-port">{t("emailSettings.server.port")}</FieldLabel>
								<Input
									id="site-smtp-port"
									type="number"
									inputMode="numeric"
									min={1}
									max={65_535}
									value={port}
									onChange={(event) => setPort(event.target.value)}
									required
									aria-invalid={invalid("port")}
									aria-describedby={describedBy("port")}
								/>
								{error("port")}
							</Field>
							<Field>
								<FieldLabel htmlFor="site-smtp-security">{t("emailSettings.server.security")}</FieldLabel>
								<NativeSelect
									id="site-smtp-security"
									value={security}
									onChange={(event) => {
										const next = SECURITY_OPTIONS.find((option) => option.value === event.target.value);
										if (!next) return;
										if (SECURITY_OPTIONS.some((option) => String(option.port) === port)) setPort(String(next.port));
										setSecurity(next.value);
									}}
								>
									{SECURITY_OPTIONS.map((option) => (
										<NativeSelectOption key={option.value} value={option.value}>
											{t(option.label)}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</Field>
						</div>
						<div className="grid gap-5 md:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="site-smtp-username">{t("emailSettings.server.username")}</FieldLabel>
								<Input
									id="site-smtp-username"
									value={username}
									onChange={(event) => setUsername(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									aria-describedby="site-smtp-username-help"
								/>
								<FieldDescription id="site-smtp-username-help">
									{t("emailSettings.server.usernameHelp")}
								</FieldDescription>
							</Field>
							<PasswordField
								inputId="site-smtp-password"
								stored={storedPassword}
								replacing={replacing}
								password={password}
								setPassword={setPassword}
								disabled={username.trim() === ""}
								replaceButton={replaceButton}
								onReplace={() => {
									setReplacing(true);
									setFocusAfterChange("password");
								}}
								onKeep={() => {
									setReplacing(false);
									setPassword("");
									setFocusAfterChange("replace");
								}}
							/>
						</div>
					</FieldGroup>
				</Section>
			) : null}

			<Section heading={t("emailSettings.sender.heading")}>
				<FieldGroup className="gap-5">
					<div className="grid gap-5 md:grid-cols-2">
						<Field data-invalid={invalid("fromName")}>
							<FieldLabel htmlFor="site-smtp-fromName">{t("siteEmail.sender.fromName")}</FieldLabel>
							<Input
								id="site-smtp-fromName"
								value={fromName}
								onChange={(event) => setFromName(event.target.value)}
								autoComplete="off"
								placeholder={siteName}
								aria-invalid={invalid("fromName")}
								aria-describedby={describedBy("fromName", "site-smtp-fromName-help")}
							/>
							<FieldDescription id="site-smtp-fromName-help">
								{t("siteEmail.sender.fromNameHelp", { name: siteName })}
							</FieldDescription>
							{error("fromName")}
						</Field>
						{own ? (
							<Field data-invalid={invalid("fromAddress")}>
								<FieldLabel htmlFor="site-smtp-fromAddress">{t("emailSettings.sender.fromAddress")}</FieldLabel>
								<Input
									id="site-smtp-fromAddress"
									type="email"
									value={fromAddress}
									onChange={(event) => setFromAddress(event.target.value)}
									autoComplete="off"
									required
									aria-invalid={invalid("fromAddress")}
									aria-describedby={describedBy("fromAddress", "site-smtp-fromAddress-help")}
								/>
								<FieldDescription id="site-smtp-fromAddress-help">
									{t("siteEmail.sender.fromAddressHelp")}
								</FieldDescription>
								{error("fromAddress")}
							</Field>
						) : null}
					</div>
					<Field data-invalid={invalid("replyTo")}>
						<FieldLabel htmlFor="site-smtp-replyTo">{t("emailSettings.sender.replyTo")}</FieldLabel>
						<Input
							id="site-smtp-replyTo"
							type="email"
							value={replyTo}
							onChange={(event) => setReplyTo(event.target.value)}
							autoComplete="off"
							aria-invalid={invalid("replyTo")}
							aria-describedby={describedBy("replyTo", "site-smtp-replyTo-help")}
						/>
						<FieldDescription id="site-smtp-replyTo-help">{t("siteEmail.sender.replyToHelp")}</FieldDescription>
						{error("replyTo")}
					</Field>
				</FieldGroup>
			</Section>

			<Section heading={t("emailSettings.test.heading")} intro={t("emailSettings.test.intro")}>
				<div className="flex flex-col gap-4">
					<Field data-invalid={invalid("testTo")}>
						<FieldLabel htmlFor="site-smtp-testTo">{t("emailSettings.test.to")}</FieldLabel>
						<div className="flex flex-col gap-3 sm:flex-row">
							<Input
								id="site-smtp-testTo"
								type="email"
								value={testTo}
								onChange={(event) => setTestTo(event.target.value)}
								autoComplete="email"
								aria-invalid={invalid("testTo")}
								aria-describedby={describedBy("testTo")}
							/>
							<Button type="button" variant="outline" onClick={sendTest} disabled={testing || busy}>
								<SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
								{t("emailSettings.test.send")}
							</Button>
						</div>
						{error("testTo")}
					</Field>
					<div role="status" aria-live="polite">
						{testResult ? <TestResult result={testResult} /> : null}
					</div>
				</div>
			</Section>

			{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">{t("siteEmail.applyNote")}</p>
				<Button type="submit" disabled={busy}>
					{t("emailSettings.save")}
				</Button>
			</div>
		</form>
	);
}
