import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { errorCode, errorMessage } from "../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../ui/i18n.tsx";
import { localPath } from "../ui/local-path.ts";
import { PasswordInput } from "../ui/PasswordInput.tsx";
import { getPasskey, PasskeyCancelledError } from "../ui/two-factor/passkeys.ts";
import { usePasskeysAvailable } from "../ui/two-factor/Setup.tsx";

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

type SecondStepMethod = "authenticator" | "backupCode" | "passkey";

/**
 * Signing in: email and password, then, for a person with two-factor authentication, the second
 * step (a code from their authenticator app, a backup code, or a passkey). A passkey alone signs in
 * too: it counts as both.
 */
function SignInPage() {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const search = Route.useSearch();
	const [secondStep, setSecondStep] = useState<SecondStepMethod[] | null>(null);

	const signedIn = async () => {
		// Every navigation reloads the shell context, so the admin knows who signed in.
		await router.navigate({ href: search.redirect ?? "/" });
	};

	return (
		<main id="main" tabIndex={-1} className="bg-muted flex min-h-svh items-center justify-center p-4 outline-none">
			<div className="bg-card text-card-foreground w-full max-w-sm rounded-xl border p-8 shadow-sm">
				{secondStep ? (
					<SecondStep methods={secondStep} onSignedIn={signedIn} onStartOver={() => setSecondStep(null)} />
				) : (
					<>
						<h1 className="mb-6 text-2xl font-semibold tracking-tight">
							{shell.install.name ? t("signIn.headingNamed", { name: shell.install.name }) : t("signIn.heading")}
						</h1>
						<PasswordStep onSignedIn={signedIn} onSecondStep={setSecondStep} />
					</>
				)}
			</div>
		</main>
	);
}

function PasswordStep({
	onSignedIn,
	onSecondStep,
}: {
	onSignedIn(): Promise<void>;
	onSecondStep(methods: SecondStepMethod[]): void;
}) {
	const t = useT();
	const canUsePasskeys = usePasskeysAvailable();
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
			const answer = await api.session.signIn({ email, password });
			if (answer.secondStep) {
				onSecondStep(answer.secondStep.methods);
				return;
			}
			await onSignedIn();
		} catch (failure) {
			setError(errorMessage(failure));
			setBusy(false);
		}
	};

	const withPasskey = async () => {
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { options } = await api.session.passkeyOptions();
			await api.session.signInWithPasskey({ credential: await getPasskey(options) });
			await onSignedIn();
		} catch (failure) {
			setError(failure instanceof PasskeyCancelledError ? "signIn.passkeyCancelled" : errorMessage(failure));
			setBusy(false);
		}
	};

	return (
		<div className="grid gap-6">
			<form onSubmit={submit} noValidate>
				<FieldGroup className="gap-5">
					<Field data-invalid={error ? true : undefined}>
						<FieldLabel htmlFor="sign-in-email">{t("signIn.email")}</FieldLabel>
						<Input
							id="sign-in-email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							autoComplete="username webauthn"
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
			{canUsePasskeys ? (
				<>
					<p className="text-muted-foreground flex items-center gap-3 text-xs uppercase before:h-px before:flex-1 before:bg-current/20 after:h-px after:flex-1 after:bg-current/20">
						{t("signIn.or")}
					</p>
					<Button type="button" variant="outline" className="w-full" onClick={withPasskey} disabled={busy}>
						<KeyRoundIcon aria-hidden="true" />
						{t("signIn.withPasskey")}
					</Button>
				</>
			) : null}
		</div>
	);
}

