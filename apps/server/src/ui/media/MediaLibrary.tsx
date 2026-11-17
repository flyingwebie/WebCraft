import { Link, useNavigate } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { MEDIA_KINDS, type MediaKind } from "@webcraft/core/media-kinds";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import {
	ChevronDownIcon,
	CopyIcon,
	DownloadIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	ImagesIcon,
	LayoutGridIcon,
	LinkIcon,
	ListIcon,
	LoaderIcon,
	SearchIcon,
	SparklesIcon,
	Trash2Icon,
	TriangleAlertIcon,
	UploadIcon,
} from "lucide-react";
import { type DragEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { When } from "../content/When.tsx";
import { errorMessage } from "../errors.ts";
import { formatUtcDate } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageAside, PageHeader, PageSheet } from "../shell/page.tsx";
import {
	SecondaryLabel,
	SecondaryList,
	SecondarySidebar,
	SecondaryTitle,
	secondaryRowClass,
} from "../shell/SecondarySidebar.tsx";
import { ADMIN_HOST } from "./admin-host.tsx";
import { type FocalPoint, FocalPointPicker } from "./FocalPointPicker.tsx";
import { FolderActions, FolderNameDialog, type MediaFolder } from "./FolderDialogs.tsx";
import { MediaHostProvider } from "./host.tsx";
import { ImportDialog } from "./ImportDialog.tsx";
import { formatBytes, imagePreview, KIND_ICONS, type ListedMediaItem, type MediaItem, previewPath } from "./preview.ts";
import { ReplaceButton } from "./ReplaceButton.tsx";
import { percentUsed, QuotaNotice } from "./StorageCard.tsx";
import { DeleteDialog, DeleteForeverDialog, EmptyTrashDialog, RestoreButton } from "./TrashDialogs.tsx";
import { type MediaUses, UsedIn } from "./UsedIn.tsx";

type MediaList = Awaited<ReturnType<ApiClient["media"]["list"]>>;
type MediaFolders = Awaited<ReturnType<ApiClient["media"]["folders"]["list"]>>;
type MediaOverview = Awaited<ReturnType<ApiClient["media"]["overview"]>>;

/** How the files show: a list (the default) or a grid of pictures. */
export const MEDIA_VIEWS = ["list", "grid"] as const;
export type MediaView = (typeof MEDIA_VIEWS)[number];

export type MediaLibrarySearch = {
	folder?: string;
	q?: string;
	kind?: MediaKind;
	file?: string;
	trash?: boolean;
	view?: MediaView;
	language?: string;
};

/** Where an upload stands: how many files of how many are done, and the one going now. */
type Uploading = { total: number; done: number; name: string };

/**
 * The Media library screen: folders and the Trash in a column of their own, the files as a list or a
 * grid (searched and filtered by kind), and the file that is open in a sheet over the page, with its
 * Focal point, its texts in each of the Site's languages, its sizes, where it is used, Replace,
 * Download and Delete. Uploading, filing and changing texts follow the person's Permissions:
 * `media.upload` (their own uploads) and `media.manage` (every file, folders).
 */
