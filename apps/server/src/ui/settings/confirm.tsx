import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { type ReactNode, type RefObject, useRef, useState } from "react";

import { useT } from "../i18n.tsx";

/**
 * Asks before a destructive action in a settings list (remove a domain, revoke a token): a dialog
 * that names the thing and what happens, focus on Cancel. `onConfirm` runs the action; the dialog
 * stays open while it runs and closes after.
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	children,
	confirm,
	onConfirm,
	finalFocus,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Names the thing: "Remove acmebakery.shop?" */
	title: string;
	/** What happens, and where the thing is used. */
	children?: ReactNode;
	/** The destructive button's words: "Remove", "Revoke". */
	confirm: string;
	onConfirm: () => Promise<unknown> | unknown;
	/** What takes focus when the dialog closes, when it is not what opened it (a menu item). */
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const cancel = useRef<HTMLButtonElement>(null);
	const [busy, setBusy] = useState(false);
	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent
				closeLabel={t("shell.leaveGuard.close")}
				initialFocus={cancel}
				finalFocus={finalFocus}
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{children ? <DialogDescription render={<div />}>{children}</DialogDescription> : null}
				</DialogHeader>
				<DialogFooter>
					<Button ref={cancel} type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						{t("settingsLayout.cancel")}
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onConfirm();
							} finally {
								setBusy(false);
								onOpenChange(false);
							}
						}}
					>
						{confirm}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
