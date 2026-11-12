import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getApi } from "../ui/api.ts";
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
		<main id="main" tabIndex={-1} className="bg-muted flex min-h-svh items-center justify-center p-4 outline-none">
			<div className="bg-card text-card-foreground w-full max-w-sm rounded-xl border p-8 shadow-sm">
				{sentTo ? (
					<div className="grid gap-4">
						<h1 ref={sentHeading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
							{t("forgotPassword.sent.heading")}
						</h1>
						<p>{t("forgotPassword.sent.body", { email: sentTo })}</p>
						<p className="text-muted-foreground text-sm">{t("forgotPassword.sent.help")}</p>
						<div className="flex flex-wrap gap-2">
							<Link to="/sign-in" className={buttonVariants({ variant: "outline" })}>
								{t("forgotPassword.backToSignIn")}
							</Link>
							<Button type="button" variant="ghost" onClick={() => setSentTo(null)}>
								{t("forgotPassword.sent.again")}
							</Button>
						</div>
					</div>
				) : (
					<div className="grid gap-6">
						<div className="grid gap-2">
							<h1 className="text-2xl font-semibold tracking-tight">{t("forgotPassword.heading")}</h1>
							<p className="text-muted-foreground text-sm">{t("forgotPassword.body")}</p>
						</div>
						<form onSubmit={submit} noValidate>
							<FieldGroup className="gap-5">
								<Field data-invalid={error ? true : undefined}>
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
						<Link to="/sign-in" className={buttonVariants({ variant: "ghost", className: "justify-self-start" })}>
							{t("forgotPassword.backToSignIn")}
						</Link>
					</div>
				)}
			</div>
		</main>
	);
}