export function MediaLibrary({
	siteId,
	permissions,
	languages,
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
	languages: { default: string; all: readonly string[] };
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
	const [uploading, setUploading] = useState<Uploading | null>(null);
	const [dragging, setDragging] = useState(false);
	const folderId = search.folder && search.folder !== "none" ? search.folder : null;
	// All files, unfiltered: the header says what the Site's whole library takes too.
	const allFiles = !inTrash && search.folder === undefined && !search.q && !search.kind;
	const view: MediaView = search.view ?? "list";
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
		const api = await getApi();
		for (const [index, file] of files.entries()) {
			setUploading({ total: files.length, done: index, name: file.name });
			try {
				await api.media.upload({ siteId, file, folderId });
				toast.success(t("media.uploaded", { name: file.name }));
			} catch (failure) {
				toast.error(t("media.uploadFailed", { name: file.name, reason: t(errorMessage(failure)) }));
			}
		}
		setUploading(null);
		await onChanged();
	};

	const drop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		void upload([...event.dataTransfer.files]);
	};

	const folder = folders.folders.find((each) => each.id === search.folder) ?? null;
	const heading = inTrash
		? t("media.trash.heading")
		: search.folder === "none"
			? t("media.folders.none")
			: (folder?.name ?? t("media.folders.all"));

	return (
		<MediaHostProvider value={ADMIN_HOST}>
			<PageAside>
				<MediaSidebar
					siteId={siteId}
					folders={folders}
					overview={overview}
					search={search}
					canManage={canManage}
					onChanged={onChanged}
				/>
			</PageAside>

			<section
				aria-label={heading}
				className={`relative grid min-w-0 content-start gap-5 rounded-xl ${dragging ? "ring-primary ring-offset-background ring-2 ring-offset-8" : ""}`}
				onDragOver={(event) => {
					if (!canUpload) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
				}}
				onDrop={canUpload ? drop : undefined}
			>
				<PhoneFolders siteId={siteId} folders={folders} search={search} />
				<div className="[&>div]:mb-0">
					<PageHeader
						heading={heading}
						action={
							inTrash ? (
								canManage && overview.trash.count > 0 ? (
									<EmptyTrashDialog
										siteId={siteId}
										onEmptied={async () => {
											onSearch({ file: undefined });
											await onChanged();
										}}
									/>
								) : null
							) : canUpload ? (
								<UploadButton
									siteId={siteId}
									folderId={folderId}
									busy={uploading !== null}
									onFiles={upload}
									onImported={onChanged}
								/>
							) : null
						}
					>
						{inTrash
							? t("media.trash.intro")
							: allFiles
								? t("media.countAndSize", { count: list.total, size: formatBytes(overview.siteBytes) })
								: t("media.count", { count: list.total })}
					</PageHeader>
				</div>

				<QuotaNotice storage={overview.storage} />

				<Toolbar search={search} onSearch={onSearch} view={view} />

				{uploading ? <UploadProgress uploading={uploading} /> : null}
				<p role="status" aria-live="polite" className="sr-only">
					{uploading
						? t("media.uploadingOne", { done: uploading.done + 1, total: uploading.total, name: uploading.name })
						: ""}
				</p>

				{list.items.length === 0 ? (
					<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
						{list.total === 0 && !search.q && !search.kind
							? inTrash
								? t("media.trash.empty")
								: t("media.empty")
							: t("media.noMatch")}
					</p>
				) : view === "grid" ? (
					<FileGrid siteId={siteId} items={list.items} selectedId={selected?.id} />
				) : (
					<FileTable
						siteId={siteId}
						items={list.items}
						selectedId={selected?.id}
						language={list.items[0]?.language ?? languages.default}
						inTrash={inTrash}
					/>
				)}

				{list.total > list.items.length ? (
					<p className="text-muted-foreground text-center text-sm">
						{t("media.shownOf", { shown: list.items.length, total: list.total })}
					</p>
				) : null}

				{canUpload ? (
					<p className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 text-center text-xs">
						<span>{t("media.dropHint")}</span>
						<span aria-hidden="true">·</span>
						<span>{t("media.formats", { size: formatBytes(overview.maxFileBytes) })}</span>
					</p>
				) : null}
			</section>

			<DetailsSheet
				siteId={siteId}
				item={selected}
				folders={folders.folders}
				usedIn={usedIn}
				permissions={permissions}
				languages={languages}
				altTextSuggestions={overview.altTextSuggestions}
				onChanged={onChanged}
				onClose={() => onSearch({ file: undefined, language: undefined })}
				onClosed={async () => {
					onSearch({ file: undefined, language: undefined });
					await onChanged();
				}}
			/>
		</MediaHostProvider>
	);
}

