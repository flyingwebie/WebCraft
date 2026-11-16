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
import { type DragEvent, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { errorMessage } from "../../../errors.ts";
import { type MessageKey, useT } from "../../../i18n.tsx";
import { DeleteFolderDialog, FolderNameDialog, type MediaFolder } from "../../../media/FolderDialogs.tsx";
import type { MediaApi } from "../../../media/host.tsx";
import { formatBytes } from "../../../media/preview.ts";
import { percentUsed } from "../../../media/StorageCard.tsx";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { type Action, ActionMenu, PlaceIconButton, SidebarLabel, SidebarRow } from "../content/ui.tsx";
import type { MediaFoldersData, MediaOverviewData } from "./data.ts";
import { notify } from "./toasts.tsx";
import type { MediaPart } from "./view.ts";

/** Whether `part` is the part of the library a row stands for. */
function isPart(part: MediaPart, row: MediaPart): boolean {
	if (part.kind !== row.kind) return false;
	return part.kind !== "folder" || (row.kind === "folder" && part.folderId === row.folderId);
}

/** What a folder dragged in the column carries, so a file dropped from outside is never taken for one. */
const FOLDER_DRAG = "application/x-webcraft-media-folder";

type Order = MediaFoldersData["order"];

/**
 * The Media place's column (SPEC 8, `places-assets/01`): All files and Unfiled, the folders with how
 * many files each holds, and the Trash. People who manage the folders (`media.manage`) also get, over
 * the folders, their order (A–Z or Custom, kept for the Site); in Custom, each folder moves by drag and
 * drop and by Move up and Move down in its menu; and under them Add folder, which asks for the name in
 * place (FX-03). The place's folder menu also renames and deletes. The picker shows the same rows
 * without the Trash, renaming and deleting (`places-assets/04`).
 */
export function MediaSidebar({
	words,
	api,
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
	api: MediaApi;
	siteId: string;
	part: MediaPart;
	folders: MediaFoldersData;
	/** How many files are in the Trash (the place's row). */
	trashCount: number;
	canManage: boolean;
	/** Drawn in the picker: no Trash, no renaming or deleting. */
	picker?: boolean;
	onGo(part: MediaPart): void;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const shown = words.media;
	const filed = folders.folders.reduce((sum, folder) => sum + folder.count, 0);
	const [adding, setAdding] = useState(false);
	const [renaming, setRenaming] = useState<MediaFolder | null>(null);
	const [deleting, setDeleting] = useState<MediaFolder | null>(null);
	// What the person just did, shown until the library is read again.
	const [arranged, setArranged] = useState<readonly string[] | null>(null);
	const [order, setOrder] = useState<Order | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(null);
	const [said, setSaid] = useState("");
	const opener = useRef<HTMLElement | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const hintId = useId();
	const row = (target: MediaPart) => ({ current: isPart(part, target), onOpen: () => onGo(target) });

	// The order's saves go one after another, in the order the person made the changes, and the
	// library is read again once the last is saved; until then what the person did stays shown.
	const saves = useRef<Promise<void>>(Promise.resolve());
	const pending = useRef(0);
	const save = (work: () => Promise<unknown>, undo: () => void) => {
		pending.current++;
		saves.current = saves.current.then(async () => {
			try {
				await work();
			} catch (failure) {
				undo();
				notify("error", t("media.folders.orderFailed", { reason: t(errorMessage(failure)) }));
			} finally {
				pending.current--;
				if (pending.current === 0) await onChanged();
			}
		});
	};

	// A new reading of the library replaces what was shown for the person's own change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the folders are read again.
	useEffect(() => {
		if (pending.current > 0) return;
		setArranged(null);
		setOrder(null);
	}, [folders]);

	const shownOrder = order ?? folders.order;
	const custom = shownOrder === "custom";
	const reorderable = canManage && custom;
	const byId = new Map(folders.folders.map((folder) => [folder.id, folder]));
	const list = arranged
		? arranged.map((id) => byId.get(id)).filter((folder): folder is MediaFolder => Boolean(folder))
		: folders.folders;

	const remember = () => {
		opener.current = document.activeElement as HTMLElement | null;
	};

	const chooseOrder = (next: Order) => {
		if (next === shownOrder) return;
		setOrder(next);
		save(
			() => api.folders.setOrder({ siteId, order: next }),
			() => setOrder(null),
		);
	};

	const moveFolder = (id: string, to: number) => {
		const ids = list.map((folder) => folder.id);
		const from = ids.indexOf(id);
		const at = Math.max(0, Math.min(ids.length - 1, to));
		if (from === -1 || from === at) return;
		ids.splice(from, 1);
		ids.splice(at, 0, id);
		setArranged(ids);
		setSaid(
			t("media.folders.moved", { name: byId.get(id)?.name ?? "", position: at + 1, count: ids.length }) +
				(said.endsWith("\u00a0") ? "" : "\u00a0"),
		);
		save(
			() => api.folders.reorder({ siteId, folderIds: ids }),
			() => setArranged(null),
		);
	};

	const dropOn = (event: DragEvent<HTMLLIElement>, target: MediaFolder) => {
		if (!dragging || !event.dataTransfer.types.includes(FOLDER_DRAG)) return;
		event.preventDefault();
		const ids = list.map((folder) => folder.id).filter((id) => id !== dragging);
		const before = dropAt?.id === target.id ? dropAt.before : true;
		const index = ids.indexOf(target.id) + (before ? 0 : 1);
		const moved = dragging;
		setDragging(null);
		setDropAt(null);
		moveFolder(moved, index);
	};

	const folderActions = (folder: MediaFolder, index: number): Action[] => {
		const actions: Action[] = [];
		if (reorderable && index > 0)
			actions.push({ key: "up", label: t("media.folders.moveUp"), run: () => moveFolder(folder.id, index - 1) });
		if (reorderable && index < list.length - 1)
			actions.push({
				key: "down",
				label: t("media.folders.moveDown"),
				run: () => moveFolder(folder.id, index + 1),
			});
		if (canManage && !picker) {
			actions.push(
				{
					key: "rename",
					label: t("media.folders.rename"),
					run: () => {
						remember();
						setRenaming(folder);
					},
				},
				{
					key: "delete",
					label: t("media.folders.delete"),
					run: () => {
						remember();
						setDeleting(folder);
					},
				},
			);
		}
		return actions;
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
					canManage ? (
						<span className="flex items-center gap-1.5">
							<OrderToggle order={shownOrder} onChoose={chooseOrder} />
							<PlaceIconButton
								icon={PlusIcon}
								label={t("media.folders.add")}
								onClick={() => setAdding(true)}
								data={{ "data-wc-new-folder": "" }}
							/>
						</span>
					) : null
				}
			>
				{t("media.folders.heading")}
			</SidebarLabel>
			{reorderable && list.length > 1 ? (
				<p id={hintId} className="sr-only">
					{t("media.folders.dragHint")}
				</p>
			) : null}
			<ul
				className="m-0 flex list-none flex-col gap-0.5 p-0"
				aria-describedby={reorderable && list.length > 1 ? hintId : undefined}
				data-wc-media-folders=""
				data-wc-folders-order={shownOrder}
			>
				{list.map((folder, index) => {
					const actions = folderActions(folder, index);
					const line = dropAt?.id === folder.id ? (dropAt.before ? "before" : "after") : null;
					return (
						<li
							key={folder.id}
							className={`group/folder relative ${dragging === folder.id ? "opacity-50" : ""} ${
								reorderable ? "cursor-grab active:cursor-grabbing" : ""
							}`}
							draggable={reorderable && list.length > 1}
							onDragStart={(event) => {
								if (!reorderable) return;
								event.dataTransfer.setData(FOLDER_DRAG, folder.id);
								event.dataTransfer.effectAllowed = "move";
								setDragging(folder.id);
							}}
							onDragOver={(event) => {
								if (!dragging || !event.dataTransfer.types.includes(FOLDER_DRAG)) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								const box = event.currentTarget.getBoundingClientRect();
								const before = event.clientY < box.top + box.height / 2;
								if (dropAt?.id !== folder.id || dropAt.before !== before) setDropAt({ id: folder.id, before });
							}}
							onDrop={(event) => dropOn(event, folder)}
							onDragEnd={() => {
								setDragging(null);
								setDropAt(null);
							}}
							data-wc-folder={folder.id}
						>
							{line ? (
								<span
									aria-hidden="true"
									className={`bg-chrome-focus pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full ${
										line === "before" ? "-top-[2px]" : "-bottom-[2px]"
									}`}
									data-wc-folder-drop={line}
								/>
							) : null}
							<SidebarRow
								icon={FolderIcon}
								label={folder.name}
								count={folder.count}
								{...row({ kind: "folder", folderId: folder.id })}
								data={{ "data-wc-media-row": folder.id }}
							/>
							{actions.length > 0 ? (
								<span className="bg-chrome absolute end-9 top-[3px] inline-flex rounded-[5px] opacity-0 group-focus-within/folder:opacity-100 group-hover/folder:opacity-100 has-[[aria-expanded=true]]:opacity-100">
									<ActionMenu
										icon={EllipsisIcon}
										label={fill(shown.folderActions, { name: folder.name })}
										actions={actions}
										data={{ "data-wc-folder-actions": folder.id }}
									/>
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
			{canManage ? (
				<AddFolder
					api={api}
					siteId={siteId}
					open={adding}
					onOpenChange={setAdding}
					button={addButton}
					onChanged={onChanged}
				/>
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
			<p role="status" aria-live="polite" className="sr-only" data-wc-folder-said="">
				{said}
			</p>
			{canManage && !picker ? (
				<>
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

/** The folders' order over them: A–Z or Custom, two buttons, the one in use pressed. */
function OrderToggle({ order, onChoose }: { order: Order; onChoose(order: Order): void }) {
	const t = useT();
	return (
		<fieldset
			className="bg-chrome-raised m-0 inline-flex gap-0.5 rounded-md border-0 p-0.5"
			data-wc-folder-order-toggle=""
		>
			<legend className="sr-only">{t("media.folders.order")}</legend>
			{(
				[
					["name", t("media.folders.orderName")],
					["custom", t("media.folders.orderCustom")],
				] as const
			).map(([value, label]) => (
				<button
					key={value}
					type="button"
					aria-pressed={order === value}
					onClick={() => onChoose(value)}
					className={`text-chrome-muted aria-pressed:bg-chrome-hover aria-pressed:text-chrome-strong hover:text-chrome-strong inline-flex h-5 items-center rounded-[4px] px-1.5 text-[11px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-folder-order={value}
				>
					{label}
				</button>
			))}
		</fieldset>
	);
}

/**
 * Add folder under the folders (FX-03): a full-width button with a dashed border, which becomes a box
 * for the new folder's name in place. Enter saves it (`media.folders.create`), Escape cancels; focus
 * goes back to the button either way. A name the Site already has, or none, is said under the box.
 */
function AddFolder({
	api,
	siteId,
	open,
	onOpenChange,
	button,
	onChanged,
}: {
	api: MediaApi;
	siteId: string;
	open: boolean;
	onOpenChange(open: boolean): void;
	button: { current: HTMLButtonElement | null };
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const [name, setName] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const refocus = useRef(false);
	const hintId = useId();
	const errorId = useId();

	useEffect(() => {
		if (open) input.current?.focus();
	}, [open]);

	// Back on the button in the same commit that takes the box away, before a dialog around it (the
	// picker) would take the focus it lost.
	useLayoutEffect(() => {
		if (open || !refocus.current) return;
		refocus.current = false;
		button.current?.focus();
	}, [open, button]);

	const close = (focusButton: boolean) => {
		refocus.current = focusButton;
		onOpenChange(false);
		setName("");
		setError(null);
	};

	const save = async () => {
		const trimmed = name.trim();
		if (!trimmed) {
			setError("media.folders.nameRequired");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.folders.create({ siteId, name: trimmed });
			notify("success", t("media.folders.created", { name: trimmed }));
			close(true);
			await onChanged();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			if (!busy) void save();
		} else if (event.key === "Escape") {
			// Escape here cancels the name only: the picker or the place stays open.
			event.preventDefault();
			event.stopPropagation();
			event.nativeEvent.stopImmediatePropagation();
			close(true);
		}
	};

	return (
		<div className="px-2 pt-2.5" data-wc-add-folder="">
			{open ? (
				<>
					<input
						ref={input}
						type="text"
						value={name}
						maxLength={100}
						autoComplete="off"
						readOnly={busy}
						aria-busy={busy || undefined}
						aria-label={t("media.folders.addName")}
						aria-describedby={error ? `${errorId} ${hintId}` : hintId}
						aria-invalid={error ? true : undefined}
						placeholder={t("media.folders.name")}
						onChange={(event) => {
							setName(event.target.value);
							if (error) setError(null);
						}}
						onKeyDown={onKey}
						onBlur={() => {
							if (!name.trim() && !busy) close(false);
						}}
						className={`bg-chrome-raised text-chrome-text placeholder:text-chrome-faint border-chrome-focus h-[30px] w-full rounded-md border px-2 text-[12px] ${FOCUS_RING}`}
						data-wc-add-folder-name=""
					/>
					<p id={hintId} className="text-chrome-muted m-0 pt-1 text-[11px]">
						{t("media.folders.addHint")}
					</p>
					{error ? (
						<p
							id={errorId}
							role="alert"
							className="text-chrome-danger m-0 pt-1 text-[11px]"
							data-wc-add-folder-error=""
						>
							{t(error)}
						</p>
					) : null}
				</>
			) : (
				<button
					ref={button}
					type="button"
					onClick={() => onOpenChange(true)}
					className={`border-chrome-hover text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-new-folder-button=""
				>
					<PlusIcon aria-hidden="true" className="size-3.5" />
					{t("media.folders.add")}
				</button>
			)}
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
