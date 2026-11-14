import {
	DatabaseIcon,
	EllipsisIcon,
	FileQuestionIcon,
	FolderIcon,
	ImageIcon,
	ImagesIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import { useT } from "../../../i18n.tsx";
import { DeleteFolderDialog, FolderNameDialog, type MediaFolder } from "../../../media/FolderDialogs.tsx";
import { formatBytes } from "../../../media/preview.ts";
import { percentUsed } from "../../../media/StorageCard.tsx";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { ActionMenu, PlaceIconButton, SidebarLabel, SidebarRow } from "../content/ui.tsx";
import type { MediaFoldersData, MediaOverviewData } from "./data.ts";
import type { MediaPart } from "./view.ts";

/** Whether `part` is the part of the library a row stands for. */
function isPart(part: MediaPart, row: MediaPart): boolean {
	if (part.kind !== row.kind) return false;
	return part.kind !== "folder" || (row.kind === "folder" && part.folderId === row.folderId);
}

/**
 * The Media place's column (SPEC 8, `places-assets/01`): All files and Unfiled, the folders with how
 * many files each holds (Folders' "+", each folder's menu and New Folder for those with
 * `media.manage`), and the Trash. The picker shows the same rows without the Trash and the folder
 * actions (`places-assets/04`).
 */
export function MediaSidebar({
	words,
	siteId,
	part,
	folders,
	trashCount,
	canManage,
	picker = false,
	onGo,
	onChanged,
}: {
	words: Words;
	siteId: string;
	part: MediaPart;
	folders: MediaFoldersData;
	/** How many files are in the Trash (the place's row). */
	trashCount: number;
	canManage: boolean;
	/** Drawn in the picker: no Trash, no folder actions. */
	picker?: boolean;
	onGo(part: MediaPart): void;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const shown = words.media;
	const filed = folders.folders.reduce((sum, folder) => sum + folder.count, 0);
	const [creating, setCreating] = useState(false);
	const [renaming, setRenaming] = useState<MediaFolder | null>(null);
	const [deleting, setDeleting] = useState<MediaFolder | null>(null);
	const opener = useRef<HTMLElement | null>(null);
	const manage = canManage && !picker;
	const row = (target: MediaPart) => ({ current: isPart(part, target), onOpen: () => onGo(target) });

	const startCreating = () => {
		opener.current = document.activeElement as HTMLElement | null;
		setCreating(true);
	};

	return (
		<div className="flex flex-col pt-1" data-wc-media-sidebar="">
			<div className="flex flex-col gap-0.5">
				<SidebarRow
					icon={ImagesIcon}
					label={t("media.folders.all")}
					count={folders.total}
					{...row({ kind: "all" })}
					data={{ "data-wc-media-row": "all" }}
				/>
				<SidebarRow
					icon={FileQuestionIcon}
					label={t("media.folders.none")}
					count={Math.max(0, folders.total - filed)}
					{...row({ kind: "unfiled" })}
					data={{ "data-wc-media-row": "unfiled" }}
				/>
			</div>
			<hr className="border-chrome-line mx-0 my-2 border-t" />
			<SidebarLabel
				add={
					manage ? (
						<PlaceIconButton
							icon={PlusIcon}
							label={t("media.folders.new")}
							onClick={startCreating}
							data={{ "data-wc-new-folder": "" }}
						/>
					) : null
				}
			>
				{t("media.folders.heading")}
			</SidebarLabel>
			<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
				{folders.folders.map((folder) => (
					<li key={folder.id} className="group/folder relative">
						<SidebarRow
							icon={FolderIcon}
							label={folder.name}
							count={folder.count}
							{...row({ kind: "folder", folderId: folder.id })}
							data={{ "data-wc-media-row": folder.id }}
						/>
						{manage ? (
							<span className="bg-chrome absolute end-9 top-[3px] inline-flex rounded-[5px] opacity-0 group-focus-within/folder:opacity-100 group-hover/folder:opacity-100 has-[[aria-expanded=true]]:opacity-100">
								<ActionMenu
									icon={EllipsisIcon}
									label={fill(shown.folderActions, { name: folder.name })}
									actions={[
										{
											key: "rename",
											label: t("media.folders.rename"),
											run: () => {
												opener.current = document.activeElement as HTMLElement | null;
												setRenaming(folder);
											},
										},
										{
											key: "delete",
											label: t("media.folders.delete"),
											run: () => {
												opener.current = document.activeElement as HTMLElement | null;
												setDeleting(folder);
											},
										},
									]}
									data={{ "data-wc-folder-actions": folder.id }}
								/>
							</span>
						) : null}
					</li>
				))}
			</ul>
			{manage ? (
				<div className="px-2 pt-2.5">
					<button
						type="button"
						onClick={startCreating}
						className={`border-chrome-hover text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-new-folder-button=""
					>
						<PlusIcon aria-hidden="true" className="size-3.5" />
						{t("media.folders.new")}
					</button>
				</div>
			) : null}
			{picker ? null : (
				<div className="pt-2">
					<SidebarRow
						icon={Trash2Icon}
						label={t("media.trash.folder")}
						count={trashCount}
						{...row({ kind: "trash" })}
						data={{ "data-wc-media-row": "trash" }}
					/>
				</div>
			)}
			{manage ? (
				<>
					<FolderNameDialog
						siteId={siteId}
						open={creating}
						onOpenChange={setCreating}
						finalFocus={opener}
						onChanged={onChanged}
					/>
					{renaming ? (
						<FolderNameDialog
							key={renaming.id}
							siteId={siteId}
							folder={renaming}
							open
							onOpenChange={(open) => {
								if (!open) setRenaming(null);
							}}
							finalFocus={opener}
							onChanged={onChanged}
						/>
					) : null}
					{deleting ? (
						<DeleteFolderDialog
							siteId={siteId}
							folder={deleting}
							open
							onOpenChange={(open) => {
								if (!open) setDeleting(null);
							}}
							finalFocus={opener}
							onChanged={async () => {
								if (isPart(part, { kind: "folder", folderId: deleting.id })) onGo({ kind: "all" });
								await onChanged();
							}}
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}

/** The column's foot (`places-assets/01`): how many files the library holds, and the storage they take. */
export function MediaTiles({ words, total, overview }: { words: Words; total: number; overview: MediaOverviewData }) {
	const t = useT();
	const storage = overview.storage;
	return (
		<div className="grid shrink-0 grid-cols-2 gap-1.5 px-2 pb-2" data-wc-media-tiles="">
			<div className="bg-chrome-raised flex flex-col gap-1 rounded-md p-2">
				<div className="flex items-center">
					<span className="text-chrome-strong grow text-[13px] font-bold tabular-nums">{total}</span>
					<ImageIcon aria-hidden="true" className="text-chrome-muted size-3.5" />
				</div>
				<span className="text-chrome-muted text-[11px]">{t("media.tiles.files", { count: total })}</span>
			</div>
			<div className="bg-chrome-raised flex flex-col gap-1 rounded-md p-2">
				<div className="flex items-center">
					<span className="text-chrome-strong grow truncate text-[13px] font-bold tabular-nums">
						{formatBytes(storage.usedBytes)}
					</span>
					<DatabaseIcon aria-hidden="true" className="text-chrome-muted size-3.5" />
				</div>
				<span className="text-chrome-muted truncate text-[11px]">
					{storage.quotaBytes === null
						? t("media.tiles.used")
						: t("media.tiles.of", { quota: formatBytes(storage.quotaBytes) })}
				</span>
				{storage.quotaBytes !== null ? (
					<meter
						aria-label={words.media.storage}
						min={0}
						max={100}
						low={80}
						high={99}
						optimum={0}
						value={percentUsed(storage)}
						className="h-[3px] w-full"
					/>
				) : null}
			</div>
		</div>
	);
}