/** Upload, and beside it a menu with Import from URL. */
function UploadButton({
	siteId,
	folderId,
	busy,
	onFiles,
	onImported,
}: {
	siteId: string;
	folderId: string | null;
	busy: boolean;
	onFiles(files: readonly File[]): Promise<void>;
	onImported(): Promise<void>;
}) {
	const t = useT();
	const fileInput = useRef<HTMLInputElement>(null);
	const more = useRef<HTMLButtonElement>(null);
	const [importing, setImporting] = useState(false);
	return (
		<div className="flex">
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				tabIndex={-1}
				aria-hidden="true"
				onChange={(event) => {
					void onFiles([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
			<Button className="rounded-e-none" onClick={() => fileInput.current?.click()} disabled={busy}>
				{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <UploadIcon aria-hidden="true" />}
				{t("media.upload")}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={more}
					render={
						<Button
							size="icon"
							className="border-primary-foreground/20 rounded-s-none border-s"
							aria-label={t("media.uploadMore")}
						/>
					}
				>
					<ChevronDownIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-48">
					<DropdownMenuItem onClick={() => setImporting(true)}>
						<LinkIcon aria-hidden="true" />
						{t("media.importUrl")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<ImportDialog
				siteId={siteId}
				folderId={folderId}
				onImported={onImported}
				open={importing}
				onOpenChange={setImporting}
				finalFocus={more}
			/>
		</div>
	);
}

/** How far an upload is: a bar of the files done, and the one going now. */
function UploadProgress({ uploading }: { uploading: Uploading }) {
	const t = useT();
	const id = useId();
	return (
		<div className="grid gap-2 rounded-lg border p-3 text-sm">
			<p id={id} className="flex items-center gap-2">
				<LoaderIcon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
				<span className="min-w-0 truncate">
					{t("media.uploadingOne", { done: uploading.done + 1, total: uploading.total, name: uploading.name })}
				</span>
			</p>
			<progress
				aria-labelledby={id}
				max={uploading.total}
				value={uploading.done}
				className="[&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full"
			/>
		</div>
	);
}

/** Search by name or alt text, the kind of file, and the list or the grid. */
function Toolbar({
	search,
	onSearch,
	view,
}: {
	search: MediaLibrarySearch;
	onSearch(next: MediaLibrarySearch, options?: { replace?: boolean }): void;
	view: MediaView;
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

	const views: { value: MediaView; label: MessageKey; icon: typeof ListIcon }[] = [
		{ value: "list", label: "media.view.list", icon: ListIcon },
		{ value: "grid", label: "media.view.grid", icon: LayoutGridIcon },
	];
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="w-full max-w-80">
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
			<div className="w-40">
				<Label htmlFor="media-kind" className="sr-only">
					{t("media.kinds.label")}
				</Label>
				<NativeSelect
					id="media-kind"
					className="w-full"
					value={search.kind ?? ""}
					onChange={(event) => onSearch({ kind: (event.target.value || undefined) as MediaKind | undefined })}
				>
					<NativeSelectOption value="">{t("media.kinds.allTypes")}</NativeSelectOption>
					{MEDIA_KINDS.map((kind) => (
						<NativeSelectOption key={kind} value={kind}>
							{t(`media.kinds.${kind}`)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			<fieldset className="bg-muted ms-auto inline-flex gap-0.5 rounded-md p-0.5">
				<legend className="sr-only">{t("media.view.label")}</legend>
				{views.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={view === option.value}
						aria-label={t(option.label)}
						title={t(option.label)}
						onClick={() => onSearch({ view: option.value === "list" ? undefined : option.value })}
						className="text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground focus-visible:ring-ring/50 flex size-8 items-center justify-center rounded-sm transition-colors outline-none focus-visible:ring-3 aria-pressed:shadow-sm"
					>
						<option.icon className="size-4" aria-hidden="true" />
					</button>
				))}
			</fieldset>
		</div>
	);
}

/** A file's state while it isn't ready: being processed, or refused by the worker. */
function StatusChip({ item }: { item: MediaItem }) {
	const t = useT();
	if (item.status === "ready") return null;
	return (
		<Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
			{t(item.status === "failed" ? "media.failed" : "media.processing")}
		</Badge>
	);
}

/** The link that opens a file's details, keeping what the library shows. */
function fileLink(siteId: string, id: string) {
	return {
		to: "/sites/$siteId/media" as const,
		params: { siteId },
		search: (previous: MediaLibrarySearch) => ({ ...previous, file: id }),
	};
}

/**
 * The files as a list: a picture, the name, the alt text, the kind, its pixels, size, when it was
 * added and in how many places it is used (what Used in lists).
 */
function FileTable({
	siteId,
	items,
	selectedId,
	language,
	inTrash,
}: {
	siteId: string;
	items: readonly ListedMediaItem[];
	selectedId: string | undefined;
	language: string;
	inTrash: boolean;
}) {
	const t = useT();
	return (
		<div className="overflow-hidden rounded-lg border">
			<Table aria-label={t("media.listLabel")} className="min-w-200 table-fixed">
				<colgroup>
					<col />
					<col />
					<col className="w-32" />
					<col className="w-28" />
					<col className="w-24" />
					<col className="w-36" />
					<col className="w-20" />
				</colgroup>
				<TableHeader className="bg-muted/50">
					<TableRow className="hover:bg-transparent">
						<TableHead className="text-muted-foreground px-4">{t("media.columns.name")}</TableHead>
						<TableHead className="text-muted-foreground px-4">
							{t("media.columns.alt", { language: language.toUpperCase() })}
						</TableHead>
						<TableHead className="text-muted-foreground px-4">{t("media.columns.type")}</TableHead>
						<TableHead className="text-muted-foreground px-4">{t("media.columns.pixels")}</TableHead>
						<TableHead className="text-muted-foreground px-4">{t("media.columns.size")}</TableHead>
						<TableHead className="text-muted-foreground px-4">
							{inTrash ? t("media.columns.deleted") : t("media.columns.added")}
						</TableHead>
						<TableHead className="text-muted-foreground px-4">{t("media.columns.used")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.map((item) => {
						const image = imagePreview(siteId, item, 160);
						const Icon = KIND_ICONS[item.kind];
						const current = item.id === selectedId;
						return (
							<TableRow key={item.id} data-state={current ? "selected" : undefined}>
								<TableCell className="px-4 py-2">
									<div className="flex min-w-0 items-center gap-3">
										<span className="bg-muted flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md">
											{image ? (
												<img src={image} alt="" loading="lazy" className="size-full object-cover" />
											) : (
												<Icon className="text-muted-foreground size-4" aria-hidden="true" />
											)}
										</span>
										<Link
											{...fileLink(siteId, item.id)}
											aria-current={current ? "true" : undefined}
											className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
										>
											{item.fileName}
										</Link>
										<StatusChip item={item} />
									</div>
								</TableCell>
								<TableCell className="px-4 py-2">
									{item.kind !== "image" ? (
										<span className="text-muted-foreground">—</span>
									) : item.alt ? (
										<span className="block truncate" lang={item.language}>
											{item.alt}
										</span>
									) : (
										<span className="text-muted-foreground italic">{t("media.noAlt")}</span>
									)}
								</TableCell>
								<TableCell className="text-muted-foreground truncate px-4 py-2">{item.contentType}</TableCell>
								<TableCell className="text-muted-foreground px-4 py-2 tabular-nums">
									{item.width && item.height ? `${item.width}×${item.height}` : "—"}
								</TableCell>
								<TableCell className="text-muted-foreground px-4 py-2 tabular-nums">
									{formatBytes(item.sizeBytes)}
								</TableCell>
								<TableCell className="text-muted-foreground px-4 py-2">
									<When value={inTrash ? (item.trashedAt ?? item.createdAt) : item.createdAt} />
								</TableCell>
								<TableCell className="text-muted-foreground px-4 py-2 tabular-nums">
									<span aria-hidden="true">{item.uses}</span>
									<span className="sr-only">{t("media.usedIn.count", { count: item.uses })}</span>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}

/** The files as a grid of pictures in their own shapes; images without alt text say so. */
function FileGrid({
	siteId,
	items,
	selectedId,
}: {
	siteId: string;
	items: readonly MediaItem[];
	selectedId: string | undefined;
}) {
	const t = useT();
	return (
		<ul aria-label={t("media.listLabel")} className="columns-[11rem] gap-2">
			{items.map((item) => {
				const current = item.id === selectedId;
				const image = imagePreview(siteId, item, 480);
				const Icon = KIND_ICONS[item.kind];
				const ratio = item.width && item.height ? `${item.width} / ${item.height}` : "4 / 3";
				return (
					<li key={item.id} className="mb-2 break-inside-avoid">
						<Link
							{...fileLink(siteId, item.id)}
							aria-current={current ? "true" : undefined}
							title={item.fileName}
							className={`bg-muted focus-visible:ring-ring/50 relative flex items-center justify-center overflow-hidden rounded-lg outline-none focus-visible:ring-3 ${
								current ? "ring-primary ring-2" : "hover:ring-border hover:ring-2"
							}`}
							style={{ aspectRatio: ratio }}
						>
							{image ? (
								<>
									<img src={image} alt="" loading="lazy" className="size-full object-cover" />
									<span className="sr-only">{item.fileName}</span>
								</>
							) : (
								<span className="text-muted-foreground grid justify-items-center gap-2 p-3 text-center text-xs">
									<Icon className="size-8" aria-hidden="true" />
									<span className="line-clamp-2 break-all">{item.fileName}</span>
								</span>
							)}
							<span className="absolute start-2 bottom-2 flex flex-wrap gap-1">
								<StatusChip item={item} />
								{item.kind === "image" && item.status === "ready" && !item.alt ? (
									<span className="flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white">
										<TriangleAlertIcon className="size-3" aria-hidden="true" />
										{t("media.noAltShort")}
									</span>
								) : null}
							</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The library's own column, where the secondary sidebar is: All files, Unfiled, the folders (with
 * New folder for Editors, Owners and Staff), the Trash, and at its foot how many files there are and
 * how much of the Workspace's storage they take.
 */
function MediaSidebar({
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
	const id = useId();
	const [creating, setCreating] = useState(false);
	const newButton = useRef<HTMLButtonElement>(null);
	const filed = folders.folders.reduce((sum, folder) => sum + folder.count, 0);
	const keep = { q: search.q, kind: search.kind, view: search.view };
	const row = (folder: string | undefined, trash = false) =>
		(trash ? search.trash === true : !search.trash && search.folder === folder) ? ("page" as const) : undefined;
	const storage = overview.storage;
	return (
		<SecondarySidebar labelledBy={`${id}-title`} className="gap-0">
			<SecondaryTitle id={`${id}-title`}>{t("media.heading")}</SecondaryTitle>
			<SecondaryList aria-labelledby={`${id}-title`}>
				<li>
					<Link
						to="/sites/$siteId/media"
						params={{ siteId }}
						search={keep}
						aria-current={row(undefined)}
						className={secondaryRowClass}
					>
						<ImagesIcon aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate">{t("media.folders.all")}</span>
						<Count value={folders.total} />
					</Link>
				</li>
				<li>
					<Link
						to="/sites/$siteId/media"
						params={{ siteId }}
						search={{ ...keep, folder: "none" }}
						aria-current={row("none")}
						className={secondaryRowClass}
					>
						<FolderOpenIcon aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate">{t("media.folders.none")}</span>
						<Count value={Math.max(0, folders.total - filed)} />
					</Link>
				</li>
			</SecondaryList>
			<SecondaryLabel id={`${id}-folders`} className="mt-2">
				{t("media.folders.heading")}
			</SecondaryLabel>
			<SecondaryList aria-labelledby={`${id}-folders`}>
				{folders.folders.map((folder) => (
					<li key={folder.id} className="group/folder relative">
						<Link
							to="/sites/$siteId/media"
							params={{ siteId }}
							search={{ ...keep, folder: folder.id }}
							aria-current={row(folder.id)}
							className={`${secondaryRowClass} ${canManage ? "pe-9" : ""}`}
						>
							<FolderIcon aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate">{folder.name}</span>
							<Count value={folder.count} />
						</Link>
						{canManage ? (
							<div className="absolute end-0.5 top-0.5">
								<FolderActions siteId={siteId} folder={folder} onChanged={onChanged} />
							</div>
						) : null}
					</li>
				))}
			</SecondaryList>
			{canManage ? (
				<>
					<Button ref={newButton} variant="outline" size="sm" className="mt-2 w-full" onClick={() => setCreating(true)}>
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
			<SecondaryList className="mt-3 border-t pt-3">
				<li>
					<Link
						to="/sites/$siteId/media"
						params={{ siteId }}
						search={{ trash: true, view: search.view }}
						aria-current={row(undefined, true)}
						className={secondaryRowClass}
					>
						<Trash2Icon aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate">{t("media.trash.folder")}</span>
						<Count value={overview.trash.count} />
					</Link>
				</li>
			</SecondaryList>
			<div className="mt-auto grid grid-cols-2 gap-2 pt-4">
				<div className="bg-muted/60 grid gap-0.5 rounded-lg p-2.5">
					<p className="text-sm font-semibold tabular-nums">{folders.total}</p>
					<p className="text-muted-foreground text-xs">{t("media.tiles.files", { count: folders.total })}</p>
				</div>
				<div className="bg-muted/60 grid gap-1 rounded-lg p-2.5">
					<p className="truncate text-sm font-semibold tabular-nums">{formatBytes(storage.usedBytes)}</p>
					<p className="text-muted-foreground truncate text-xs">
						{storage.quotaBytes === null
							? t("media.tiles.used")
							: t("media.tiles.of", { quota: formatBytes(storage.quotaBytes) })}
					</p>
					{storage.quotaBytes !== null ? (
						<meter
							aria-label={t("media.storage.label")}
							min={0}
							max={100}
							low={80}
							high={99}
							optimum={0}
							value={percentUsed(storage)}
							className="h-1 w-full"
						/>
					) : null}
				</div>
			</div>
		</SecondarySidebar>
	);
}

/** A row's count, as the sidebar shows it. */
function Count({ value }: { value: number }) {
	return <span className="text-muted-foreground ms-auto text-xs tabular-nums">{value}</span>;
}

/** On a phone the column has no room beside the list: the same places as one select above it. */
function PhoneFolders({
	siteId,
	folders,
	search,
}: {
	siteId: string;
	folders: MediaFolders;
	search: MediaLibrarySearch;
}) {
	const t = useT();
	const navigate = useNavigate();
	const value = search.trash ? "trash" : (search.folder ?? "");
	return (
		<div className="md:hidden">
			<Label htmlFor="media-place" className="sr-only">
				{t("media.folders.heading")}
			</Label>
			<NativeSelect
				id="media-place"
				className="w-full"
				value={value}
				onChange={(event) => {
					const next = event.target.value;
					void navigate({
						to: "/sites/$siteId/media",
						params: { siteId },
						search: next === "trash" ? { trash: true } : { folder: next || undefined },
					});
				}}
			>
				<NativeSelectOption value="">{t("media.folders.all")}</NativeSelectOption>
				<NativeSelectOption value="none">{t("media.folders.none")}</NativeSelectOption>
				{folders.folders.map((folder) => (
					<NativeSelectOption key={folder.id} value={folder.id}>
						{folder.name}
					</NativeSelectOption>
				))}
				<NativeSelectOption value="trash">{t("media.trash.folder")}</NativeSelectOption>
			</NativeSelect>
		</div>
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

/**
 * The open file, in a sheet over the page (frame 02): its picture with the Focal point, what it is
 * and where its file is, its title, alt text and caption in each of the Site's languages, the sizes
 * made of it, its folder and where it is used; Replace file, Download and Delete. People who may not
 * change it read it. A file in the Trash says when it goes for good, with Restore and Delete for good.
 */
function DetailsSheet({
	siteId,
	item,
	folders,
	usedIn,
	permissions,
	languages,
	altTextSuggestions,
	onChanged,
	onClose,
	onClosed,
}: {
	siteId: string;
	item: MediaItem | null;
	folders: readonly MediaFolder[];
	usedIn: MediaUses;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	altTextSuggestions: boolean;
	onChanged(): Promise<void>;
	/** Closes the sheet. */
	onClose(): void;
	/** After the file left the view it was open in (moved to the Trash, restored, deleted for good). */
	onClosed(): Promise<void>;
}) {
	const t = useT();
	// The sheet keeps its last file while it closes, so its contents never blink away first.
	const last = useRef(item);
	if (item) last.current = item;
	const shown = item ?? last.current;
	const trashed = shown?.trashedAt != null;
	const editable = Boolean(shown?.canEdit) && !trashed;
	return (
		<PageSheet
			open={item !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={shown?.fileName ?? t("media.details.heading")}
			description={shown ? <FileFacts item={shown} /> : null}
			className="data-[side=right]:sm:max-w-4xl"
			footer={
				shown ? (
					trashed ? (
						shown.canEdit ? (
							<>
								<RestoreButton siteId={siteId} item={shown} onRestored={onClosed} />
								<DeleteForeverDialog siteId={siteId} item={shown} onDeleted={onClosed} />
							</>
						) : null
					) : (
						<>
							{editable ? (
								<div className="me-auto">
									<DeleteDialog siteId={siteId} item={shown} onDeleted={onClosed} />
								</div>
							) : null}
							{editable ? <ReplaceButton siteId={siteId} item={shown} onChanged={onChanged} /> : null}
							{shown.url ? (
								<Button
									variant="outline"
									nativeButton={false}
									render={<a href={previewPath(siteId, shown.url)} download={shown.fileName} />}
								>
									<DownloadIcon aria-hidden="true" />
									{t("media.details.download")}
								</Button>
							) : null}
							{editable ? (
								<Button type="submit" form="media-details-form">
									{t("media.details.save")}
								</Button>
							) : null}
						</>
					)
				) : null
			}
		>
			{shown ? (
				<Details
					key={`${shown.id}:${shown.language}:${shown.updatedAt.toString()}:${shown.status}`}
					siteId={siteId}
					item={shown}
					folders={folders}
					usedIn={usedIn}
					permissions={permissions}
					languages={languages}
					editable={editable}
					altTextSuggestions={altTextSuggestions}
					onChanged={onChanged}
				/>
			) : null}
		</PageSheet>
	);
}

/** What a file is, in short: its format, size and pixels. */
function FileFacts({ item }: { item: MediaItem }) {
	const t = useT();
	const format = item.contentType.split("/")[1]?.replace(/\+.*$/, "").toUpperCase() ?? item.contentType;
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			<Badge variant="outline" className="font-mono">
				{format}
			</Badge>
			<Badge variant="outline" className="font-mono">
				{formatBytes(item.sizeBytes)}
			</Badge>
			{item.width && item.height ? (
				<Badge variant="outline" className="font-mono">
					{t("media.details.dimensionsValue", { width: item.width, height: item.height })}
				</Badge>
			) : null}
			<StatusChip item={item} />
		</span>
	);
}

function Details({
	siteId,
	item,
	folders,
	usedIn,
	permissions,
	languages,
	editable,
	altTextSuggestions,
	onChanged,
}: {
	siteId: string;
	item: MediaItem;
	folders: readonly MediaFolder[];
	usedIn: MediaUses;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	editable: boolean;
	altTextSuggestions: boolean;
	onChanged(): Promise<void>;
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
	const [copied, setCopied] = useState("");
	const preview = imagePreview(siteId, item, 960);
	const Icon = KIND_ICONS[item.kind];
	const trashed = item.trashedAt !== null;
	const widths = [...new Set(item.variants.map((variant) => variant.width))].sort((a, b) => a - b);

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
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
			const { alt: suggested } = await (
				await getApi()
			).media.suggestAltText({
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

	const copy = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(t("media.details.copied"));
		} catch {
			setCopied("");
		}
	};

	return (
		<div className="@container/details">
			<div className="grid gap-6 @2xl/details:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
				<div className="grid content-start gap-4">
					{editable && item.kind === "image" && preview ? (
						<FocalPointPicker src={preview} value={focalPoint} onChange={setFocalPoint} />
					) : (
						<div className="bg-muted flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg">
							{preview ? (
								<img src={preview} alt="" className="size-full object-contain" />
							) : (
								<Icon className="text-muted-foreground size-10" aria-hidden="true" />
							)}
						</div>
					)}
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
				</div>

				<div className="grid content-start gap-5 text-sm">
					{trashed ? (
						<div className="grid gap-1">
							<Badge variant="secondary" className="w-fit">
								{t("media.trash.badge")}
							</Badge>
							<p>{t("media.trash.deletedOn", { date: formatUtcDate(item.trashedAt ?? item.updatedAt) })}</p>
							<p className="text-muted-foreground">
								{t("media.trash.purgeOn", { date: formatUtcDate(item.purgeAt ?? item.updatedAt) })}
							</p>
						</div>
					) : null}

					<section aria-labelledby="media-file-heading" className="grid gap-2">
						<h3 id="media-file-heading" className="text-muted-foreground text-xs font-medium">
							{t("media.details.file")}
						</h3>
						{item.url ? (
							<div className="flex min-w-0 items-center gap-2">
								<code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={item.url}>
									{item.url}
								</code>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={t("media.details.copy")}
									title={t("media.details.copy")}
									onClick={() => void copy(item.url ?? "")}
								>
									<CopyIcon aria-hidden="true" />
								</Button>
							</div>
						) : null}
						<p role="status" className="text-muted-foreground text-xs empty:hidden">
							{copied}
						</p>
						<p className="text-muted-foreground">
							{item.uploadedBy
								? t("media.details.uploadedBy", { date: formatUtcDate(item.createdAt), name: item.uploadedBy.name })
								: formatUtcDate(item.createdAt)}
						</p>
					</section>

					{languages.all.length > 1 ? (
						<nav aria-label={t("media.details.languages")} className="flex flex-wrap gap-1">
							{languages.all.map((language) => (
								<Link
									key={language}
									to="/sites/$siteId/media"
									params={{ siteId }}
									search={(previous: MediaLibrarySearch) => ({
										...previous,
										language: language === languages.default ? undefined : language,
									})}
									aria-current={language === item.language ? "page" : undefined}
									className="text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground focus-visible:ring-ring/50 rounded-md px-2 py-1 font-mono text-xs font-semibold uppercase outline-none focus-visible:ring-3"
								>
									{language}
								</Link>
							))}
						</nav>
					) : null}

					{editable ? (
						<form id="media-details-form" onSubmit={save} className="grid gap-5" noValidate>
							<FieldGroup className="gap-4">
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
									<FieldLabel htmlFor="media-title">{t("media.details.title")}</FieldLabel>
									<Input
										id="media-title"
										value={title}
										onChange={(event) => setTitle(event.target.value)}
										maxLength={200}
										lang={item.language}
									/>
								</Field>
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
									<NativeSelect
										id="media-folder"
										value={folderId}
										onChange={(event) => setFolderId(event.target.value)}
									>
										<NativeSelectOption value="">{t("media.folders.none")}</NativeSelectOption>
										{folders.map((folder) => (
											<NativeSelectOption key={folder.id} value={folder.id}>
												{folder.name}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
							</FieldGroup>
							{error ? <FieldError>{t(error)}</FieldError> : null}
						</form>
					) : (
						<div className="grid gap-4">
							<dl className="grid gap-3">
								{(
									[
										...(item.kind === "image" ? ([["media.details.alt", item.alt]] as const) : []),
										["media.details.title", item.title],
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

					{widths.length > 0 ? (
						<section aria-labelledby="media-sizes-heading" className="grid gap-2">
							<h3 id="media-sizes-heading" className="text-muted-foreground text-xs font-medium">
								{t("media.details.sizesMade")}
							</h3>
							<ul className="flex flex-wrap gap-1.5">
								{widths.map((width) => (
									<li key={width}>
										<Badge variant="outline" className="font-mono">
											{width}
										</Badge>
									</li>
								))}
							</ul>
						</section>
					) : null}

					{trashed ? null : <UsedIn siteId={siteId} usedIn={usedIn} permissions={permissions} />}
				</div>
			</div>
		</div>
	);
}
