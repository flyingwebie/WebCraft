import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { SendIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { EMAIL, PasswordField, SECURITY_OPTIONS, Section, type Security, TestResult } from "./smtp-parts.tsx";

/** The Install SMTP as the API shows it. */
export type SmtpView = Awaited<ReturnType<ApiClient["install"]["smtp"]["get"]>>;

type FieldName = "host" | "port" | "fromAddress" | "replyTo" | "testTo" | "form";

/**
 * The Install SMTP form: server details, the sender address and a test email sent with what is in
 * the form, before it is saved. The password is never shown: only whether one is set, with its
 * last 4 characters, and a way to replace it.
 */
export function SmtpForm({
	view,
	testTo: initialTestTo,
	layout,
	onSaved,
	actions,
}: {
	view: SmtpView;
	/** Where the test email goes until the person types another address: their own. */
	testTo: string;
	/** `cards` on the settings page; `plain` sections inside the setup wizard. */
	layout: "cards" | "plain";
	onSaved(view: SmtpView): void | Promise<void>;
	/** The buttons under the form; one of them submits it. */
	actions(state: { busy: boolean }): ReactNode;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const settings = view.settings;
	const [host, setHost] = useState(settings?.host ?? "");
	const [port, setPort] = useState(String(settings?.port ?? 587));
	const [security, setSecurity] = useState<Security>(settings?.security ?? "starttls");
	const [username, setUsername] = useState(settings?.username ?? "");
	const [password, setPassword] = useState("");
	const storedPassword = settings?.password.set ? settings.password : null;
	const [replacing, setReplacing] = useState(!storedPassword);
	const [fromAddress, setFromAddress] = useState(settings?.fromAddress ?? "");
	const [replyTo, setReplyTo] = useState(settings?.replyTo ?? "");
	const [testTo, setTestTo] = useState(initialTestTo);
	const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({});
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ status: "sent" | "failed"; response: string; to: string } | null>(
		null,
	);
	const replaceButton = useRef<HTMLButtonElement>(null);
	// Where focus goes once the password field has changed: the new password input, or back to Replace.
	const [focusAfterChange, setFocusAfterChange] = useState<"password" | "replace" | null>(null);

	useEffect(() => {
		if (focusAfterChange === "password") document.getElementById("smtp-password")?.focus();
		if (focusAfterChange === "replace") replaceButton.current?.focus();
		if (focusAfterChange) setFocusAfterChange(null);
	}, [focusAfterChange]);

	/** The settings in the form, or null after marking what's wrong and focusing the first such field. */
	const formSettings = (extra: Partial<Record<FieldName, MessageKey>> = {}) => {
		const found: Partial<Record<FieldName, MessageKey>> = {};
		const portNumber = Number(port);
		if (host.trim() === "") found.host = "emailSettings.errors.hostRequired";
		if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
			found.port = "emailSettings.errors.portInvalid";
		}
		if (!EMAIL.test(fromAddress.trim())) found.fromAddress = "emailSettings.errors.emailInvalid";
		if (replyTo.trim() !== "" && !EMAIL.test(replyTo.trim())) found.replyTo = "emailSettings.errors.emailInvalid";
		Object.assign(found, extra);
		setErrors(found);
		const first = (["host", "port", "fromAddress", "replyTo", "testTo"] as const).find((field) => found[field]);
		if (first) {
			document.getElementById(`smtp-${first}`)?.focus();
			return null;
		}
		return {
			host: host.trim(),
			port: portNumber,
			security,
			username: username.trim() || null,
			fromAddress: fromAddress.trim(),
			replyTo: replyTo.trim() || null,
		};
	};

	const typedPassword = replacing && password !== "" ? password : undefined;

	const save = async (event: FormEvent) => {
		event.preventDefault();
		const values = formSettings();
		if (!values) return;
		setBusy(true);
		try {
			const api = await getApi();
			// A Sensitive action: it changes a secret, so it may ask the person to confirm it's them.
			const saved = await runSensitive(() =>
				api.install.smtp.update({
					...values,
					// No username: the server takes mail without signing in, so no password is kept.
					password: values.username ? typedPassword : null,
				}),
			);
			setPassword("");
			setReplacing(!(saved.settings?.password.set ?? false));
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
			const result = await api.install.smtp.sendTest({ to: testTo.trim(), settings: values, password: typedPassword });
			setTestResult({ ...result, to: testTo.trim() });
		} catch (failure) {
			setErrors({ form: errorMessage(failure) });
		} finally {
			setTesting(false);
		}
	};

	const describedBy = (field: FieldName, help?: string) =>
		[help, errors[field] ? `smtp-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;
	const invalid = (field: FieldName) => (errors[field] ? true : undefined);
	const error = (field: FieldName) =>
		errors[field] ? <FieldError id={`smtp-${field}-error`}>{t(errors[field])}</FieldError> : null;

	return (
		<form onSubmit={save} className="flex flex-col gap-6" noValidate>
			<Section layout={layout} heading={t("emailSettings.server.heading")}>
				<FieldGroup className="gap-5">
					<div className="grid gap-5 md:grid-cols-[1fr_8rem_12rem]">
						<Field data-invalid={invalid("host")}>
							<FieldLabel htmlFor="smtp-host">{t("emailSettings.server.host")}</FieldLabel>
							<Input
								id="smtp-host"
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
							<FieldLabel htmlFor="smtp-port">{t("emailSettings.server.port")}</FieldLabel>
							<Input
								id="smtp-port"
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
							<FieldLabel htmlFor="smtp-security">{t("emailSettings.server.security")}</FieldLabel>
							<NativeSelect
								id="smtp-security"
								value={security}
								onChange={(event) => {
									const next = SECURITY_OPTIONS.find((option) => option.value === event.target.value);
									if (!next) return;
									// Moving between the usual ports follows the encryption; a custom port stays.
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
							<FieldLabel htmlFor="smtp-username">{t("emailSettings.server.username")}</FieldLabel>
							<Input
								id="smtp-username"
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								autoComplete="off"
								spellCheck={false}
								aria-describedby="smtp-username-help"
							/>
							<FieldDescription id="smtp-username-help">{t("emailSettings.server.usernameHelp")}</FieldDescription>
						</Field>
						<PasswordField
							inputId="smtp-password"
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

			<Section layout={layout} heading={t("emailSettings.sender.heading")}>
				<FieldGroup className="gap-5">
					<div className="grid gap-5 md:grid-cols-2">
						<Field data-invalid={invalid("fromAddress")}>
							<FieldLabel htmlFor="smtp-fromAddress">{t("emailSettings.sender.fromAddress")}</FieldLabel>
							<Input
								id="smtp-fromAddress"
								type="email"
								value={fromAddress}
								onChange={(event) => setFromAddress(event.target.value)}
								autoComplete="off"
								required
								aria-invalid={invalid("fromAddress")}
								aria-describedby={describedBy("fromAddress", "smtp-fromAddress-help")}
							/>
							<FieldDescription id="smtp-fromAddress-help">
								{t("emailSettings.sender.fromAddressHelp")}
							</FieldDescription>
							{error("fromAddress")}
						</Field>
						<Field data-invalid={invalid("replyTo")}>
							<FieldLabel htmlFor="smtp-replyTo">{t("emailSettings.sender.replyTo")}</FieldLabel>
							<Input
								id="smtp-replyTo"
								type="email"
								value={replyTo}
								onChange={(event) => setReplyTo(event.target.value)}
								autoComplete="off"
								aria-invalid={invalid("replyTo")}
								aria-describedby={describedBy("replyTo")}
							/>
							{error("replyTo")}
						</Field>
					</div>
				</FieldGroup>
			</Section>

			<Section layout={layout} heading={t("emailSettings.test.heading")} intro={t("emailSettings.test.intro")}>
				<div className="flex flex-col gap-4">
					<Field data-invalid={invalid("testTo")}>
						<FieldLabel htmlFor="smtp-testTo">{t("emailSettings.test.to")}</FieldLabel>
						<div className="flex flex-col gap-3 sm:flex-row">
							<Input
								id="smtp-testTo"
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
			<div className="flex flex-wrap items-center justify-end gap-3">{actions({ busy })}</div>
		</form>
	);
}
