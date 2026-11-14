import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getApi } from "../ui/api.ts";
import { AuthHeading, AuthLead, AuthPage } from "../ui/auth/AuthPage.tsx";
import { errorMessage } from "../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../ui/i18n.tsx";

export const Route = createFileRoute("/forgot-password")({
	beforeLoad: ({ context }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (shell.person) throw redirect({ to: "/" });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "forgotPassword.pageTitle") }],
	}),
	component: ForgotPasswordPage,
});

/**
 * Password recovery, first step: the person gives the address they sign in with and is emailed a
 * link to choose a new password. The page says the same whether the address has an account or not.
 */
function ForgotPasswordPage() {
	const t = useT();
	const [email, setEmail] = useState("");
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const sentHeading = useRef<HTMLHeadingElement>(null);

	// The page changed under the keyboard: focus moves to the new heading, read out first.
	useEffect(() => {
		if (sentTo) sentHeading.current?.focus();
	}, [sentTo]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const address = email.trim();
		if (!address) {
			setError("forgotPassword.emailRequired");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.passwordReset.request({ email: address });
			setSentTo(address);
		} catch (failure) {
			setError(errorMessage(failure));
		}
		setBusy(false);
	};

	return (
		<AuthPage
			below={
				<Link to="/sign-in" className="hover:text-foreground underline underline-offset-4">
					{t("forgotPassword.backToSignIn")}
				</Link>
			}
		>
			{sentTo ? (
				<div className="grid gap-3">
					<AuthHeading ref={sentHeading}>{t("forgotPassword.sent.heading")}</AuthHeading>
					<AuthLead>{t("forgotPassword.sent.body", { email: sentTo })}</AuthLead>
					<AuthLead>{t("forgotPassword.sent.help")}</AuthLead>
					<Button
						type="button"
						variant="link"
						size="sm"
						className="justify-self-start px-2.5"
						onClick={() => setSentTo(null)}
					>
						{t("forgotPassword.sent.again")}
					</Button>
				</div>
			) : (
				<>
					<div className="grid gap-4">
						<AuthHeading>{t("forgotPassword.heading")}</AuthHeading>
						<AuthLead>{t("forgotPassword.body")}</AuthLead>
					</div>
					<form onSubmit={submit} noValidate>
						<FieldGroup className="gap-4">
							<Field className="gap-2" data-invalid={error ? true : undefined}>
								<FieldLabel htmlFor="forgot-password-email">{t("forgotPassword.email")}</FieldLabel>
								<Input
									id="forgot-password-email"
									type="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									autoComplete="username"
									maxLength={320}
									required
									aria-invalid={error ? true : undefined}
									aria-describedby={error ? "forgot-password-error" : undefined}
								/>
								{error ? <FieldError id="forgot-password-error">{t(error)}</FieldError> : null}
							</Field>
							<Button type="submit" disabled={busy} className="w-full">
								{t("forgotPassword.submit")}
							</Button>
						</FieldGroup>
					</form>
				</>
			)}
		</AuthPage>
	);
}
