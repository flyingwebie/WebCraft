import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { type FormEvent, useState } from "react";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { errorMessage } from "../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../ui/i18n.tsx";
import { PasswordInput } from "../ui/PasswordInput.tsx";

/** Only paths on the admin itself: never another site, so the page can't be used to send people away. */
const localPath = z
	.string()
	.max(2048)
	.refine((path) => path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\"));

export const Route = createFileRoute("/sign-in")({
	validateSearch: z.object({ redirect: localPath.optional().catch(undefined) }),
	beforeLoad: ({ context, search }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (shell.person) throw redirect({ href: search.redirect ?? "/" });
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "signIn.pageTitle") }] }),
	component: SignInPage,
});

function SignInPage() {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const search = Route.useSearch();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.session.signIn({ email, password });
			// Every navigation reloads the shell context, so the admin knows who signed in.
			await router.navigate({ href: search.redirect ?? "/" });
		} catch (failure) {
			setError(errorMessage(failure));
			setBusy(false);
		}
	};

	return (
		<main id="main" tabIndex={-1} className="bg-muted flex min-h-svh items-center justify-center p-4 outline-none">
			<div className="bg-card text-card-foreground w-full max-w-sm rounded-xl border p-8 shadow-sm">
				<h1 className="mb-6 text-2xl font-semibold tracking-tight">
					{shell.install.name ? t("signIn.headingNamed", { name: shell.install.name }) : t("signIn.heading")}
				</h1>
				<form onSubmit={submit} noValidate>
					<FieldGroup className="gap-5">
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="sign-in-email">{t("signIn.email")}</FieldLabel>
							<Input
								id="sign-in-email"
								type="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								autoComplete="username"
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "sign-in-error" : undefined}
							/>
						</Field>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="sign-in-password">{t("signIn.password")}</FieldLabel>
							<PasswordInput
								id="sign-in-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="current-password"
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "sign-in-error" : undefined}
							/>
						</Field>
						{error ? <FieldError id="sign-in-error">{t(error)}</FieldError> : null}
						<Button type="submit" disabled={busy} className="w-full">
							{t("signIn.submit")}
						</Button>
					</FieldGroup>
				</form>
			</div>
		</main>
	);
}
