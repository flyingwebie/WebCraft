import { Link } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { MEDIA_KINDS, type MediaKind } from "@webcraft/core/media-kinds";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import {
	CloudUploadIcon,
	EllipsisIcon,
	FolderIcon,
	FolderPlusIcon,
	ImagesIcon,
	LoaderIcon,
	PencilIcon,
	ReplaceIcon,
	SearchIcon,
	SparklesIcon,
	Trash2Icon,
	TriangleAlertIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { type DragEvent, type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtcDate } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { type FocalPoint, FocalPointPicker } from "./FocalPointPicker.tsx";
import { ImportDialog } from "./ImportDialog.tsx";
import { formatBytes, imagePreview, KIND_ICONS, type MediaItem } from "./preview.ts";
import { QuotaNotice, StorageMeter } from "./StorageCard.tsx";
import { DeleteDialog, DeleteForeverDialog, EmptyTrashDialog, RestoreButton } from "./TrashDialogs.tsx";
import { type MediaUses, UsedIn } from "./UsedIn.tsx";

type MediaList = Awaited<ReturnType<ApiClient["media"]["list"]>>;
type MediaFolders = Awaited<ReturnType<ApiClient["media"]["folders"]["list"]>>;
type MediaFolder = MediaFolders["folders"][number];
type MediaOverview = Awaited<ReturnType<ApiClient["media"]["overview"]>>;

export type MediaLibrarySearch = { folder?: string; q?: string; kind?: MediaKind; file?: string; trash?: boolean };

/**
 * The Media library screen: folders, the files (searched and filtered) and the details of the file
 * that is open, with its title, alt text and caption. Uploading, filing and changing texts follow the
 * person's Permissions: `media.upload` (their own uploads) and `media.manage` (every file, folders).
 */
export function MediaLibrary({
	siteId,
	permissions,
	list,
	folders,
	overview,
	selected,
	usedIn,
	search,
	onSearch,
	onChanged,
}: {
	siteId: string;
	permissions: readonly string[];
	list: MediaList;
	folders: MediaFolders;
	overview: MediaOverview;
	selected: MediaItem | null;
	usedIn: MediaUses;
	search: MediaLibrarySearch;
	onSearch(next: MediaLibrarySearch, options?: { replace?: boolean }): void;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const inTrash = search.trash === true;
	const canUpload = permissions.includes("media.upload") && !inTrash;
	const canManage = permissions.includes("media.manage");
	const [uploading, setUploading] = useState(0);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const folderId = search.folder && search.folder !== "none" ? search.folder : null;
	const processing =
		list.items.some((item) => item.status === "processing" || item.replacing) ||
		selected?.status === "processing" ||
		selected?.replacing === true;

	// The worker cleans images in the background: look again until every file shown is ready, every 2
	// seconds for the first minute, then every 15 (a worker that is down would otherwise be asked forever).
	const refresh = useRef(onChanged);
	refresh.current = onChanged;
	useEffect(() => {
		if (!processing) return;
		let looks = 0;
		let timer: ReturnType<typeof setTimeout>;
		const look = () => {
			timer = setTimeout(
				async () => {
					looks++;
					await refresh.current();
					look();
				},
				looks < 30 ? 2000 : 15_000,
			);
		};
		look();
		return () => clearTimeout(timer);
	}, [processing]);

	const upload = async (files: readonly File[]) => {
		if (files.length === 0 || !canUpload) return;
		setUploading(files.length);
		const api = await getApi();
		for (const file of files) {
			try {
				await api.media.upload({ siteId, file, folderId });
				toast.success(t("media.uploaded", { name: file.name }));
			} catch (failure) {
				toast.error(t("media.uploadFailed", { name: file.name, reason: t(errorMessage(failure)) }));
			}
		}
		setUploading(0);
		await onChanged();
	};

	const drop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		void upload([...event.dataTransfer.files]);
	};

	return (
		<div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_20rem]">
			<FolderNav
				siteId={siteId}
				folders={folders}
				overview={overview}
				search={search}
				canManage={canManage}
				onChanged={onChanged}
			/>

			<section
				aria-labelledby="media-heading"
				className="grid min-w-0 content-start gap-5"
				onDragOver={(event) => {
					if (!canUpload) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={canUpload ? drop : undefined}
			>
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="space-y-1">
						<h1 id="media-heading" className="text-2xl font-semibold tracking-tight">
							{inTrash ? t("media.trash.heading") : t("media.heading")}
						</h1>
						<p className="text-muted-foreground">
							{inTrash ? t("media.trash.intro") : t("media.intro", { count: folders.total })}
						</p>
					</div>
					{inTrash && canManage && overview.trash.count > 0 ? (
						<EmptyTrashDialog
							siteId={siteId}
							onEmptied={async () => {
								onSearch({ file: undefined });
								await onChanged();
							}}
						/>
					) : null}
					{canUpload ? (
						<div className="flex flex-wrap gap-2">
							<ImportDialog siteId={siteId} folderId={folderId} onImported={onChanged} />
							<input
								ref={fileInput}
								type="file"
								multiple
								hidden
								tabIndex={-1}
								aria-hidden="true"
								onChange={(event) => {
									void upload([...(event.target.files ?? [])]);
									event.target.value = "";
								}}
							/>
							<Button onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
								{uploading > 0 ? (
									<LoaderIcon className="animate-spin" aria-hidden="true" />
								) : (
									<UploadIcon aria-hidden="true" />
								)}
								{t("media.upload")}
							</Button>
						</div>
					) : null}
				</div>

				<QuotaNotice storage={overview.storage} />

				<Toolbar search={search} onSearch={onSearch} />

				{canUpload ? (
					<p
						className={`text-muted-foreground flex flex-wrap items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-center text-sm ${
							dragging ? "border-primary bg-muted" : ""
						}`}
					>
						<CloudUploadIcon className="size-4" aria-hidden="true" />
						<span>{t("media.dropHint")}</span>
						<span aria-hidden="true">·</span>
						<span>{t("media.formats", { size: formatBytes(overview.maxFileBytes) })}</span>
					</p>
				) : null}
				<p role="status" aria-live="polite" className="sr-only">
					{uploading > 0 ? t("media.uploading", { count: uploading }) : ""}
				</p>

				<FileGrid
					siteId={siteId}
					items={list.items}
					total={inTrash ? overview.trash.count : folders.total}
					selectedId={selected?.id}
					inTrash={inTrash}
				/>
			</section>

			{selected ? (
				<DetailsPanel
					key={`${selected.id}:${selected.updatedAt.toString()}:${selected.status}`}
					siteId={siteId}
					item={selected}
					folders={folders.folders}
					usedIn={usedIn}
					permissions={permissions}
					altTextSuggestions={overview.altTextSuggestions}
					onChanged={onChanged}
					onClosed={async () => {
						onSearch({ file: undefined });
						await onChanged();
					}}
				/>
			) : null}
		</div>
	);
}

/** Search by name or alt text, and the kind of file. */
function Toolbar({
	search,
	onSearch,
}: {
	search: MediaLibrarySearch;
	onSearch(next: MediaLibrarySearch, options?: { replace?: boolean }): void;
}) {
	const t = useT();
	const [query, setQuery] = useState(search.q ?? "");
	const latest = useRef(onSearch);
	latest.current = onSearch;

	// The list follows the search box a moment after typing stops.
	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed === (search.q ?? "")) return;
		const timer = setTimeout(() => latest.current({ q: trimmed || undefined }, { replace: true }), 300);
		return () => clearTimeout(timer);
	}, [query, search.q]);

	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="w-full max-w-xs">
				<Label htmlFor="media-search" className="sr-only">
					{t("media.search")}
				</Label>
				<InputGroup>
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						id="media-search"
						type="search"
						placeholder={t("media.search")}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</InputGroup>
			</div>
			<fieldset className="bg-muted flex flex-wrap gap-1 rounded-lg p-1">
				<legend className="sr-only">{t("media.kinds.label")}</legend>
				{([undefined, ...MEDIA_KINDS] as const).map((kind) => (
					<Button
						key={kind ?? "all"}
						type="button"
						size="sm"
						variant={search.kind === kind ? "outline" : "ghost"}
						aria-pressed={search.kind === kind}
						onClick={() => onSearch({ kind })}
					>
						{t(kind ? `media.kinds.${kind}` : "media.kinds.all")}
					</Button>
				))}
			</fieldset>
		</div>
	);
}

