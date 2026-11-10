import { useNavigate } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { useState } from "react";
import { toast } from "sonner";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
export function RemoveImport({ siteId, importId }: { siteId: string; importId: string }) {
	const t = useT();
	const navigate = useNavigate();
	const [confirmation, setConfirmation] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	async function remove(confirm?: string) {
		setBusy(true);
		try {
			const result = await (await getApi()).imports.remove({ siteId, importId, confirmation: confirm });
			if (!result.removed) setConfirmation(result.confirmation.id);
			else {
				setConfirmation(null);
				toast.success(t("imports.live.removed"));
				await navigate({ to: "/sites/$siteId/imports", params: { siteId } });
			}
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Button variant="outline" disabled={busy} onClick={() => void remove()}>
				{t("imports.live.remove")}
			</Button>
			<Dialog
				open={confirmation !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmation(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("imports.live.remove")}</DialogTitle>
						<DialogDescription>{t("imports.live.removeHelp")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() => {
								if (confirmation) void remove(confirmation);
							}}
						>
							{t("imports.live.remove")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
