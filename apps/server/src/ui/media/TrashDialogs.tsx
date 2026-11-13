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
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "./preview.ts";
import { type MediaUses, UsedInList } from "./UsedIn.tsx";

type Asked = { usedIn: MediaUses; confirmation: string };

/**
 * A two-step action behind a button: opening the dialog asks the server first (what it would do, and
 * a confirmation id), and confirming sends the id back with `go`. Once it went ahead: `done` as a
 * toast, the dialog closed, `after`, and the focus on the page's main content (the trigger may be
 * gone).
 */
function TwoStepDialog<Answer extends { confirmation: string }>({
	label,
	title,
	description,
	confirmLabel,
	done,
	ask,
	go,
	after,
	children,
}: {
	label: string;
	title: string;
	description(asked: Answer | null): ReactNode;
	confirmLabel: string;
	done: string;
	ask(): Promise<Answer>;
	go(confirmation: string): Promise<unknown>;
	after(): Promise<void>;
	/** What the dialog shows between its description and its buttons, once asked. */
	children?(state: { asked: Answer | null; failed: boolean }): ReactNode;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [asked, setAsked] = useState<Answer | null>(null);
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

	const confirm = async () => {
		if (!asked) return;
		setBusy(true);
		try {
			await go(asked.confirmation);
			toast.success(done);
			setOpen(false);
			await after();
			document.getElementById("main")?.focus();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button
				ref={trigger}
				variant="outline"
				onClick={() => {
					setOpen(true);
					void start();
				}}
			>
				<Trash2Icon aria-hidden="true" />
				{label}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("media.delete.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description(asked)}</DialogDescription>
					</DialogHeader>
					{children?.({ asked, failed: error !== null })}
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("media.delete.cancel")}</DialogClose>
						<Button variant="destructive" onClick={confirm} disabled={!asked || busy}>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
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
	return (
		<TwoStepDialog<Asked>
			label={t("media.delete.button")}
			title={t("media.delete.title", { name: item.fileName })}
			description={() => t("media.delete.body")}
			confirmLabel={t("media.delete.confirm")}
			done={t("media.delete.deleted", { name: item.fileName })}
			ask={async () => {
				const answer = await (await getApi()).media.delete({ siteId, mediaId: item.id });
				if (answer.trashed) throw new Error("It was moved without asking.");
				return { usedIn: answer.usedIn, confirmation: answer.confirmation.id };
			}}
			go={async (confirmation) => (await getApi()).media.delete({ siteId, mediaId: item.id, confirmation })}
			after={onDeleted}
		>
			{({ asked, failed }) => (
				<>
					{asked === null && !failed ? (
						<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
							<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
							{t("media.delete.checking")}
						</p>
					) : null}
					{asked && asked.usedIn.length > 0 ? (
						<div className="grid gap-2 rounded-lg border border-amber-600 p-3 dark:border-amber-400">
							<p className="flex items-start gap-2 text-sm">
								<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								{t("media.delete.usedWarning", { count: asked.usedIn.length })}
							</p>
							<UsedInList siteId={siteId} usedIn={asked.usedIn} permissions={[]} />
						</div>
					) : null}
				</>
			)}
		</TwoStepDialog>
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
	return (
		<TwoStepDialog<Asked>
			label={t("media.trash.deleteForever")}
			title={t("media.trash.deleteForeverTitle", { name: item.fileName })}
			description={() => t("media.trash.deleteForeverBody")}
			confirmLabel={t("media.trash.deleteForever")}
			done={t("media.trash.deletedForever", { name: item.fileName })}
			ask={async () => {
				const answer = await (await getApi()).media.deleteForever({ siteId, mediaId: item.id });
				if (answer.deleted) throw new Error("It was deleted without asking.");
				return { usedIn: answer.usedIn, confirmation: answer.confirmation.id };
			}}
			go={async (confirmation) => (await getApi()).media.deleteForever({ siteId, mediaId: item.id, confirmation })}
			after={onDeleted}
		/>
	);
}

/** Empty Trash: every file in it deleted for good, in two steps. */
export function EmptyTrashDialog({ siteId, onEmptied }: { siteId: string; onEmptied(): Promise<void> }) {
	const t = useT();
	return (
		<TwoStepDialog<{ count: number; confirmation: string }>
			label={t("media.trash.emptyTrash")}
			title={t("media.trash.emptyTitle")}
			description={(asked) => (asked ? t("media.trash.emptyBody", { count: asked.count }) : t("media.delete.checking"))}
			confirmLabel={t("media.trash.emptyConfirm")}
			done={t("media.trash.emptied")}
			ask={async () => {
				const answer = await (await getApi()).media.emptyTrash({ siteId });
				if (answer.emptied) throw new Error("It was emptied without asking.");
				return { count: answer.count, confirmation: answer.confirmation.id };
			}}
			go={async (confirmation) => (await getApi()).media.emptyTrash({ siteId, confirmation })}
			after={onEmptied}
		/>
	);
}
