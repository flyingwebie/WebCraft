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
import { FieldError } from "@webcraft/ui/components/field.tsx";
import { LoaderIcon, RotateCcwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "./preview.ts";
import { type MediaUses, UsedInList } from "./UsedIn.tsx";

type Asked = { usedIn: MediaUses; confirmation: string };

/**
 * A two-step action behind a button: opening the dialog asks the server first (what it would do, and
 * a confirmation id), and confirming sends the id back.
 */
function useTwoSteps<Result>(ask: () => Promise<Result>) {
	const [asked, setAsked] = useState<Result | null>(null);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const start = async () => {
		setAsked(null);
		setError(null);
		try {
			setAsked(await ask());
		} catch (failure) {
			setError(errorMessage(failure));
		}
	};
	return { asked, error, setError, busy, setBusy, start };
}

/**
 * Delete: asks where the file is used (the warning) and moves it to the Trash once confirmed. Pages
 * stop showing it at once; it can be restored for 30 days.
 */
export function DeleteDialog({
	siteId,
	item,
	onDeleted,
}: {
	siteId: string;
	item: MediaItem;
	onDeleted(): Promise<void>;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const steps = useTwoSteps<Asked>(async () => {
		const answer = await (await getApi()).media.delete({ siteId, mediaId: item.id });
		if (answer.trashed) throw new Error("It was moved without asking.");
		return { usedIn: answer.usedIn, confirmation: answer.confirmation.id };
	});

	const confirm = async () => {
		if (!steps.asked) return;
		steps.setBusy(true);
		try {
			await (await getApi()).media.delete({ siteId, mediaId: item.id, confirmation: steps.asked.confirmation });
			toast.success(t("media.delete.deleted", { name: item.fileName }));
			setOpen(false);
			await onDeleted();
			document.getElementById("main")?.focus();
		} catch (failure) {
			steps.setError(errorMessage(failure));
		} finally {
			steps.setBusy(false);
		}
	};

	return (
		<>
			<Button
				ref={trigger}
				variant="outline"
				onClick={() => {
					setOpen(true);
					void steps.start();
				}}
			>
				<Trash2Icon aria-hidden="true" />
				{t("media.delete.button")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("media.delete.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("media.delete.title", { name: item.fileName })}</DialogTitle>
						<DialogDescription>{t("media.delete.body")}</DialogDescription>
					</DialogHeader>
					{steps.asked === null && steps.error === null ? (
						<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
							<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
							{t("media.delete.checking")}
						</p>
					) : null}
					{steps.asked && steps.asked.usedIn.length > 0 ? (
						<div className="grid gap-2 rounded-lg border border-amber-600 p-3 dark:border-amber-400">
							<p className="flex items-start gap-2 text-sm">
								<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								{t("media.delete.usedWarning", { count: steps.asked.usedIn.length })}
							</p>
							<UsedInList siteId={siteId} usedIn={steps.asked.usedIn} permissions={[]} />
						</div>
					) : null}
					{steps.error ? <FieldError>{t(steps.error)}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("media.delete.cancel")}</DialogClose>
						<Button variant="destructive" onClick={confirm} disabled={!steps.asked || steps.busy}>
							{t("media.delete.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Restore: takes a file out of the Trash, as it was. */
export function RestoreButton({
	siteId,
	item,
	onRestored,
}: {
	siteId: string;
	item: MediaItem;
	onRestored(): Promise<void>;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			variant="outline"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					await (await getApi()).media.restore({ siteId, mediaId: item.id });
					toast.success(t("media.trash.restored", { name: item.fileName }));
					await onRestored();
				} catch (failure) {
					toast.error(t(errorMessage(failure)));
				} finally {
					setBusy(false);
				}
			}}
		>
			<RotateCcwIcon aria-hidden="true" />
			{t("media.trash.restore")}
		</Button>
	);
}

/** Delete for good: a file in the Trash, in two steps. */
export function DeleteForeverDialog({
	siteId,
	item,
	onDeleted,
}: {
	siteId: string;
	item: MediaItem;
	onDeleted(): Promise<void>;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const steps = useTwoSteps<Asked>(async () => {
		const answer = await (await getApi()).media.deleteForever({ siteId, mediaId: item.id });
		if (answer.deleted) throw new Error("It was deleted without asking.");
		return { usedIn: answer.usedIn, confirmation: answer.confirmation.id };
	});
	const confirm = async () => {
		if (!steps.asked) return;
		steps.setBusy(true);
		try {
			await (await getApi()).media.deleteForever({ siteId, mediaId: item.id, confirmation: steps.asked.confirmation });
			toast.success(t("media.trash.deletedForever", { name: item.fileName }));
			setOpen(false);
			await onDeleted();
			document.getElementById("main")?.focus();
		} catch (failure) {
			steps.setError(errorMessage(failure));
		} finally {
			steps.setBusy(false);
		}
	};
	return (
		<>
			<Button
				ref={trigger}
				variant="outline"
				onClick={() => {
					setOpen(true);
					void steps.start();
				}}
			>
				<Trash2Icon aria-hidden="true" />
				{t("media.trash.deleteForever")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("media.delete.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("media.trash.deleteForeverTitle", { name: item.fileName })}</DialogTitle>
						<DialogDescription>{t("media.trash.deleteForeverBody")}</DialogDescription>
					</DialogHeader>
					{steps.error ? <FieldError>{t(steps.error)}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("media.delete.cancel")}</DialogClose>
						<Button variant="destructive" onClick={confirm} disabled={!steps.asked || steps.busy}>
							{t("media.trash.deleteForever")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Empty Trash: every file in it deleted for good, in two steps. */
export function EmptyTrashDialog({ siteId, onEmptied }: { siteId: string; onEmptied(): Promise<void> }) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const steps = useTwoSteps<{ count: number; confirmation: string }>(async () => {
		const answer = await (await getApi()).media.emptyTrash({ siteId });
		if (answer.emptied) throw new Error("It was emptied without asking.");
		return { count: answer.count, confirmation: answer.confirmation.id };
	});
	const confirm = async () => {
		if (!steps.asked) return;
		steps.setBusy(true);
		try {
			await (await getApi()).media.emptyTrash({ siteId, confirmation: steps.asked.confirmation });
			toast.success(t("media.trash.emptied"));
			setOpen(false);
			await onEmptied();
			document.getElementById("main")?.focus();
		} catch (failure) {
			steps.setError(errorMessage(failure));
		} finally {
			steps.setBusy(false);
		}
	};
	return (
		<>
			<Button
				ref={trigger}
				variant="outline"
				onClick={() => {
					setOpen(true);
					void steps.start();
				}}
			>
				<Trash2Icon aria-hidden="true" />
				{t("media.trash.emptyTrash")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("media.delete.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("media.trash.emptyTitle")}</DialogTitle>
						<DialogDescription>
							{steps.asked ? t("media.trash.emptyBody", { count: steps.asked.count }) : t("media.delete.checking")}
						</DialogDescription>
					</DialogHeader>
					{steps.error ? <FieldError>{t(steps.error)}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("media.delete.cancel")}</DialogClose>
						<Button variant="destructive" onClick={confirm} disabled={!steps.asked || steps.busy}>
							{t("media.trash.emptyConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
