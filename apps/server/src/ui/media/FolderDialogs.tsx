import type { ApiClient } from "@webcraft/api";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useMediaHost } from "./host.tsx";

/** A folder of the Media library, as `media.folders.list` answers it. */
export type MediaFolder = Awaited<ReturnType<ApiClient["media"]["folders"]["list"]>>["folders"][number];

/*
 * The Media library's folders: naming a new one, renaming and deleting one. Shared by the admin's
 * Media screen and the building area's Media place (through `host.tsx`).
 */

/** A folder's menu: rename it, or delete it (its files stay in the library). */
export function FolderActions({
	siteId,
	folder,
	onChanged,
}: {
	siteId: string;
	folder: MediaFolder;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							className="opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
							aria-label={t("media.folders.actionsOf", { name: folder.name })}
						/>
					}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-40">
					<DropdownMenuItem onClick={() => setRenaming(true)}>
						<PencilIcon aria-hidden="true" />
						{t("media.folders.rename")}
					</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
						<Trash2Icon aria-hidden="true" />
						{t("media.folders.delete")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<FolderNameDialog
				siteId={siteId}
				folder={folder}
				open={renaming}
				onOpenChange={setRenaming}
				finalFocus={trigger}
				onChanged={onChanged}
			/>
			<DeleteFolderDialog
				siteId={siteId}
				folder={folder}
				open={deleting}
				onOpenChange={setDeleting}
				finalFocus={trigger}
				onChanged={onChanged}
			/>
		</>
	);
}

/** Names a new folder, or renames `folder`. */
export function FolderNameDialog({
	siteId,
	folder,
	open,
	onOpenChange,
	finalFocus,
	onChanged,
}: {
	siteId: string;
	folder?: MediaFolder;
	open: boolean;
	onOpenChange(open: boolean): void;
	finalFocus: RefObject<HTMLElement | null>;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const host = useMediaHost();
	const [name, setName] = useState(folder?.name ?? "");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "") {
			setError("media.folders.nameRequired");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await host.api();
			if (folder) {
				await api.folders.rename({ siteId, folderId: folder.id, name: name.trim() });
				toast.success(t("media.folders.renamed"));
			} else {
				await api.folders.create({ siteId, name: name.trim() });
				toast.success(t("media.folders.created", { name: name.trim() }));
				setName("");
			}
			onOpenChange(false);
			await onChanged();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const inputId = folder ? `media-folder-name-${folder.id}` : "media-folder-name";
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setError(null);
			}}
		>
			<DialogContent closeLabel={t("media.folders.close")} finalFocus={finalFocus}>
				<form onSubmit={save} className="grid gap-6" noValidate>
					<DialogHeader>
						<DialogTitle>
							{folder ? t("media.folders.renameTitle", { name: folder.name }) : t("media.folders.newTitle")}
						</DialogTitle>
					</DialogHeader>
					<Field data-invalid={error ? true : undefined}>
						<FieldLabel htmlFor={inputId}>{t("media.folders.name")}</FieldLabel>
						<Input
							id={inputId}
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							autoComplete="off"
							required
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${inputId}-error` : undefined}
						/>
						{error ? <FieldError id={`${inputId}-error`}>{t(error)}</FieldError> : null}
					</Field>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("media.folders.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{folder ? t("media.folders.renameConfirm") : t("media.folders.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Asks before deleting a folder; its files stay in the library, in no folder. */
export function DeleteFolderDialog({
	siteId,
	folder,
	open,
	onOpenChange,
	finalFocus,
	onChanged,
}: {
	siteId: string;
	folder: MediaFolder;
	open: boolean;
	onOpenChange(open: boolean): void;
	finalFocus: RefObject<HTMLElement | null>;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const host = useMediaHost();
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await host.api();
			await api.folders.delete({ siteId, folderId: folder.id });
			toast.success(t("media.folders.deleted", { name: folder.name }));
			onOpenChange(false);
			await onChanged();
			host.focusMain();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("media.folders.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("media.folders.deleteTitle", { name: folder.name })}</DialogTitle>
					<DialogDescription>{t("media.folders.deleteBody", { count: folder.count })}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("media.folders.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("media.folders.deleteConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
