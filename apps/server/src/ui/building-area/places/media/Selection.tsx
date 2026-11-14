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
import { DownloadIcon, FolderInputIcon, LoaderIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../errors.ts";
import { type MessageKey, useT } from "../../../i18n.tsx";
import type { MediaApi, MediaUse } from "../../../media/host.tsx";
import type { Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import type { ListedMediaItem, MediaFoldersData } from "./data.ts";
import { FolderMenu, RowButton } from "./parts.tsx";
import { notify } from "./toasts.tsx";

const BAR_BUTTON = `text-chrome-text hover:bg-chrome-hover inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium whitespace-nowrap ${CHROME_EASE} ${FOCUS_RING}`;

/**
 * The selection bar (`places-assets/03`), over the foot of the list while files are selected: clear
 * the selection, how many are selected, Select all; then Move to Folder, Download and Delete for
 * every file selected.
 */
export function SelectionBar({
	words,
	count,
	total,
	folders,
	canMove,
	onClear,
	onSelectAll,
	onMove,
	onDownload,
	onDelete,
}: {
	words: Words;
	count: number;
	/** How many files are listed (Select all selects them). */
	total: number;
	folders: MediaFoldersData;
	/** Whether the person may change every file selected. */
	canMove: boolean;
	onClear(): void;
	onSelectAll(): void;
	onMove(folderId: string | null): void;
	onDownload(): void;
	onDelete(): void;
}) {
	const t = useT();
	return (
		<fieldset
			className="border-chrome-hover bg-chrome-menu absolute inset-x-0 bottom-12 z-20 m-0 mx-auto flex h-[42px] w-fit min-w-0 items-center gap-1 rounded-[10px] border px-1.5 py-0 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
			data-wc-media-selection=""
		>
			<legend className="sr-only">{t("media.selection.label")}</legend>
			<RowButton icon={XIcon} label={t("media.selection.clear")} onClick={onClear} />
			<span className="text-chrome-strong px-1.5 text-[12px] font-semibold whitespace-nowrap" aria-live="polite">
				{t("media.selection.count", { count })}
			</span>
			{count < total ? (
				<button
					type="button"
					onClick={onSelectAll}
					className={`text-chrome-accent rounded-sm px-1 text-[12px] font-medium whitespace-nowrap hover:underline ${FOCUS_RING}`}
				>
					{words.media.selectAll}
				</button>
			) : null}
			<span aria-hidden="true" className="bg-chrome-line mx-1.5 h-5 w-px" />
			{canMove ? (
				<FolderMenu
					words={words}
					folders={folders}
					side="top"
					align="start"
					onChoose={onMove}
					trigger={({ buttonRef, expanded, controls, toggle }) => (
						<button
							ref={buttonRef}
							type="button"
							aria-haspopup="menu"
							aria-expanded={expanded}
							aria-controls={controls}
							onClick={toggle}
							className={BAR_BUTTON}
							data-wc-media-selection-move=""
						>
							<FolderInputIcon aria-hidden="true" className="size-3.5" />
							{t("media.selection.move")}
						</button>
					)}
				/>
			) : null}
			<button type="button" onClick={onDownload} className={BAR_BUTTON}>
				<DownloadIcon aria-hidden="true" className="size-3.5" />
				{t("media.details.download")}
			</button>
			{canMove ? (
				<button
					type="button"
					onClick={onDelete}
					className={`${BAR_BUTTON} text-chrome-danger hover:text-chrome-danger`}
					data-wc-media-selection-delete=""
				>
					<Trash2Icon aria-hidden="true" className="size-3.5" />
					{t("media.delete.button")}
				</button>
			) : null}
		</fieldset>
	);
}

/** Saves each file the browser's way, one after another (a browser may ask before saving several). */
export function downloadAll(items: readonly ListedMediaItem[]): void {
	items.forEach((item, index) => {
		if (!item.url) return;
		setTimeout(() => {
			const link = document.createElement("a");
			link.href = item.url ?? "";
			link.download = item.fileName;
			link.rel = "noopener";
			document.body.append(link);
			link.click();
			link.remove();
		}, index * 250);
	});
}

type Asked = { item: ListedMediaItem; usedIn: MediaUse[]; confirmation: string };

/**
 * Delete for one or several files (a row's Delete, the selection bar's): asks the server first where
 * each is used (`media.delete` without a confirmation changes nothing), says which are in use, and
 * moves them all to the Trash once confirmed, each with its own confirmation. Focus starts on Cancel.
 */
export function DeleteFilesDialog({
	api,
	siteId,
	items,
	onOpenChange,
	finalFocus,
	onDeleted,
}: {
	api: MediaApi;
	siteId: string;
	/** The files to delete; the dialog is open while there are some. */
	items: readonly ListedMediaItem[];
	onOpenChange(open: boolean): void;
	finalFocus: RefObject<HTMLElement | null>;
	onDeleted(ids: readonly string[]): Promise<void>;
}) {
	const t = useT();
	const [asked, setAsked] = useState<Asked[] | null>(null);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const cancel = useRef<HTMLButtonElement>(null);
	const open = items.length > 0;
	const key = items.map((item) => item.id).join(",");

	// biome-ignore lint/correctness/useExhaustiveDependencies: asked again for another set of files (`key`).
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setAsked(null);
		setError(null);
		void (async () => {
			try {
				const answers = await Promise.all(
					items.map(async (item) => {
						const answer = await api.delete({ siteId, mediaId: item.id });
						if (answer.trashed) throw new Error("It was moved without asking.");
						return { item, usedIn: answer.usedIn, confirmation: answer.confirmation.id };
					}),
				);
				if (!cancelled) setAsked(answers);
			} catch (failure) {
				if (!cancelled) setError(errorMessage(failure));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [key, open, api, siteId]);

	const confirm = async () => {
		if (!asked) return;
		setBusy(true);
		const done: string[] = [];
		try {
			for (const each of asked) {
				await api.delete({ siteId, mediaId: each.item.id, confirmation: each.confirmation });
				done.push(each.item.id);
			}
			notify(
				"success",
				asked.length === 1
					? t("media.delete.deleted", { name: asked[0]?.item.fileName ?? "" })
					: t("media.selection.deleted", { count: asked.length }),
			);
			onOpenChange(false);
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
			if (done.length) await onDeleted(done);
		}
	};

	const inUse = asked?.filter((each) => each.usedIn.length > 0) ?? [];
	const first = items[0];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("media.delete.close")} finalFocus={finalFocus} initialFocus={cancel}>
				<DialogHeader>
					<DialogTitle>
						{items.length === 1 && first
							? t("media.delete.title", { name: first.fileName })
							: t("media.selection.deleteTitle", { count: items.length })}
					</DialogTitle>
					<DialogDescription>{t("media.delete.body")}</DialogDescription>
				</DialogHeader>
				{asked === null && !error ? (
					<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
						<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
						{t("media.delete.checking")}
					</p>
				) : null}
				{inUse.length > 0 ? (
					<div className="grid gap-2 rounded-lg border border-amber-600 p-3 dark:border-amber-400">
						<p className="flex items-start gap-2 text-sm">
							<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							{t("media.selection.usedWarning", { count: inUse.length })}
						</p>
						<ul className="grid gap-1 text-sm">
							{inUse.map((each) => (
								<li key={each.item.id}>
									{each.item.fileName} · {t("media.usedIn.count", { count: each.usedIn.length })}
								</li>
							))}
						</ul>
					</div>
				) : null}
				{error ? <FieldError>{t(error)}</FieldError> : null}
				<DialogFooter>
					<DialogClose render={<Button ref={cancel} variant="outline" type="button" data-wc-dialog-cancel="" />}>
						{t("media.delete.cancel")}
					</DialogClose>
					<Button variant="destructive" onClick={confirm} disabled={!asked || busy}>
						{t("media.delete.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
