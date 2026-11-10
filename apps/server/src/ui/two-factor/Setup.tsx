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
import { CopyIcon, DownloadIcon, KeyRoundIcon, SmartphoneIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { createPasskey, PasskeyCancelledError, passkeysAvailable } from "./passkeys.ts";
import { QrCode } from "./QrCode.tsx";

/**
 * Whether this browser can use passkeys: known only once the page runs in the browser, so the page
 * the server renders first says no and the browser's says yes, without a hydration mismatch.
 */
export function usePasskeysAvailable(): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => setAvailable(passkeysAvailable()), []);
	return available;
}

/** An authenticator app being added: its secret as text and in its QR code's address. */
type PendingAuthenticator = { secret: string; uri: string };

/** Splits a key into groups of 4 characters, as people copy it into an app by hand. */
function grouped(secret: string): string {
	return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** Copies text, with the Clipboard API where it can, else the copy command. */
async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.className = "fixed -start-[9999px]";
	document.body.append(area);
	area.select();
	document.execCommand("copy");
	area.remove();
}

/**
 * Shows backup codes once: a list to read, Download (a text file) and Copy. They are never shown
 * again, so the person says they saved them to go on.
 */
export function BackupCodes({ codes, account, onDone }: { codes: readonly string[]; account: string; onDone(): void }) {
	const t = useT();
	const listId = useId();
	const text = [t("twoFactor.backupCodes.show.fileHeading", { account }), "", ...codes, ""].join("\n");

	const download = () => {
		const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = "webcraft-backup-codes.txt";
		document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	const copy = async () => {
		await copyText(codes.join("\n"));
		toast.success(t("twoFactor.backupCodes.show.copied"));
	};

	return (
		<div className="grid gap-4">
			<p id={`${listId}-label`} className="font-medium">
				{t("twoFactor.backupCodes.show.listLabel")}
			</p>
			<ul
				aria-labelledby={`${listId}-label`}
				className="bg-muted grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg p-4 font-mono text-sm"
			>
				{codes.map((code) => (
					<li key={code}>{code}</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-2">
				<Button type="button" variant="outline" onClick={download}>
					<DownloadIcon aria-hidden="true" />
					{t("twoFactor.backupCodes.show.download")}
				</Button>
				<Button type="button" variant="outline" onClick={copy}>
					<CopyIcon aria-hidden="true" />
					{t("twoFactor.backupCodes.show.copy")}
				</Button>
			</div>
			<DialogFooter>
				<Button type="button" onClick={onDone}>
					{t("twoFactor.backupCodes.show.done")}
				</Button>
			</DialogFooter>
		</div>
	);
}

/** A dialog that shows backup codes made just now (Your account › Make new backup codes). */
export function BackupCodesDialog({
	codes,
	account,
	onClose,
	finalFocus,
}: {
	codes: readonly string[] | null;
	account: string;
	onClose(): void;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	return (
		<Dialog open={codes !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent closeLabel={t("twoFactor.backupCodes.show.close")} finalFocus={finalFocus} className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("twoFactor.backupCodes.show.title")}</DialogTitle>
					<DialogDescription>{t("twoFactor.backupCodes.show.body")}</DialogDescription>
				</DialogHeader>
				{codes ? <BackupCodes codes={codes} account={account} onDone={onClose} /> : null}
			</DialogContent>
		</Dialog>
	);
}

/**
 * Adding an authenticator app: a QR code and the same key as text, then a code from the app. When
 * it is the person's first second factor, their backup codes follow.
 */
export function AuthenticatorDialog({
	pending,
	account,
	onClose,
	onAdded,
	finalFocus,
}: {
	/** The secret `me.twoFactor.startAuthenticator` answered; the dialog is open while there is one. */
	pending: PendingAuthenticator | null;
	account: string;
	onClose(): void;
	onAdded(): void | Promise<void>;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const [code, setCode] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

	const close = () => {
		setCode("");
		setError(null);
		setBackupCodes(null);
		onClose();
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const result = await runSensitive(() => api.me.twoFactor.confirmAuthenticator({ code }));
			toast.success(t("twoFactor.setupDialog.added"));
			if (result.backupCodes) setBackupCodes(result.backupCodes);
			else {
				close();
				await onAdded();
			}
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const finish = async () => {
		close();
		await onAdded();
	};

	const copyKey = async () => {
		if (!pending) return;
		await copyText(pending.secret);
		toast.success(t("twoFactor.setupDialog.copied"));
	};

	return (
		<Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : backupCodes ? finish() : close())}>
			<DialogContent closeLabel={t("twoFactor.setupDialog.close")} finalFocus={finalFocus} className="sm:max-w-lg">
				{backupCodes ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("twoFactor.backupCodes.show.title")}</DialogTitle>
							<DialogDescription>{t("twoFactor.backupCodes.show.body")}</DialogDescription>
						</DialogHeader>
						<BackupCodes codes={backupCodes} account={account} onDone={finish} />
					</>
				) : pending ? (
					<form onSubmit={submit} noValidate className="grid gap-6">
						<DialogHeader>
							<DialogTitle>{t("twoFactor.setupDialog.title")}</DialogTitle>
							<DialogDescription>{t("twoFactor.setupDialog.scan")}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
							<QrCode value={pending.uri} label={t("twoFactor.setupDialog.qrLabel", { account })} />
							<div className="grid min-w-0 gap-2">
								<p>{t("twoFactor.setupDialog.manual")}</p>
								<p id="authenticator-key" className="font-mono text-sm break-all">
									{grouped(pending.secret)}
								</p>
								<div>
									<Button type="button" variant="outline" size="sm" onClick={copyKey}>
										<CopyIcon aria-hidden="true" />
										{t("twoFactor.setupDialog.copyKey")}
									</Button>
								</div>
							</div>
						</div>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="authenticator-code">{t("twoFactor.setupDialog.code")}</FieldLabel>
							<Input
								id="authenticator-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={12}
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={["authenticator-code-help", error ? "authenticator-code-error" : null]
									.filter(Boolean)
									.join(" ")}
							/>
							<FieldDescription id="authenticator-code-help">{t("twoFactor.setupDialog.codeHelp")}</FieldDescription>
							{error ? <FieldError id="authenticator-code-error">{t(error)}</FieldError> : null}
						</Field>
						<DialogFooter>
							<Button type="button" variant="outline" onClick={close}>
								{t("twoFactor.setupDialog.cancel")}
							</Button>
							<Button type="submit" disabled={busy || code.trim() === ""}>
								{t("twoFactor.setupDialog.confirm")}
							</Button>
						</DialogFooter>
					</form>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** Starts adding an authenticator app (a Sensitive action) and answers its secret, or null when cancelled. */
export function useStartAuthenticator() {
	const t = useT();
	const runSensitive = useSensitiveAction();
	return async (): Promise<PendingAuthenticator | null> => {
		try {
			const api = await getApi();
			return await runSensitive(() => api.me.twoFactor.startAuthenticator());
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			return null;
		}
	};
}

/**
 * Adding a passkey: its name, then the browser's own prompt. When it is the person's first second
 * factor, their backup codes follow.
 */
export function PasskeyDialog({
	open,
	account,
	onClose,
	onAdded,
	finalFocus,
}: {
	open: boolean;
	account: string;
	onClose(): void;
	onAdded(): void | Promise<void>;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const [name, setName] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

	const close = () => {
		setName("");
		setError(null);
		setBackupCodes(null);
		onClose();
	};

	const finish = async () => {
		close();
		await onAdded();
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { options } = await runSensitive(() => api.me.twoFactor.passkeyOptions());
			const credential = await createPasskey(options);
			const result = await runSensitive(() =>
				api.me.twoFactor.addPasskey({
					credential,
					name: name.trim() || t("twoFactor.passkeys.nameDialog.defaultName"),
				}),
			);
			toast.success(t("twoFactor.passkeys.addedToast"));
			if (result.backupCodes) setBackupCodes(result.backupCodes);
			else await finish();
		} catch (failure) {
			setError(failure instanceof PasskeyCancelledError ? "twoFactor.passkeys.cancelled" : errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : backupCodes ? finish() : close())}>
			<DialogContent
				closeLabel={t("twoFactor.passkeys.nameDialog.close")}
				finalFocus={finalFocus}
				className="sm:max-w-lg"
			>
				{backupCodes ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("twoFactor.backupCodes.show.title")}</DialogTitle>
							<DialogDescription>{t("twoFactor.backupCodes.show.body")}</DialogDescription>
						</DialogHeader>
						<BackupCodes codes={backupCodes} account={account} onDone={finish} />
					</>
				) : (
					<form onSubmit={submit} noValidate className="grid gap-6">
						<DialogHeader>
							<DialogTitle>{t("twoFactor.passkeys.nameDialog.title")}</DialogTitle>
							<DialogDescription>{t("twoFactor.passkeys.nameDialog.body")}</DialogDescription>
						</DialogHeader>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="passkey-name">{t("twoFactor.passkeys.nameDialog.name")}</FieldLabel>
							<Input
								id="passkey-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder={t("twoFactor.passkeys.nameDialog.defaultName")}
								maxLength={100}
								autoComplete="off"
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "passkey-name-error" : undefined}
							/>
							{error ? <FieldError id="passkey-name-error">{t(error)}</FieldError> : null}
						</Field>
						<DialogFooter>
							<Button type="button" variant="outline" onClick={close}>
								{t("twoFactor.passkeys.nameDialog.cancel")}
							</Button>
							<Button type="submit" disabled={busy}>
								{t("twoFactor.passkeys.nameDialog.continue")}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * The two ways to set up two-factor authentication, side by side: an authenticator app or a
 * passkey. Used by the setup wizard and by the screen a person who must set it up lands on.
 */
export function TwoFactorSetupChoices({ account, onAdded }: { account: string; onAdded(): void | Promise<void> }) {
	const t = useT();
	const start = useStartAuthenticator();
	const [pending, setPending] = useState<PendingAuthenticator | null>(null);
	const [addingPasskey, setAddingPasskey] = useState(false);
	const [busy, setBusy] = useState(false);
	const canUsePasskeys = usePasskeysAvailable();

	const addApp = async () => {
		setBusy(true);
		setPending(await start());
		setBusy(false);
	};

	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<div className="flex flex-col gap-3 rounded-lg border p-4">
				<SmartphoneIcon className="text-muted-foreground size-5" aria-hidden="true" />
				<h2 className="font-medium">{t("twoFactor.setup.authenticatorTitle")}</h2>
				<p className="text-muted-foreground flex-1 text-sm">{t("twoFactor.setup.authenticatorBody")}</p>
				<div>
					<Button type="button" onClick={addApp} disabled={busy}>
						{t("twoFactor.setup.authenticatorAction")}
					</Button>
				</div>
			</div>
			<div className="flex flex-col gap-3 rounded-lg border p-4">
				<KeyRoundIcon className="text-muted-foreground size-5" aria-hidden="true" />
				<h2 className="font-medium">{t("twoFactor.setup.passkeyTitle")}</h2>
				<p className="text-muted-foreground flex-1 text-sm">
					{canUsePasskeys ? t("twoFactor.setup.passkeyBody") : t("twoFactor.passkeys.unavailable")}
				</p>
				<div>
					<Button type="button" variant="outline" onClick={() => setAddingPasskey(true)} disabled={!canUsePasskeys}>
						{t("twoFactor.setup.passkeyAction")}
					</Button>
				</div>
			</div>
			<AuthenticatorDialog pending={pending} account={account} onClose={() => setPending(null)} onAdded={onAdded} />
			<PasskeyDialog open={addingPasskey} account={account} onClose={() => setAddingPasskey(false)} onAdded={onAdded} />
		</div>
	);
}
