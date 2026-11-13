import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Separator } from "@webcraft/ui/components/separator.tsx";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtcDate } from "../format.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import {
	AuthenticatorDialog,
	BackupCodesDialog,
	PasskeyDialog,
	usePasskeysAvailable,
	useStartAuthenticator,
} from "./Setup.tsx";

export type TwoFactorState = Awaited<ReturnType<ApiClient["me"]["twoFactor"]["get"]>>;

type Passkey = TwoFactorState["passkeys"][number];

/** What a remove dialog is about: the authenticator app, or one passkey. */
type Removing = { kind: "authenticator" } | { kind: "passkey"; passkey: Passkey };

/**
 * Your account › Two-factor authentication: the authenticator app, passkeys and backup codes. Each
 * change is a Sensitive action; adding or removing a way signs out the person's other sessions and
 * emails them.
 */
export function TwoFactorCard({ state, account }: { state: TwoFactorState; account: string }) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const start = useStartAuthenticator();
	const canUsePasskeys = usePasskeysAvailable();
	const addAppButton = useRef<HTMLButtonElement>(null);
	const addPasskeyButton = useRef<HTMLButtonElement>(null);
	const regenerateButton = useRef<HTMLButtonElement>(null);
	const [pending, setPending] = useState<{ secret: string; uri: string } | null>(null);
	const [addingPasskey, setAddingPasskey] = useState(false);
	const [removing, setRemoving] = useState<Removing | null>(null);
	const [confirmRegenerate, setConfirmRegenerate] = useState(false);
	const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const on = state.authenticator !== null || state.passkeys.length > 0;
	const ways = (state.authenticator ? 1 : 0) + state.passkeys.length;

	const refresh = () => router.invalidate();

	const addApp = async () => {
		setBusy(true);
		setPending(await start());
		setBusy(false);
	};

	const remove = async () => {
		if (!removing) return;
		setBusy(true);
		try {
			const api = await getApi();
			if (removing.kind === "authenticator") await runSensitive(() => api.me.twoFactor.removeAuthenticator());
			else await runSensitive(() => api.me.twoFactor.removePasskey({ passkeyId: removing.passkey.id }));
			toast.success(t("twoFactor.removeDialog.removed"));
			setRemoving(null);
			await refresh();
			document.getElementById("two-factor")?.focus();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	const regenerate = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			const { backupCodes } = await runSensitive(() => api.me.twoFactor.regenerateBackupCodes());
			setConfirmRegenerate(false);
			setFreshCodes(backupCodes);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card id="two-factor" tabIndex={-1} className="outline-none">
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-3">
					<h2>{t("account.twoFactor.heading")}</h2>
					<Badge variant={on ? "secondary" : "outline"}>
						{on ? t("twoFactor.status.on") : t("twoFactor.status.off")}
					</Badge>
					{state.required ? <Badge variant="outline">{t("twoFactor.status.required")}</Badge> : null}
				</CardTitle>
				<CardDescription>{t("account.twoFactor.body")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-6">
				<section aria-labelledby="two-factor-app" className="grid gap-3">
					<h3 id="two-factor-app" className="font-medium">
						{t("twoFactor.authenticator.heading")}
					</h3>
					<p className="text-muted-foreground text-sm">{t("twoFactor.authenticator.intro")}</p>
					{state.authenticator ? (
						<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
							<span>
								{t("twoFactor.authenticator.added", { date: formatUtcDate(state.authenticator.addedAt) })}
								{state.authenticator.lastUsedAt
									? ` · ${t("twoFactor.lastUsed", { date: formatUtcDate(state.authenticator.lastUsedAt) })}`
									: ""}
							</span>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => setRemoving({ kind: "authenticator" })}
								aria-label={t("twoFactor.authenticator.removeLabel")}
							>
								{t("twoFactor.remove")}
							</Button>
						</div>
					) : (
						<div>
							<Button ref={addAppButton} onClick={addApp} disabled={busy}>
								{t("twoFactor.authenticator.add")}
							</Button>
						</div>
					)}
				</section>
				<Separator />
				<section aria-labelledby="two-factor-passkeys" className="grid gap-3">
					<h3 id="two-factor-passkeys" className="font-medium">
						{t("twoFactor.passkeys.heading")}
					</h3>
					<p className="text-muted-foreground text-sm">{t("twoFactor.passkeys.intro")}</p>
					{state.passkeys.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("twoFactor.passkeys.none")}</p>
					) : (
						<ul className="grid gap-2">
							{state.passkeys.map((passkey) => (
								<li
									key={passkey.id}
									className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
								>
									<span className="grid gap-0.5">
										<span className="flex items-center gap-2 font-medium">
											{passkey.name}
											{passkey.synced ? <Badge variant="outline">{t("twoFactor.passkeys.synced")}</Badge> : null}
										</span>
										<span className="text-muted-foreground">
											{t("twoFactor.passkeys.added", { date: formatUtcDate(passkey.addedAt) })} ·{" "}
											{passkey.lastUsedAt
												? t("twoFactor.lastUsed", { date: formatUtcDate(passkey.lastUsedAt) })
												: t("twoFactor.passkeys.neverUsed")}
										</span>
									</span>
									<Button
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() => setRemoving({ kind: "passkey", passkey })}
										aria-label={t("twoFactor.passkeys.removeLabel", { name: passkey.name })}
									>
										{t("twoFactor.remove")}
									</Button>
								</li>
							))}
						</ul>
					)}
					<div className="flex flex-wrap items-center gap-3">
						<Button
							ref={addPasskeyButton}
							variant={state.passkeys.length > 0 || state.authenticator ? "outline" : "default"}
							onClick={() => setAddingPasskey(true)}
							disabled={busy || !canUsePasskeys}
						>
							{t("twoFactor.passkeys.add")}
						</Button>
						{canUsePasskeys ? null : (
							<span className="text-muted-foreground text-sm">{t("twoFactor.passkeys.unavailable")}</span>
						)}
					</div>
				</section>
				{on ? (
					<>
						<Separator />
						<section aria-labelledby="two-factor-backup" className="grid gap-3">
							<h3 id="two-factor-backup" className="font-medium">
								{t("twoFactor.backupCodes.heading")}
							</h3>
							<p className="text-muted-foreground text-sm">{t("twoFactor.backupCodes.intro")}</p>
							<p className="text-sm">{t("twoFactor.backupCodes.left", { count: state.backupCodes.left })}</p>
							<div>
								<Button
									ref={regenerateButton}
									variant="outline"
									onClick={() => setConfirmRegenerate(true)}
									disabled={busy}
								>
									{t("twoFactor.backupCodes.regenerate")}
								</Button>
							</div>
						</section>
					</>
				) : null}
			</CardContent>
			<AuthenticatorDialog
				pending={pending}
				account={account}
				onClose={() => setPending(null)}
				onAdded={refresh}
				finalFocus={addAppButton}
			/>
			<PasskeyDialog
				open={addingPasskey}
				account={account}
				onClose={() => setAddingPasskey(false)}
				onAdded={refresh}
				finalFocus={addPasskeyButton}
			/>
			<Dialog open={removing !== null} onOpenChange={(open) => (open ? undefined : setRemoving(null))}>
				<DialogContent closeLabel={t("twoFactor.removeDialog.close")}>
					<DialogHeader>
						<DialogTitle>
							{removing?.kind === "passkey"
								? t("twoFactor.removeDialog.passkeyTitle", { name: removing.passkey.name })
								: t("twoFactor.removeDialog.authenticatorTitle")}
						</DialogTitle>
						<DialogDescription>
							{ways <= 1 ? t("twoFactor.removeDialog.lastBody") : t("twoFactor.removeDialog.body")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("twoFactor.removeDialog.cancel")}
						</DialogClose>
						<Button variant="destructive" onClick={remove} disabled={busy}>
							{t("twoFactor.removeDialog.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
				<DialogContent closeLabel={t("twoFactor.backupCodes.regenerateDialog.close")} finalFocus={regenerateButton}>
					<DialogHeader>
						<DialogTitle>{t("twoFactor.backupCodes.regenerateDialog.title")}</DialogTitle>
						<DialogDescription>{t("twoFactor.backupCodes.regenerateDialog.body")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("twoFactor.backupCodes.regenerateDialog.cancel")}
						</DialogClose>
						<Button onClick={regenerate} disabled={busy}>
							{t("twoFactor.backupCodes.regenerateDialog.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<BackupCodesDialog
				codes={freshCodes}
				account={account}
				onClose={() => {
					setFreshCodes(null);
					void refresh();
				}}
				finalFocus={regenerateButton}
			/>
		</Card>
	);
}
