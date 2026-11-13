import { useRouter } from "@tanstack/react-router";
import { ADMIN_LANGUAGES, type AdminLanguageCode, isAdminLanguage } from "@webcraft/core/admin-languages";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { ArrowLeftIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PasswordInput } from "../PasswordInput.tsx";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

type FieldName = "name" | "email" | "password" | "form";

/** Step 2: the Superadmin's account. Creating it claims the Install and signs them in. */
export function AccountStep({ token, language, setLanguage, onBack }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({});
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "") {
			setErrors({ name: "setup.steps.account.nameRequired" });
			document.getElementById("account-name")?.focus();
			return;
		}
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			await api.setup.claim({ token: token ?? "", name, email, password, adminLanguage: language });
			// Signed in as the Superadmin: the wizard goes on with the steps after the account.
			await router.invalidate();
		} catch (failure) {
			const code = errorCode(failure);
			const message = errorMessage(failure);
			if (code === "SETUP_CLOSED") await router.invalidate();
			if (code === "EMAIL_INVALID" || code === "EMAIL_IN_USE") setErrors({ email: message });
			else if (code === "PASSWORD_REFUSED") setErrors({ password: message });
			else setErrors({ form: message });
		} finally {
			setBusy(false);
		}
	};

	const describedBy = (field: FieldName, help?: string) =>
		[help, errors[field] ? `account-${field}-error` : undefined].filter(Boolean).join(" ") || undefined;

	return (
		<form onSubmit={submit} className="flex flex-1 flex-col gap-8" noValidate>
			<StepHeader heading={t("setup.steps.account.heading")}>
				<p>{t("setup.steps.account.intro")}</p>
			</StepHeader>
			<FieldGroup className="gap-5">
				<div className="grid gap-5 md:grid-cols-2">
					<Field data-invalid={errors.name ? true : undefined}>
						<FieldLabel htmlFor="account-name">{t("setup.steps.account.name")}</FieldLabel>
						<Input
							id="account-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							autoComplete="name"
							required
							aria-invalid={errors.name ? true : undefined}
							aria-describedby={describedBy("name")}
						/>
						{errors.name ? <FieldError id="account-name-error">{t(errors.name)}</FieldError> : null}
					</Field>
					<Field>
						<FieldLabel htmlFor="account-language">{t("setup.steps.account.language")}</FieldLabel>
						<NativeSelect
							id="account-language"
							value={language}
							onChange={(event) => {
								if (isAdminLanguage(event.target.value)) setLanguage(event.target.value as AdminLanguageCode);
							}}
						>
							{ADMIN_LANGUAGES.map((option) => (
								<NativeSelectOption key={option.code} value={option.code} lang={option.code}>
									{option.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
				</div>
				<Field data-invalid={errors.email ? true : undefined}>
					<FieldLabel htmlFor="account-email">{t("setup.steps.account.email")}</FieldLabel>
					<Input
						id="account-email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						autoComplete="email"
						required
						aria-invalid={errors.email ? true : undefined}
						aria-describedby={describedBy("email")}
					/>
					{errors.email ? <FieldError id="account-email-error">{t(errors.email)}</FieldError> : null}
				</Field>
				<Field data-invalid={errors.password ? true : undefined}>
					<FieldLabel htmlFor="account-password">{t("setup.steps.account.password")}</FieldLabel>
					<PasswordInput
						id="account-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="new-password"
						required
						minLength={12}
						aria-invalid={errors.password ? true : undefined}
						aria-describedby={describedBy("password", "account-password-help")}
					/>
					<FieldDescription id="account-password-help">{t("setup.steps.account.passwordHelp")}</FieldDescription>
					{errors.password ? <FieldError id="account-password-error">{t(errors.password)}</FieldError> : null}
				</Field>
				{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
			</FieldGroup>
			<div className="mt-auto flex items-center justify-between gap-4">
				{onBack ? (
					<Button type="button" variant="ghost" onClick={onBack}>
						<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
						{t("setup.back")}
					</Button>
				) : (
					<span />
				)}
				<Button type="submit" disabled={busy}>
					{t("setup.steps.account.create")}
				</Button>
			</div>
		</form>
	);
}
