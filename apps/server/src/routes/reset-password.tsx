import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { AuthHeading, AuthLead, AuthPage, PasswordRules } from "../ui/auth/AuthPage.tsx";
import { errorCode, errorMessage } from "../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../ui/i18n.tsx";
import { PasswordInput } from "../ui/PasswordInput.tsx";

export const Route = createFileRoute("/reset-password")({
	// The link in the reset email carries its token.
	validateSearch: z.object({ token: z.string().max(512).optional() }),
	beforeLoad: ({ context }) => {
		if (context.shell.setup.stage === "claim") throw redirect({ to: "/setup" });
	},
	// Loaded once: the token then leaves the address bar (see ResetPasswordPage), which must not load
	// the page again without it.
	shouldReload: false,
	loader: async ({ location }) => {
		const token = (location.search as { token?: string }).token;
		if (!token) return { token: null };
		const api = await getApi();
		try {
			await api.passwordReset.check({ token });
			return { token };
		} catch (error) {
			if (errorCode(error) === "PASSWORD_RESET_INVALID") return { token: null };
			throw error;
		}
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "resetPassword.pageTitle") }],
	}),
	component: ResetPasswordPage,
});

/**
 * Password recovery, second step: the person opened the link from their email and chooses a new
 * password. It signs them out everywhere and signs nobody in: they sign in next, with their second
 * factor when they have one.
 */
function ResetPasswordPage() {
	const t = useT();
	const navigate = useNavigate();
	const loaded = Route.useLoaderData();
	const { token: linked } = Route.useSearch();
	const [state, setState] = useState<"form" | "done" | "invalid">(loaded.token ? "form" : "invalid");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const heading = useRef<HTMLHeadingElement>(null);
	const shown = useRef(state);

	// The token has been read: take it out of the address bar, so it stays out of the browser's history.
	useEffect(() => {
		if (linked) void navigate({ to: "/reset-password", search: {}, replace: true });
	}, [linked, navigate]);

	// The page changed under the keyboard: focus moves to the new heading, read out first.
	useEffect(() => {
		if (shown.current !== state) heading.current?.focus();
		shown.current = state;
	}, [state]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!loaded.token) return;
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.passwordReset.complete({ token: loaded.token, newPassword: password });
			setState("done");
		} catch (failure) {
			if (errorCode(failure) === "PASSWORD_RESET_INVALID") setState("invalid");
			else setError(errorMessage(failure));
		}
		setBusy(false);
	};

	return (
		<AuthPage>
			{state === "form" ? (
				<>
					<div className="grid gap-4">
						<AuthHeading>{t("resetPassword.heading")}</AuthHeading>
						<AuthLead>{t("resetPassword.body")}</AuthLead>
					</div>
					<form onSubmit={submit} noValidate>
						<FieldGroup className="gap-4">
							<Field className="gap-2" data-invalid={error ? true : undefined}>
								<FieldLabel htmlFor="reset-password-new">{t("resetPassword.password")}</FieldLabel>
								<PasswordInput
									id="reset-password-new"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									autoComplete="new-password"
									required
									aria-invalid={error ? true : undefined}
									aria-describedby={error ? "reset-password-rules reset-password-error" : "reset-password-rules"}
								/>
								{error ? <FieldError id="reset-password-error">{t(error)}</FieldError> : null}
							</Field>
							<PasswordRules id="reset-password-rules" password={password} />
							<Button type="submit" disabled={busy} className="w-full">
								{t("resetPassword.submit")}
							</Button>
						</FieldGroup>
					</form>
				</>
			) : state === "done" ? (
				<div className="grid gap-3">
					<AuthHeading ref={heading}>{t("resetPassword.done.heading")}</AuthHeading>
					<AuthLead>{t("resetPassword.done.body")}</AuthLead>
					<Button className="mt-1 w-full" render={<Link to="/sign-in" />}>
						{t("resetPassword.done.signIn")}
					</Button>
				</div>
			) : (
				<div className="grid gap-3">
					<AuthHeading ref={heading}>{t("resetPassword.invalid.heading")}</AuthHeading>
					<AuthLead>{t("resetPassword.invalid.body")}</AuthLead>
					<Button variant="outline" className="mt-1 w-full" render={<Link to="/forgot-password" />}>
						{t("resetPassword.invalid.again")}
					</Button>
				</div>
			)}
		</AuthPage>
	);
}
