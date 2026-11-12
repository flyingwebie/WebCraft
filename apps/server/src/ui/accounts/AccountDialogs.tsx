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

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";

/**
 * What the Superadmin does about someone who left: end their Staff role (`removeStaff`), deactivate
 * their account so they can no longer sign in, or reactivate it. Each is a Sensitive action.
 */
export type AccountChange = "removeStaff" | "deactivate" | "reactivate";

/** Asks before the change, saying what ends with it, then makes it. */
export function AccountChangeDialog({
	change,
	person,
	open,
	onOpenChange,
	finalFocus,
}: {
	change: AccountChange;
	person: { id: string; name: string };
	open: boolean;
	onOpenChange: (open: boolean) => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [busy, setBusy] = useState(false);
	const { name } = person;
	const confirm = async () => {
		setBusy(true);
		try {
			await runSensitive(async () => {
				const api = await getApi();
				if (change === "removeStaff") await api.staff.remove({ personId: person.id });
				else if (change === "deactivate") await api.accounts.deactivate({ personId: person.id });
				else await api.accounts.reactivate({ personId: person.id });
			});
			toast.success(t(`accounts.${change}.done`, { name }));
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
			<DialogContent closeLabel={t("accounts.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t(`accounts.${change}.title`, { name })}</DialogTitle>
					<DialogDescription>{t(`accounts.${change}.body`, { name })}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("accounts.cancel")}</DialogClose>
					<Button variant={change === "reactivate" ? "default" : "destructive"} onClick={confirm} disabled={busy}>
						{t(`accounts.${change}.confirm`)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
