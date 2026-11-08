import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
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
	const [password, setPassword] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const close = (confirmed: boolean) => {
		setPassword("");
		setError(null);
		onFinish(confirmed);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.session.confirmIdentity({ password });
			close(true);
		} catch (failure) {
			setError(errorCode(failure) === "INVALID_CREDENTIALS" ? "identityCheck.wrongPassword" : errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : close(false))}>
			{/* Focus goes back to the control that started the action once it is usable: see `run`. */}
			<DialogContent closeLabel={t("identityCheck.cancel")} finalFocus={false}>
				<form onSubmit={submit} noValidate className="grid gap-6">
					<DialogHeader>
						<DialogTitle>{t("identityCheck.title")}</DialogTitle>
						<DialogDescription>{t("identityCheck.body")}</DialogDescription>
					</DialogHeader>
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
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => close(false)}>
							{t("identityCheck.cancel")}
						</Button>
						<Button type="submit" disabled={busy || password === ""}>
							{t("identityCheck.confirm")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
