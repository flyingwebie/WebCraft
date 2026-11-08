import { createFileRoute, Link, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { errorCode, errorMessage } from "../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../ui/i18n.tsx";
import { PasswordInput } from "../ui/PasswordInput.tsx";

export const Route = createFileRoute("/invite")({
	// The link in the invite email carries the invite's token.
	validateSearch: z.object({ token: z.string().max(512).optional() }),
	beforeLoad: ({ context }) => {
		if (context.shell.setup.stage === "claim") throw redirect({ to: "/setup" });
	},
	// Loaded once: the token then leaves the address bar (see InvitePage), which must not load the
	// page again without it.
	shouldReload: false,
	loader: async ({ location }) => {
		const token = (location.search as { token?: string }).token;
		if (!token) return { invite: null, token: null };
		const api = await getApi();
		try {
			return { invite: await api.invites.get({ token }), token };
		} catch (error) {
			if (errorCode(error) === "INVITE_INVALID") return { invite: null, token: null };
			throw error;
		}
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "invite.pageTitle") }] }),
	component: InvitePage,
});

/** Accepting an invite: the invited person chooses their name and password, and is signed in. */
function InvitePage() {
	const t = useT();
	const navigate = useNavigate();
	const { invite, token } = Route.useLoaderData();
	const { token: linked } = Route.useSearch();

	// The token has been read: take it out of the address bar, so it stays out of the browser's history.
	useEffect(() => {
		if (linked) void navigate({ to: "/invite", search: {}, replace: true });
	}, [linked, navigate]);

	return (
		<main id="main" tabIndex={-1} className="bg-muted flex min-h-svh items-center justify-center p-4 outline-none">
			<div className="bg-card text-card-foreground w-full max-w-md rounded-xl border p-8 shadow-sm">
				{invite && token ? (
					<AcceptForm invite={invite} token={token} />
				) : (
					<div className="grid gap-4">
						<h1 className="text-2xl font-semibold tracking-tight">{t("invite.invalid.heading")}</h1>
						<p className="text-muted-foreground">{t("invite.invalid.body")}</p>
						<Link to="/sign-in" className={buttonVariants({ variant: "outline", className: "justify-self-start" })}>
							{t("invite.invalid.signIn")}
						</Link>
					</div>
				)}
			</div>
		</main>
	);
}

function AcceptForm({
	invite,
	token,
}: {
	invite: { email: string; installName: string | null; invitedBy: string | null };
	token: string;
}) {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [errors, setErrors] = useState<{ name?: MessageKey; password?: MessageKey; form?: MessageKey }>({});
	const [busy, setBusy] = useState(false);
	const install = invite.installName ?? t("app.name");

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setErrors({ name: "invite.nameRequired" });
			return;
		}
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			await api.invites.accept({ token, name, password, adminLanguage: shell.language.code });
			// Every navigation reloads the shell context, so the admin knows who signed in.
			await router.navigate({ to: "/" });
		} catch (failure) {
			const message = errorMessage(failure);
			setErrors(errorCode(failure) === "PASSWORD_REFUSED" ? { password: message } : { form: message });
			setBusy(false);
		}
	};

	return (
		<>
			<h1 className="mb-2 text-2xl font-semibold tracking-tight">{t("invite.heading", { install })}</h1>
			<p className="text-muted-foreground mb-6">
				{invite.invitedBy
					? t("invite.intro", { inviter: invite.invitedBy, email: invite.email })
					: t("invite.introNoInviter", { email: invite.email })}
			</p>
			<form onSubmit={submit} noValidate>
				{/* Lets password managers save the new password under the right address. */}
				<input type="hidden" name="username" autoComplete="username" value={invite.email} />
				<FieldGroup className="gap-5">
					<Field data-invalid={errors.name ? true : undefined}>
						<FieldLabel htmlFor="invite-name">{t("invite.name")}</FieldLabel>
						<Input
							id="invite-name"
							value={name}
							maxLength={200}
							autoComplete="name"
							onChange={(event) => setName(event.target.value)}
							aria-invalid={errors.name ? true : undefined}
							aria-describedby={errors.name ? "invite-name-error" : undefined}
						/>
						{errors.name ? <FieldError id="invite-name-error">{t(errors.name)}</FieldError> : null}
					</Field>
					<Field data-invalid={errors.password ? true : undefined}>
						<FieldLabel htmlFor="invite-password">{t("invite.password")}</FieldLabel>
						<PasswordInput
							id="invite-password"
							value={password}
							autoComplete="new-password"
							onChange={(event) => setPassword(event.target.value)}
							aria-invalid={errors.password ? true : undefined}
							aria-describedby={errors.password ? "invite-password-help invite-password-error" : "invite-password-help"}
						/>
						<FieldDescription id="invite-password-help">{t("invite.passwordHelp")}</FieldDescription>
						{errors.password ? <FieldError id="invite-password-error">{t(errors.password)}</FieldError> : null}
					</Field>
					{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
					<Button type="submit" disabled={busy} className="w-full">
						{t("invite.submit")}
					</Button>
				</FieldGroup>
			</form>
		</>
	);
}
