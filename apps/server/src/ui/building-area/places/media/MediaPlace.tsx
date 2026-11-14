import { MEDIA_KINDS, type MediaKind } from "@webcraft/core/media-kinds";
import { LayoutGridIcon, ListIcon, SearchIcon } from "lucide-react";
import {
	type DragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { errorMessage } from "../../../errors.ts";
import { useT } from "../../../i18n.tsx";
import type { MediaApi } from "../../../media/host.tsx";
import { formatBytes } from "../../../media/preview.ts";
import { QuotaNotice } from "../../../media/StorageCard.tsx";
import { EmptyTrashDialog } from "../../../media/TrashDialogs.tsx";
import { fill } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { managementApi } from "../../management.ts";
import { FilterMenu } from "../content/ui.tsx";
import { rememberPlace, rememberScroll, scrollOf } from "../memory.ts";
import { Place } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import { Details } from "./Details.tsx";
import { type ListedMediaItem, useMediaData, useOpenFile } from "./data.ts";
import { type FileActions, FileGrid, FileList } from "./Files.tsx";
import { copyAddress, UploadButton, UploadProgress, useUpload } from "./parts.tsx";
import { DeleteFilesDialog, downloadAll, SelectionBar } from "./Selection.tsx";
import { MediaSidebar, MediaTiles } from "./Sidebar.tsx";
import { ShellMedia } from "./shell.tsx";
import { notify } from "./toasts.tsx";
import { type MediaPart, type MediaView, partOf, placeOf, printView, readView, viewFor } from "./view.ts";

/**
 * The Media place (SPEC 8 and 13.6; `places-assets/01` to `03`): a column of 300 with All files,
 * Unfiled, the folders, New Folder and the Trash, with the library's file count and storage at its
 * foot; beside it a card with the files as a list (the default) or a masonry grid, searched and
 * filtered by kind; files selected for Move to Folder, Download and Delete; a file's details in place;
 * Upload (and Import from URL), also by dropping files on the card. Members get the same place: what
 * they may change follows `media.upload` and `media.manage`, as in the admin. The admin's Media parts
 * (`ui/media/*`) are reused through the shell's Media host (`shell.tsx`).
 */
export function MediaPlace(props: PlaceProps) {
	return (
		<ShellMedia config={props.config}>
			<MediaPlaceBody {...props} />
		</ShellMedia>
	);
}

function MediaPlaceBody({ config, words, place, view: viewText, documents, leave, announce, onSaving }: PlaceProps) {
	const t = useT();
	const shown = words.media;
	const siteId = config.site.id;
	const api: MediaApi = useMemo(() => managementApi(config.token).media, [config.token]);
	const part = partOf(place);
	const view = readView(viewText);
	const trash = part.kind === "trash";
	const canUpload = config.permissions.includes("media.upload") && !trash;
	const canManage = config.permissions.includes("media.manage");
	const { data, failed, reload } = useMediaData(api, siteId, part, view);
	const [version, setVersion] = useState(0);
	const changed = useCallback(async () => {
		setVersion((was) => was + 1);
		await reload();
	}, [reload]);
	const languages = config.languages.all;
	const opened = useOpenFile(
		api,
		siteId,
		view.file,
		languages.map((each) => each.code),
		version,
	);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [deleting, setDeleting] = useState<readonly ListedMediaItem[]>([]);
	const deleteOpener = useRef<HTMLElement | null>(null);
	const [dragging, setDragging] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const restored = useRef<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);

	useEffect(() => rememberPlace(place, viewText), [place, viewText]);

	// The selection belongs to the list shown: another folder, search or kind starts none.
	const listKey = `${place}?${view.q}&${view.kind ?? ""}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: cleared when the list shown changes (`listKey`).
	useEffect(() => setSelected(new Set()), [listKey]);

	// The list's scroll: where it was left, once there is something to scroll; remembered as it moves.
	const scrollKey = `${place}?${viewText ?? ""}`;
	useLayoutEffect(() => {
		if (!data || view.file || restored.current === scrollKey || !scroller.current) return;
		restored.current = scrollKey;
		scroller.current.scrollTop = scrollOf(place, viewText);
	}, [data, scrollKey, place, viewText, view.file]);

	const setView = (next: MediaView, how: "push" | "replace" = "push") => documents.setView(printView(next), how);
	const go = (next: MediaPart) => documents.openPlace(placeOf(next), printView(viewFor(next, view)));
	const folderId = part.kind === "folder" ? part.folderId : null;

	const { uploading, upload } = useUpload({
		api,
		siteId,
		folderId,
		onDone: async (made) => {
			if (made.length) announce(fill(shown.uploaded, { count: String(made.length) }));
			await changed();
		},
	});

	const items = data?.list.items ?? [];
	const byId = new Map(items.map((item) => [item.id, item]));
	const chosen = [...selected].map((id) => byId.get(id)).filter((item): item is ListedMediaItem => Boolean(item));

	const move = async (files: readonly ListedMediaItem[], to: string | null) => {
		const name = to ? (data?.folders.folders.find((folder) => folder.id === to)?.name ?? "") : t("media.folders.none");
		onSaving("saving");
		let moved = 0;
		for (const file of files) {
			try {
				await api.update({ siteId, mediaId: file.id, folderId: to });
				moved++;
			} catch (failure) {
				notify("error", fill(shown.moveFailed, { name: file.fileName, reason: t(errorMessage(failure)) }));
			}
		}
		onSaving(moved === files.length ? "saved" : "failed");
		announce(t("media.selection.moved", { count: moved, folder: name }));
		setSelected(new Set());
		await changed();
	};

	const actions: FileActions = {
		open: (item) => setView({ ...view, file: item.id, language: null }),
		copy: (item) => void copyAddress(item, words, announce),
		move: (files, to) => void move(files, to),
		remove: (files) => {
			deleteOpener.current = document.activeElement as HTMLElement | null;
			setDeleting(files);
		},
		restore: async (item) => {
			try {
				await api.restore({ siteId, mediaId: item.id });
				notify("success", t("media.trash.restored", { name: item.fileName }));
				await changed();
				heading.current?.focus();
			} catch (failure) {
				notify("error", t(errorMessage(failure)));
			}
		},
	};

	const closeFile = () => {
		const was = view.file;
		setView({ ...view, file: null, language: null });
		// Back in the list, focus goes to the file whose details were open.
		requestAnimationFrame(() =>
			document.querySelector<HTMLElement>(`[data-wc-media-open="${was}"]`)?.focus({ preventScroll: false }),
		);
	};

	const folder = part.kind === "folder" ? data?.folders.folders.find((each) => each.id === part.folderId) : null;
	const title = trash
		? t("media.trash.heading")
		: part.kind === "unfiled"
			? t("media.folders.none")
			: part.kind === "folder"
				? (folder?.name ?? t("media.folders.all"))
				: t("media.folders.all");
	const allFiles = part.kind === "all" && !view.q && !view.kind;
	const count = data
		? trash
			? t("media.count", { count: data.list.total })
			: allFiles
				? t("media.countAndSize", { count: data.list.total, size: formatBytes(data.overview.siteBytes) })
				: t("media.count", { count: data.list.total })
		: "";
	const openItem = view.file ? (opened.file?.item ?? byId.get(view.file) ?? null) : null;

	const drop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		if (canUpload) void upload([...event.dataTransfer.files]);
	};

	const sidebar = data ? (
		<MediaSidebar
			words={words}
			siteId={siteId}
			part={part}
			folders={data.folders}
			trashCount={data.overview.trash.count}
			canManage={canManage}
			onGo={go}
			onChanged={changed}
		/>
	) : (
		<span />
	);

	let body: ReactNode;
	if (failed && !data) {
		body = (
			<p role="alert" className="text-chrome-danger m-0 p-5 text-[12px]">
				{fill(shown.loadFailed, { reason: failed })}
			</p>
		);
	} else if (!data) {
		body = (
			<p role="status" className="text-chrome-muted m-0 p-5 text-[12px]">
				{shown.loading}
			</p>
		);
	} else if (view.file) {
		body = (
			<Details
				words={words}
				api={api}
				siteId={siteId}
				language={config.language}
				languages={languages}
				items={items}
				open={opened.file}
				failed={opened.failed}
				folders={data.folders}
				permissions={config.permissions}
				shownLanguage={view.language}
				onLanguage={(language) => setView({ ...view, language }, "replace")}
				onOpen={(item) => setView({ ...view, file: item.id }, "replace")}
				onClose={closeFile}
				onChanged={changed}
				onRemoved={async () => {
					setView({ ...view, file: null, language: null });
					await changed();
				}}
				onSaving={onSaving}
				announce={announce}
			/>
		);
	} else {
		body = (
			<div
				ref={scroller}
				className="min-h-0 grow overflow-auto p-2"
				onScroll={(event) => rememberScroll(place, viewText, event.currentTarget.scrollTop)}
				data-wc-place-scroll=""
			>
				<QuotaNotice storage={data.overview.storage} />
				{items.length === 0 ? (
					<p className="border-chrome-hover text-chrome-muted m-2 rounded-lg border border-dashed p-8 text-center text-[12px]">
						{data.list.total === 0 && !view.q && !view.kind
							? trash
								? t("media.trash.empty")
								: t("media.empty")
							: t("media.noMatch")}
					</p>
				) : view.layout === "grid" ? (
					<FileGrid
						words={words}
						siteId={siteId}
						items={items}
						trash={trash}
						selected={selected}
						onSelect={(id, on) => setSelected((was) => toggled(was, id, on))}
						actions={actions}
					/>
				) : (
					<FileList
						words={words}
						siteId={siteId}
						language={config.language}
						items={items}
						trash={trash}
						folders={data.folders}
						selected={selected}
						onSelect={(id, on) => setSelected((was) => toggled(was, id, on))}
						actions={actions}
					/>
				)}
				{data.list.total > items.length ? (
					<p className="text-chrome-muted m-0 p-3 text-center text-[12px]">
						{t("media.shownOf", { shown: items.length, total: data.list.total })}
					</p>
				) : null}
				{canUpload ? (
					<p className="text-chrome-muted m-0 p-3 text-center text-[11px]">
						{t("media.dropHint")} · {t("media.formats", { size: formatBytes(data.overview.maxFileBytes) })}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<Place
			words={words}
			title={words.places.media}
			backTo={null}
			onBack={leave}
			sidebar={sidebar}
			sidebarLabel={shown.lists}
			sidebarFoot={data ? <MediaTiles words={words} total={data.folders.total} overview={data.overview} /> : null}
			place={place}
			shape="card"
		>
			<section
				aria-labelledby="wc-media-heading"
				className={`border-chrome-line relative flex min-h-0 min-w-0 grow flex-col overflow-hidden rounded-lg border ${
					dragging ? "ring-chrome-focus ring-2" : ""
				}`}
				onDragOver={(event) => {
					if (!canUpload || !event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
				}}
				onDrop={canUpload ? drop : undefined}
				data-wc-media-card=""
			>
				<div className="border-chrome-line flex h-10 shrink-0 items-center gap-2.5 border-b px-3">
					<h2
						id="wc-media-heading"
						ref={heading}
						tabIndex={-1}
						className={`text-chrome-strong m-0 truncate rounded-sm text-[13px] font-semibold ${FOCUS_RING}`}
						data-wc-media-heading=""
					>
						{title}
					</h2>
					<span className="text-chrome-muted shrink-0 text-[12px]" data-wc-media-count="">
						{count}
					</span>
					<span className="grow" />
					{view.file && openItem ? (
						<span
							className="inline-flex h-[18px] max-w-80 items-center truncate rounded-[5px] bg-[#172554] px-1.5 text-[11px] font-medium text-[#bfdbfe]"
							data-wc-media-open-badge=""
						>
							{fill(shown.open, { name: openItem.fileName })}
						</span>
					) : (
						<>
							<SearchBox
								label={t("media.search")}
								placeholder={shown.search}
								value={view.q}
								onChange={(q) => setView({ ...view, q }, "replace")}
							/>
							{trash ? null : (
								<FilterMenu
									label={t("media.kinds.label")}
									shown={view.kind ? t(`media.kinds.${view.kind}`) : t("media.kinds.allTypes")}
									groups={[
										{
											label: null,
											choices: [
												{ key: "", label: t("media.kinds.allTypes"), current: view.kind === null },
												...MEDIA_KINDS.map((kind) => ({
													key: kind,
													label: t(`media.kinds.${kind}`),
													current: view.kind === kind,
												})),
											],
										},
									]}
									onChoose={(key) => setView({ ...view, kind: (key || null) as MediaKind | null })}
									data={{ "data-wc-media-kind": "" }}
								/>
							)}
							<fieldset className="bg-chrome-raised m-0 inline-flex gap-0.5 rounded-md border-0 p-0.5">
								<legend className="sr-only">{t("media.view.label")}</legend>
								{(
									[
										["list", ListIcon, t("media.view.list")],
										["grid", LayoutGridIcon, t("media.view.grid")],
									] as const
								).map(([layout, Glyph, label]) => (
									<button
										key={layout}
										type="button"
										aria-pressed={view.layout === layout}
										aria-label={label}
										title={label}
										onClick={() => setView({ ...view, layout })}
										className={`text-chrome-muted aria-pressed:bg-chrome-hover aria-pressed:text-chrome-strong hover:text-chrome-strong inline-grid size-6 place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`}
										data-wc-media-layout={layout}
									>
										<Glyph aria-hidden="true" className="size-3.5" />
									</button>
								))}
							</fieldset>
							{trash ? (
								canManage && data && data.overview.trash.count > 0 ? (
									<EmptyTrashDialog siteId={siteId} onEmptied={changed} />
								) : null
							) : canUpload ? (
								<UploadButton
									siteId={siteId}
									folderId={folderId}
									busy={uploading !== null}
									onFiles={(files) => void upload(files)}
									onImported={changed}
								/>
							) : null}
						</>
					)}
				</div>
				{uploading ? <UploadProgress uploading={uploading} /> : null}
				<p role="status" aria-live="polite" className="sr-only">
					{uploading
						? t("media.uploadingOne", { done: uploading.done + 1, total: uploading.total, name: uploading.name })
						: ""}
				</p>
				{body}
				{!view.file && chosen.length > 0 && data ? (
					<SelectionBar
						words={words}
						count={chosen.length}
						total={items.length}
						folders={data.folders}
						canMove={chosen.every((item) => item.canEdit)}
						onClear={() => setSelected(new Set())}
						onSelectAll={() => setSelected(new Set(items.map((item) => item.id)))}
						onMove={(to) => void move(chosen, to)}
						onDownload={() => downloadAll(chosen)}
						onDelete={() => actions.remove(chosen)}
					/>
				) : null}
			</section>
			<DeleteFilesDialog
				api={api}
				siteId={siteId}
				items={deleting}
				onOpenChange={(open) => {
					if (!open) setDeleting([]);
				}}
				finalFocus={deleteOpener}
				onDeleted={async (ids) => {
					setSelected((was) => new Set([...was].filter((id) => !ids.includes(id))));
					setDeleting([]);
					await changed();
					heading.current?.focus();
				}}
			/>
		</Place>
	);
}

function toggled(was: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
	const next = new Set(was);
	if (on) next.add(id);
	else next.delete(id);
	return next;
}

/** The search box of the card's header (200 wide, 30 high): the list follows it a moment after typing stops. */
function SearchBox({
	label,
	placeholder,
	value,
	onChange,
}: {
	label: string;
	placeholder: string;
	value: string;
	onChange(value: string): void;
}) {
	const [typed, setTyped] = useState(value);
	const latest = useRef(onChange);
	latest.current = onChange;
	useEffect(() => {
		if (typed === value) return;
		const timer = setTimeout(() => latest.current(typed), 300);
		return () => clearTimeout(timer);
	}, [typed, value]);
	return (
		<span className="relative inline-flex w-[200px]">
			<SearchIcon
				aria-hidden="true"
				className="text-chrome-muted pointer-events-none absolute start-2.5 top-2 size-3.5"
			/>
			<input
				type="search"
				aria-label={label}
				placeholder={placeholder}
				value={typed}
				onChange={(event) => setTyped(event.target.value)}
				className={`bg-chrome-raised text-chrome-text placeholder:text-chrome-faint h-[30px] w-full rounded-md border-0 ps-8 pe-2 text-[12px] ${FOCUS_RING}`}
				data-wc-media-search=""
			/>
		</span>
	);
}
