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
} from "@webcraft/ui/components/dialog.tsx";
import { type RefObject, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";

/**
 * Asks before resetting someone's two-factor authentication: their authenticator app, passkeys and
 * backup codes go, and every session of theirs ends. A Sensitive action.
 */
export function ResetTwoFactorDialog({
	name,
	open,
	onOpenChange,
	finalFocus,
	reset,
}: {
	name: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	finalFocus: RefObject<HTMLElement | null>;
	reset: () => Promise<unknown>;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [busy, setBusy] = useState(false);
	const confirm = async () => {
		setBusy(true);
		try {
			await runSensitive(reset);
			toast.success(t("twoFactor.reset.done", { name }));
			onOpenChange(false);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("twoFactor.reset.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("twoFactor.reset.title", { name })}</DialogTitle>
					<DialogDescription>{t("twoFactor.reset.body", { name })}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("twoFactor.reset.cancel")}</DialogClose>
					<Button variant="destructive" onClick={confirm} disabled={busy}>
						{t("twoFactor.reset.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
