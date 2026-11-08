import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@webcraft/ui/components/dialog.tsx";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * Asks the Superadmin to keep a copy of the Master key outside the server, until they confirm they
 * have. Shown at the top of every admin page.
 */
export function MasterKeyBanner() {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	const confirm = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.install.masterKey.confirmStored();
			toast.success(t("masterKeyBanner.confirmed"));
			await router.invalidate();
			// The banner and its buttons are gone: keep keyboard focus on the page, not lost.
			document.getElementById("main")?.focus();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="border-warning-border bg-warning text-warning-foreground flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center">
			<KeyRoundIcon className="hidden size-6 shrink-0 md:block" aria-hidden="true" />
			<div className="flex-1 space-y-1">
				<p className="font-semibold">{t("masterKeyBanner.title")}</p>
				<p className="text-sm">{t("masterKeyBanner.body")}</p>
			</div>
			<div className="flex shrink-0 gap-2">
				<MasterKeyHelp />
				<Button onClick={confirm} disabled={busy}>
					{t("masterKeyBanner.confirm")}
				</Button>
			</div>
		</div>
	);
}

/** "How to back up": the steps, and the running key's fingerprint. */
function MasterKeyHelp() {
	const t = useT();
	const [fingerprint, setFingerprint] = useState<string | null>(null);

	const load = async (open: boolean) => {
		if (!open || fingerprint) return;
		const api = await getApi();
		setFingerprint((await api.install.masterKey.status()).fingerprint);
	};

	return (
		<Dialog onOpenChange={load}>
			<DialogTrigger render={<Button variant="outline" className="bg-background text-foreground" />}>
				{t("masterKeyBanner.howTo")}
			</DialogTrigger>
			<DialogContent closeLabel={t("masterKeyBanner.dialog.close")} className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("masterKeyBanner.dialog.title")}</DialogTitle>
					<DialogDescription>{t("masterKeyBanner.dialog.intro")}</DialogDescription>
				</DialogHeader>
				<ol className="list-decimal space-y-2 ps-5">
					<li>{t("masterKeyBanner.dialog.stepCopy")}</li>
					<li>{t("masterKeyBanner.dialog.stepStore")}</li>
					<li>{t("masterKeyBanner.dialog.stepSecret")}</li>
				</ol>
				<div className="space-y-1">
					<p className="font-medium">{t("masterKeyBanner.dialog.fingerprint")}</p>
					<p className="font-mono text-xs break-all">{fingerprint ?? "…"}</p>
					<p className="text-muted-foreground text-xs">{t("masterKeyBanner.dialog.fingerprintHelp")}</p>
				</div>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("masterKeyBanner.dialog.close")}</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
