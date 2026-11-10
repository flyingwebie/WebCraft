import { useRouteContext } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { KeyRoundIcon } from "lucide-react";
import {
	createContext,
	type FormEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

import { getApi } from "./api.ts";
import { errorCode, errorMessage } from "./errors.ts";
import { type MessageKey, useT } from "./i18n.tsx";
import { PasswordInput } from "./PasswordInput.tsx";
import { getPasskey, PasskeyCancelledError, passkeysAvailable } from "./two-factor/passkeys.ts";

/** The person closed "Confirm it's you" without confirming: nothing was changed. */
export class IdentityCheckCancelledError extends Error {
	override name = "IdentityCheckCancelledError";
	readonly code = "IDENTITY_CHECK_CANCELLED";
	constructor() {
		super("Nothing was changed: the person didn't confirm who they are.");
	}
}

type RunSensitive = <Result>(action: () => Promise<Result>) => Promise<Result>;

const IdentityCheckContext = createContext<RunSensitive | null>(null);

/**
 * Runs a Sensitive action from the admin: when the Management API answers that it needs a recent
 * identity check (`IDENTITY_CHECK_REQUIRED`), asks for the person's password in "Confirm it's you",
 * then tries again. Closing the dialog rejects with `IdentityCheckCancelledError`, which
 * `errorMessage` shows like any other refusal.
 *
 *     const runSensitive = useSensitiveAction();
 *     await runSensitive(async () => (await getApi()).staff.invite(input));
 */
export function useSensitiveAction(): RunSensitive {
	const run = useContext(IdentityCheckContext);
	if (!run) throw new Error("useSensitiveAction needs an IdentityCheckProvider above it.");
	return run;
}

/** Makes "Confirm it's you" available to every page below it. The root route puts it around the admin. */
export function IdentityCheckProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const answer = useRef<((confirmed: boolean) => void) | null>(null);
	// The control focused last, such as the Save button that started an action: it is usually
	// disabled (and so loses focus) while the action runs, so focus goes back to it afterwards.
	const lastFocused = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const remember = (event: FocusEvent) => {
			if (event.target instanceof HTMLElement && event.target !== document.body) lastFocused.current = event.target;
		};
		document.addEventListener("focusin", remember);
		return () => document.removeEventListener("focusin", remember);
	}, []);

	const ask = useCallback(
		() =>
			new Promise<boolean>((resolve) => {
				answer.current = resolve;
				setOpen(true);
			}),
		[],
	);

	const finish = useCallback((confirmed: boolean) => {
		setOpen(false);
		answer.current?.(confirmed);
		answer.current = null;
	}, []);

	const run = useCallback<RunSensitive>(
		async (action) => {
			try {
				return await action();
			} catch (error) {
				if (errorCode(error) !== "IDENTITY_CHECK_REQUIRED") throw error;
				const returnTo = lastFocused.current;
				const confirmed = await ask();
				try {
					if (!confirmed) throw new IdentityCheckCancelledError();
					return await action();
				} finally {
					refocusWhenUsable(returnTo);
				}
			}
		},
		[ask],
	);

	return (
		<IdentityCheckContext.Provider value={run}>
			{children}
			<IdentityCheckDialog open={open} onFinish={finish} />
		</IdentityCheckContext.Provider>
	);
}

/** Moves focus back to `element` once it is enabled again, unless it left the page (a panel closed). */
function refocusWhenUsable(element: HTMLElement | null): void {
	if (!element) return;
	let frames = 0;
	const attempt = () => {
		if (!element.isConnected) return;
		if (!element.matches(":disabled")) {
			element.focus();
			return;
		}
		if (++frames < 120) requestAnimationFrame(attempt);
	};
	requestAnimationFrame(attempt);
}

function IdentityCheckDialog({ open, onFinish }: { open: boolean; onFinish: (confirmed: boolean) => void }) {
	const t = useT();
	const { shell } = useRouteContext({ from: "__root__" });
	const methods = shell.twoFactor?.methods ?? [];
	const [way, setWay] = useState<"password" | "authenticator">("password");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const withPasskey = methods.includes("passkey") && open && passkeysAvailable();

	const close = (confirmed: boolean) => {
		setPassword("");
		setCode("");
		setError(null);
		setWay("password");
		onFinish(confirmed);
	};

	const wrong = (failure: unknown): MessageKey => {
		const failed = errorCode(failure);
		if (failed === "INVALID_CREDENTIALS") return "identityCheck.wrongPassword";
		if (failed === "TWO_FACTOR_CODE_INVALID") return "identityCheck.wrongCode";
		if (failure instanceof PasskeyCancelledError) return "identityCheck.passkeyCancelled";
		return errorMessage(failure);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.session.confirmIdentity(way === "password" ? { password } : { authenticatorCode: code });
			close(true);
		} catch (failure) {
			setError(wrong(failure));
		} finally {
			setBusy(false);
		}
	};

	const confirmWithPasskey = async () => {
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { options } = await api.session.identityPasskeyOptions();
			await api.session.confirmIdentity({ passkey: await getPasskey(options) });
			close(true);
		} catch (failure) {
			setError(wrong(failure));
		} finally {
			setBusy(false);
		}
	};

	const switchTo = (next: "password" | "authenticator") => {
		setWay(next);
		setError(null);
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : close(false))}>
			{/* Focus goes back to the control that started the action once it is usable: see `run`. */}
			<DialogContent closeLabel={t("identityCheck.cancel")} finalFocus={false}>
				<form onSubmit={submit} noValidate className="grid gap-6">
					<DialogHeader>
						<DialogTitle>{t("identityCheck.title")}</DialogTitle>
						<DialogDescription>
							{way === "password" ? t("identityCheck.body") : t("identityCheck.bodyAuthenticator")}
						</DialogDescription>
					</DialogHeader>
					{way === "password" ? (
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="identity-check-password">{t("identityCheck.password")}</FieldLabel>
							<PasswordInput
								id="identity-check-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="current-password"
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "identity-check-error" : undefined}
							/>
							{error ? <FieldError id="identity-check-error">{t(error)}</FieldError> : null}
						</Field>
					) : (
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="identity-check-code">{t("identityCheck.code")}</FieldLabel>
							<Input
								id="identity-check-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={12}
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={["identity-check-code-help", error ? "identity-check-error" : null]
									.filter(Boolean)
									.join(" ")}
							/>
							<FieldDescription id="identity-check-code-help">{t("identityCheck.codeHelp")}</FieldDescription>
							{error ? <FieldError id="identity-check-error">{t(error)}</FieldError> : null}
						</Field>
					)}
					{withPasskey || methods.includes("authenticator") ? (
						<div className="flex flex-col items-start gap-1">
							{withPasskey ? (
								<Button type="button" variant="outline" onClick={confirmWithPasskey} disabled={busy}>
									<KeyRoundIcon aria-hidden="true" />
									{t("identityCheck.usePasskey")}
								</Button>
							) : null}
							{methods.includes("authenticator") ? (
								<Button
									type="button"
									variant="ghost"
									onClick={() => switchTo(way === "password" ? "authenticator" : "password")}
								>
									{way === "password" ? t("identityCheck.useAuthenticator") : t("identityCheck.usePassword")}
								</Button>
							) : null}
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => close(false)}>
							{t("identityCheck.cancel")}
						</Button>
						<Button type="submit" disabled={busy || (way === "password" ? password === "" : code.trim() === "")}>
							{t("identityCheck.confirm")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
