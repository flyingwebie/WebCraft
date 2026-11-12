import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
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
		<main id="main" tabIndex={-1} className="bg-muted flex min-h-svh items-center justify-center p-4 outline-none">
			<div className="bg-card text-card-foreground w-full max-w-sm rounded-xl border p-8 shadow-sm">
				{state === "form" ? (
					<div className="grid gap-6">
						<div className="grid gap-2">
							<h1 className="text-2xl font-semibold tracking-tight">{t("resetPassword.heading")}</h1>
							<p className="text-muted-foreground text-sm">{t("resetPassword.body")}</p>
						</div>
						<form onSubmit={submit} noValidate>
							<FieldGroup className="gap-5">
								<Field data-invalid={error ? true : undefined}>
									<FieldLabel htmlFor="reset-password-new">{t("resetPassword.password")}</FieldLabel>
									<PasswordInput
										id="reset-password-new"
										value={password}
										onChange={(event) => setPassword(event.target.value)}
										autoComplete="new-password"
										required
										aria-invalid={error ? true : undefined}
										aria-describedby={error ? "reset-password-help reset-password-error" : "reset-password-help"}
									/>
									<FieldDescription id="reset-password-help">{t("resetPassword.passwordHelp")}</FieldDescription>
									{error ? <FieldError id="reset-password-error">{t(error)}</FieldError> : null}
								</Field>
								<Button type="submit" disabled={busy} className="w-full">
									{t("resetPassword.submit")}
								</Button>
							</FieldGroup>
						</form>
					</div>
				) : state === "done" ? (
					<div className="grid gap-4">
						<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
							{t("resetPassword.done.heading")}
						</h1>
						<p className="text-muted-foreground">{t("resetPassword.done.body")}</p>
						<Link to="/sign-in" className={buttonVariants({ className: "justify-self-start" })}>
							{t("resetPassword.done.signIn")}
						</Link>
					</div>
				) : (
					<div className="grid gap-4">
						<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
							{t("resetPassword.invalid.heading")}
						</h1>
						<p className="text-muted-foreground">{t("resetPassword.invalid.body")}</p>
						<Link
							to="/forgot-password"
							className={buttonVariants({ variant: "outline", className: "justify-self-start" })}
						>
							{t("resetPassword.invalid.again")}
						</Link>
					</div>
				)}
			</div>
		</main>
	);
}