/** The second step: a code from the authenticator app (or a backup code), or a passkey. */
function SecondStep({
	methods,
	onSignedIn,
	onStartOver,
}: {
	methods: SecondStepMethod[];
	onSignedIn(): Promise<void>;
	onStartOver(): void;
}) {
	const t = useT();
	const canUsePasskeys = usePasskeysAvailable();
	const heading = useRef<HTMLHeadingElement>(null);
	// The authenticator app first; with passkeys and no app, the passkey (a backup code a click away).
	const [method, setMethod] = useState<"authenticator" | "backupCode" | null>(
		methods.includes("authenticator") ? "authenticator" : methods.includes("passkey") ? null : "backupCode",
	);
	const [code, setCode] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [expired, setExpired] = useState(false);
	const [busy, setBusy] = useState(false);
	const withPasskeys = methods.includes("passkey") && canUsePasskeys;

	// The page changed under the keyboard: focus moves to the new step's heading, read out first.
	useEffect(() => heading.current?.focus(), []);

	const fail = (failure: unknown) => {
		if (errorCode(failure) === "SIGN_IN_EXPIRED") setExpired(true);
		setError(failure instanceof PasskeyCancelledError ? "signIn.passkeyCancelled" : errorMessage(failure));
		setBusy(false);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!method) return;
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.session.secondStep({ method, code });
			await onSignedIn();
		} catch (failure) {
			fail(failure);
		}
	};

	const withPasskey = async () => {
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { options } = await api.session.passkeyOptions();
			await api.session.signInWithPasskey({ credential: await getPasskey(options) });
			await onSignedIn();
		} catch (failure) {
			fail(failure);
		}
	};

	const switchTo = (next: "authenticator" | "backupCode") => {
		setMethod(next);
		setCode("");
		setError(null);
	};

	return (
		<div className="grid gap-6">
			<div className="grid gap-2">
				<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
					{t("signIn.secondStep.heading")}
				</h1>
				<p className="text-muted-foreground text-sm">
					{method === "authenticator"
						? t("signIn.secondStep.authenticatorBody")
						: method === "backupCode"
							? t("signIn.secondStep.backupCodeBody")
							: t("signIn.secondStep.passkeyBody")}
				</p>
			</div>
			{method ? (
				<form onSubmit={submit} noValidate>
					<FieldGroup className="gap-5">
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="sign-in-code">
								{method === "authenticator" ? t("signIn.secondStep.code") : t("signIn.secondStep.backupCode")}
							</FieldLabel>
							<Input
								id="sign-in-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
								inputMode={method === "authenticator" ? "numeric" : "text"}
								autoComplete="one-time-code"
								autoCapitalize="none"
								spellCheck={false}
								maxLength={32}
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={["sign-in-code-help", error ? "sign-in-code-error" : null].filter(Boolean).join(" ")}
							/>
							<FieldDescription id="sign-in-code-help">
								{method === "authenticator" ? t("signIn.secondStep.codeHelp") : t("signIn.secondStep.backupCodeHelp")}
							</FieldDescription>
							{error ? <FieldError id="sign-in-code-error">{t(error)}</FieldError> : null}
						</Field>
						<Button type="submit" disabled={busy || code.trim() === "" || expired} className="w-full">
							{t("signIn.secondStep.submit")}
						</Button>
					</FieldGroup>
				</form>
			) : error ? (
				<FieldError id="sign-in-code-error">{t(error)}</FieldError>
			) : null}
			<div className="grid gap-2">
				{withPasskeys ? (
					<Button type="button" variant="outline" onClick={withPasskey} disabled={busy || expired}>
						<KeyRoundIcon aria-hidden="true" />
						{t("signIn.secondStep.usePasskey")}
					</Button>
				) : null}
				{method === "authenticator" && methods.includes("backupCode") ? (
					<Button type="button" variant="ghost" onClick={() => switchTo("backupCode")}>
						{t("signIn.secondStep.useBackupCode")}
					</Button>
				) : null}
				{method !== "authenticator" && methods.includes("authenticator") ? (
					<Button type="button" variant="ghost" onClick={() => switchTo("authenticator")}>
						{t("signIn.secondStep.useAuthenticator")}
					</Button>
				) : null}
				{method === null && methods.includes("backupCode") ? (
					<Button type="button" variant="ghost" onClick={() => switchTo("backupCode")}>
						{t("signIn.secondStep.useBackupCode")}
					</Button>
				) : null}
				<Button type="button" variant="ghost" onClick={onStartOver}>
					{t("signIn.secondStep.startOver")}
				</Button>
			</div>
		</div>
	);
}