/** The files, as a grid of cards; each opens its details. */
function FileGrid({
	siteId,
	items,
	total,
	selectedId,
	inTrash,
}: {
	siteId: string;
	items: readonly MediaItem[];
	total: number;
	selectedId: string | undefined;
	inTrash: boolean;
}) {
	const t = useT();
	if (items.length === 0) {
		return (
			<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
				{total === 0 ? (inTrash ? t("media.trash.empty") : t("media.empty")) : t("media.noMatch")}
			</p>
		);
	}
	return (
		<ul aria-label={t("media.listLabel")} className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
			{items.map((item) => {
				const current = item.id === selectedId;
				const image = imagePreview(siteId, item, 320);
				const Icon = KIND_ICONS[item.kind];
				return (
					<li key={item.id}>
						<Link
							to="/sites/$siteId/media"
							params={{ siteId }}
							search={(previous: MediaLibrarySearch) => ({ ...previous, file: item.id })}
							aria-current={current ? "true" : undefined}
							className={`group focus-visible:ring-ring/50 grid gap-2 rounded-lg outline-none focus-visible:ring-3 ${
								current ? "text-foreground" : ""
							}`}
						>
							<span
								className={`bg-muted relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border-2 ${
									current ? "border-primary" : "group-hover:border-border border-transparent"
								}`}
							>
								{image ? (
									<img src={image} alt="" loading="lazy" className="size-full object-cover" />
								) : (
									<Icon className="text-muted-foreground size-8" aria-hidden="true" />
								)}
								{item.status !== "ready" ? (
									<Badge
										variant={item.status === "failed" ? "destructive" : "secondary"}
										className="absolute start-2 top-2"
									>
										{t(item.status === "failed" ? "media.failed" : "media.processing")}
									</Badge>
								) : null}
							</span>
							<span className={`truncate text-sm ${current ? "font-semibold" : ""}`}>{item.fileName}</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}

/** The library's folders, with how many files each holds; Editors, Owners and Staff manage them. */
function FolderNav({
	siteId,
	folders,
	overview,
	search,
	canManage,
	onChanged,
}: {
	siteId: string;
	folders: MediaFolders;
	overview: MediaOverview;
	search: MediaLibrarySearch;
	canManage: boolean;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const [creating, setCreating] = useState(false);
	const newButton = useRef<HTMLButtonElement>(null);
	const entries: { key: string; folder?: string; label: string; count: number; icon: typeof FolderIcon }[] = [
		{ key: "all", label: t("media.folders.all"), count: folders.total, icon: ImagesIcon },
		...folders.folders.map((folder) => ({
			key: folder.id,
			folder: folder.id,
			label: folder.name,
			count: folder.count,
			icon: FolderIcon,
		})),
	];
	return (
		<div className="grid content-start gap-6">
			<nav aria-labelledby="media-folders-heading" className="grid content-start gap-2">
				<h2 id="media-folders-heading" className="text-muted-foreground px-2 text-xs font-medium uppercase">
					{t("media.folders.heading")}
				</h2>
				<ul className="grid gap-1">
					{entries.map((entry) => {
						const current = !search.trash && search.folder === entry.folder;
						const folder = folders.folders.find((each) => each.id === entry.folder);
						return (
							<li key={entry.key} className="flex items-center gap-1">
								<Link
									to="/sites/$siteId/media"
									params={{ siteId }}
									search={{ folder: entry.folder, q: search.q, kind: search.kind }}
									aria-current={current ? "page" : undefined}
									className={`hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-3 ${
										current ? "bg-muted font-medium" : ""
									}`}
								>
									<entry.icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
									<span className="truncate">{entry.label}</span>
									<span className="text-muted-foreground ms-auto text-xs tabular-nums">{entry.count}</span>
								</Link>
								{canManage && folder ? <FolderActions siteId={siteId} folder={folder} onChanged={onChanged} /> : null}
							</li>
						);
					})}
				</ul>
				<Link
					to="/sites/$siteId/media"
					params={{ siteId }}
					search={{ trash: true }}
					aria-current={search.trash ? "page" : undefined}
					className={`hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-3 ${
						search.trash ? "bg-muted font-medium" : ""
					}`}
				>
					<Trash2Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
					<span className="truncate">{t("media.trash.folder")}</span>
					<span className="text-muted-foreground ms-auto text-xs tabular-nums">{overview.trash.count}</span>
				</Link>
				{canManage ? (
					<>
						<Button ref={newButton} variant="ghost" className="justify-start" onClick={() => setCreating(true)}>
							<FolderPlusIcon aria-hidden="true" />
							{t("media.folders.new")}
						</Button>
						<FolderNameDialog
							siteId={siteId}
							open={creating}
							onOpenChange={setCreating}
							finalFocus={newButton}
							onChanged={onChanged}
						/>
					</>
				) : null}
			</nav>
			<section aria-labelledby="media-storage-heading" className="grid gap-1 rounded-lg border p-4">
				<h2 id="media-storage-heading" className="text-sm font-medium">
					{t("media.storage.heading")}
				</h2>
				<StorageMeter storage={overview.storage} />
				<p className="text-muted-foreground text-xs">{t("media.storage.shared")}</p>
			</section>
		</div>
	);
}

/** A folder's menu: rename it, or delete it (its files stay in the library). */
function FolderActions({
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
						<Button variant="ghost" size="icon-sm" aria-label={t("media.folders.actionsOf", { name: folder.name })} />
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
function FolderNameDialog({
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
			const api = await getApi();
			if (folder) {
				await api.media.folders.rename({ siteId, folderId: folder.id, name: name.trim() });
				toast.success(t("media.folders.renamed"));
			} else {
				await api.media.folders.create({ siteId, name: name.trim() });
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
function DeleteFolderDialog({
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
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.media.folders.delete({ siteId, folderId: folder.id });
			toast.success(t("media.folders.deleted", { name: folder.name }));
			onOpenChange(false);
			await onChanged();
			document.getElementById("main")?.focus();
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

/** Why the worker refused a file (or the file meant to replace it), in the admin's words. */
function FailureNote({ item }: { item: MediaItem }) {
	const t = useT();
	const failure = item.failure;
	if (!failure) return null;
	const reason =
		failure.reason === "svgUnsafe"
			? t("media.failure.svgUnsafe", {
					found: (failure.found ?? ["element"])
						.map((found) => t(`media.failure.found.${found as SvgFinding}`))
						.join(", "),
				})
			: t(`media.failure.${failure.reason}`);
	return (
		<p className="text-destructive flex items-start gap-2 text-sm">
			<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>
				{failure.replacement ? `${t("media.replace.refused")} ` : null}
				{reason}
			</span>
		</p>
	);
}

type SvgFinding = "script" | "eventHandler" | "foreignObject" | "outsideReference" | "entity" | "element" | "attribute";

/** Replace file: a new file of the same kind for the item, keeping its id and every use. */
function ReplaceButton({ siteId, item, onChanged }: { siteId: string; item: MediaItem; onChanged(): Promise<void> }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const replace = async (file: File | undefined) => {
		if (!file) return;
		setBusy(true);
		try {
			await (await getApi()).media.replace({ siteId, mediaId: item.id, file });
			toast.success(t("media.replace.replaced", { name: file.name }));
			await onChanged();
		} catch (failure) {
			toast.error(t("media.replace.failed", { name: file.name, reason: t(errorMessage(failure)) }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<input
				ref={input}
				type="file"
				hidden
				tabIndex={-1}
				aria-hidden="true"
				onChange={(event) => {
					void replace(event.target.files?.[0]);
					event.target.value = "";
				}}
			/>
			<Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
				{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <ReplaceIcon aria-hidden="true" />}
				{t("media.replace.button")}
			</Button>
		</>
	);
}

/**
 * The open file: a preview, what it is, where it is used, and its title, alt text and caption in the
 * Site's language (translatable), its folder and an image's Focal point. People who may change it
 * get a form, Replace file and Delete; others read it. A file in the Trash shows when it goes for
 * good, with Restore and Delete for good.
 */
function DetailsPanel({
	siteId,
	item,
	folders,
	usedIn,
	permissions,
	altTextSuggestions,
	onChanged,
	onClosed,
}: {
	siteId: string;
	item: MediaItem;
	folders: readonly MediaFolder[];
	usedIn: MediaUses;
	permissions: readonly string[];
	altTextSuggestions: boolean;
	onChanged(): Promise<void>;
	/** After the file left the view it was open in (moved to the Trash, restored, deleted for good). */
	onClosed(): Promise<void>;
}) {
	const t = useT();
	const [title, setTitle] = useState(item.title ?? "");
	const [alt, setAlt] = useState(item.alt ?? "");
	const [caption, setCaption] = useState(item.caption ?? "");
	const [folderId, setFolderId] = useState(item.folderId ?? "");
	const [focalPoint, setFocalPoint] = useState<FocalPoint | null>(item.focalPoint);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const [suggesting, setSuggesting] = useState(false);
	const [suggestStatus, setSuggestStatus] = useState("");
	const preview = imagePreview(siteId, item, 640);
	const Icon = KIND_ICONS[item.kind];
	const language = item.language.toUpperCase();
	const trashed = item.trashedAt !== null;
	const editable = item.canEdit && !trashed;

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.media.update({
				siteId,
				mediaId: item.id,
				language: item.language,
				title: title.trim() || null,
				alt: alt.trim() || null,
				caption: caption.trim() || null,
				folderId: folderId || null,
				...(item.kind === "image" ? { focalPoint } : {}),
			});
			toast.success(t("media.details.saved"));
			await onChanged();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const suggest = async () => {
		setSuggesting(true);
		setSuggestStatus(t("media.altSuggest.working"));
		try {
			const { alt: suggested } = await (await getApi()).media.suggestAltText({
				siteId,
				mediaId: item.id,
				language: item.language,
			});
			setAlt(suggested);
			setSuggestStatus(t("media.altSuggest.done"));
			document.getElementById("media-alt")?.focus();
		} catch (failure) {
			setSuggestStatus("");
			toast.error(t(errorMessage(failure)));
		} finally {
			setSuggesting(false);
		}
	};

	const facts: [MessageKey, string][] = [
		["media.details.type", item.contentType],
		["media.details.size", formatBytes(item.sizeBytes)],
	];
	if (item.width && item.height) {
		facts.push([
			"media.details.dimensions",
			t("media.details.dimensionsValue", { width: item.width, height: item.height }),
		]);
	}
	if (item.variants.length > 0) {
		facts.push([
			"media.details.sizes",
			t("media.details.sizesValue", { count: new Set(item.variants.map((variant) => variant.width)).size }),
		]);
	}
	facts.push([
		"media.details.uploaded",
		item.uploadedBy
			? t("media.details.uploadedBy", { date: formatUtcDate(item.createdAt), name: item.uploadedBy.name })
			: formatUtcDate(item.createdAt),
	]);

	return (
		<aside aria-labelledby="media-details-heading" className="grid content-start gap-5 xl:border-s xl:ps-6">
			<div className="flex items-center justify-between gap-2">
				<h2 id="media-details-heading" className="text-lg font-semibold tracking-tight">
					{t("media.details.heading")}
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					render={
						<Link
							to="/sites/$siteId/media"
							params={{ siteId }}
							search={(previous: MediaLibrarySearch) => ({ ...previous, file: undefined })}
						/>
					}
					aria-label={t("media.details.close")}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
			{editable && item.kind === "image" && preview ? null : (
				<div className="bg-muted flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg">
					{preview ? (
						<img src={preview} alt="" className="size-full object-contain" />
					) : (
						<Icon className="text-muted-foreground size-10" aria-hidden="true" />
					)}
				</div>
			)}
			<div className="grid gap-3">
				<p className="font-semibold break-all">{item.fileName}</p>
				{trashed ? (
					<div className="grid gap-1 text-sm">
						<Badge variant="secondary" className="w-fit">
							{t("media.trash.badge")}
						</Badge>
						<p>{t("media.trash.deletedOn", { date: formatUtcDate(item.trashedAt ?? item.updatedAt) })}</p>
						<p className="text-muted-foreground">
							{t("media.trash.purgeOn", { date: formatUtcDate(item.purgeAt ?? item.updatedAt) })}
						</p>
					</div>
				) : null}
				{item.status === "processing" ? (
					<p className="text-muted-foreground flex items-start gap-2 text-sm">
						<LoaderIcon className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
						{t("media.details.processingHelp")}
					</p>
				) : null}
				{item.replacing ? (
					<p className="text-muted-foreground flex items-start gap-2 text-sm">
						<LoaderIcon className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
						{t("media.replace.processing")}
					</p>
				) : null}
				<FailureNote item={item} />
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
					{facts.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-muted-foreground">{t(label)}</dt>
							<dd className="text-end break-words">{value}</dd>
						</div>
					))}
				</dl>
			</div>

			{trashed ? (
				item.canEdit ? (
					<div className="flex flex-wrap gap-2">
						<RestoreButton siteId={siteId} item={item} onRestored={onClosed} />
						<DeleteForeverDialog siteId={siteId} item={item} onDeleted={onClosed} />
					</div>
				) : null
			) : (
				<UsedIn siteId={siteId} usedIn={usedIn} permissions={permissions} />
			)}

			<div className="flex flex-wrap items-center gap-2 border-t pt-4">
				<p className="text-sm font-medium">{t("media.details.language", { language })}</p>
				<Badge variant="outline">{t("media.details.translatable")}</Badge>
			</div>

			{editable ? (
				<form onSubmit={save} className="grid gap-5" noValidate>
					<FieldGroup className="gap-4">
						<Field>
							<FieldLabel htmlFor="media-title">{t("media.details.title")}</FieldLabel>
							<Input
								id="media-title"
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								maxLength={200}
								lang={item.language}
							/>
						</Field>
						{item.kind === "image" ? (
							<Field>
								<FieldLabel htmlFor="media-alt">{t("media.details.alt")}</FieldLabel>
								<Textarea
									id="media-alt"
									value={alt}
									onChange={(event) => setAlt(event.target.value)}
									maxLength={1000}
									rows={3}
									lang={item.language}
									aria-describedby="media-alt-help"
								/>
								<FieldDescription id="media-alt-help">{t("media.details.altHelp")}</FieldDescription>
								{altTextSuggestions && item.status === "ready" && item.contentType !== "image/svg+xml" ? (
									<div className="flex flex-wrap items-center gap-2">
										<Button type="button" variant="outline" size="sm" onClick={suggest} disabled={suggesting}>
											{suggesting ? (
												<LoaderIcon className="animate-spin" aria-hidden="true" />
											) : (
												<SparklesIcon aria-hidden="true" />
											)}
											{t("media.altSuggest.button")}
										</Button>
									</div>
								) : null}
								<p role="status" className="text-muted-foreground text-sm empty:hidden">
									{suggestStatus}
								</p>
							</Field>
						) : null}
						<Field>
							<FieldLabel htmlFor="media-caption">{t("media.details.caption")}</FieldLabel>
							<Textarea
								id="media-caption"
								value={caption}
								onChange={(event) => setCaption(event.target.value)}
								maxLength={2000}
								rows={2}
								lang={item.language}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="media-folder">{t("media.details.folder")}</FieldLabel>
							<NativeSelect id="media-folder" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
								<NativeSelectOption value="">{t("media.folders.none")}</NativeSelectOption>
								{folders.map((folder) => (
									<NativeSelectOption key={folder.id} value={folder.id}>
										{folder.name}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						{item.kind === "image" ? (
							<FocalPointPicker src={preview} value={focalPoint} onChange={setFocalPoint} />
						) : null}
					</FieldGroup>
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<div>
						<Button type="submit" disabled={busy}>
							{t("media.details.save")}
						</Button>
					</div>
				</form>
			) : (
				<div className="grid gap-4 text-sm">
					<dl className="grid gap-3">
						{(
							[
								["media.details.title", item.title],
								...(item.kind === "image" ? ([["media.details.alt", item.alt]] as const) : []),
								["media.details.caption", item.caption],
								["media.details.folder", folders.find((folder) => folder.id === item.folderId)?.name ?? null],
							] as const
						).map(([label, value]) => (
							<div key={label} className="grid gap-0.5">
								<dt className="font-medium">{t(label)}</dt>
								<dd className="text-muted-foreground" lang={item.language}>
									{value ?? "—"}
								</dd>
							</div>
						))}
					</dl>
					<p className="text-muted-foreground">{t(trashed ? "media.trash.readOnly" : "media.details.readOnly")}</p>
				</div>
			)}

			{editable ? (
				<div className="flex flex-wrap justify-between gap-2 border-t pt-4">
					<ReplaceButton siteId={siteId} item={item} onChanged={onChanged} />
					<DeleteDialog siteId={siteId} item={item} onDeleted={onClosed} />
				</div>
			) : null}
		</aside>
	);
}
