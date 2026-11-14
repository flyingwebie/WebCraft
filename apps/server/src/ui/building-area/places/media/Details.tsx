import { CopyIcon, DownloadIcon, GlobeIcon, LoaderIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import { useT } from "../../../i18n.tsx";
import { type FocalPoint, FocalPointPicker } from "../../../media/FocalPointPicker.tsx";
import type { MediaApi } from "../../../media/host.tsx";
import { imagePreview, KIND_ICONS } from "../../../media/preview.ts";
import { ReplaceButton } from "../../../media/ReplaceButton.tsx";
import { DeleteDialog, DeleteForeverDialog, RestoreButton } from "../../../media/TrashDialogs.tsx";
import { UsedInList } from "../../../media/UsedIn.tsx";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { reasonOf } from "../content/data.ts";
import type { ListedMediaItem, MediaFoldersData, OpenFile } from "./data.ts";
import { fileSize, RowButton, shortDate, Thumb } from "./parts.tsx";

const LABEL = "text-chrome-muted m-0 text-[11px] font-semibold tracking-[0.03em]";
const CHIP =
	"bg-chrome-hover text-chrome-text inline-flex h-[18px] items-center rounded-[5px] px-1.5 font-mono text-[11px]";

/** Whether a key press is meant for a field (or a menu or dialog) rather than the details: Escape stays theirs. */
function keptBy(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.matches("input:not([type='range']), textarea, select, [role='textbox']") ||
			target.closest("[role='menu'], [role='dialog'], [role='listbox']") !== null)
	);
}

/**
 * A file's details, in place (`places-assets/02`): the files beside it in a narrow column (choosing
 * another shows its details), and the open file: its picture with the Focal point (dragged, or the
 * sliders from the keyboard), its address with Copy, its format and size, its alt text in each of the
 * Site's languages (a dot on a language with none), the sizes made at upload, its folder and where it
 * is used; Replace file, Download and Delete (in the Trash: Restore and Delete for good). Changes save
 * as they are made, the alt text a moment after typing stops and when the box is left, and the Draft
 * state beside Publish says so. Escape (outside a field) closes the details.
 */
export function Details({
	words,
	api,
	siteId,
	language,
	languages,
	items,
	open,
	failed,
	folders,
	permissions,
	shownLanguage,
	onLanguage,
	onOpen,
	onClose,
	onChanged,
	onRemoved,
	onSaving,
	announce,
}: {
	words: Words;
	api: MediaApi;
	siteId: string;
	/** The person's Admin language, for dates. */
	language: string;
	/** The Site's languages, the Default language first. */
	languages: readonly { code: string; name: string }[];
	items: readonly ListedMediaItem[];
	open: OpenFile | null;
	failed: string | null;
	folders: MediaFoldersData;
	permissions: readonly string[];
	/** The language whose alt text shows (null: the Default language). */
	shownLanguage: string | null;
	onLanguage(language: string | null): void;
	onOpen(item: ListedMediaItem): void;
	onClose(): void;
	/** After a change the list shows too (alt text, folder, a new file). */
	onChanged(): Promise<void>;
	/** After the file left the list it was in (to the Trash, restored, deleted for good). */
	onRemoved(): Promise<void>;
	onSaving(status: "saving" | "saved" | "failed"): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const t = useT();
	const shown = words.media;
	const listRef = useRef<HTMLUListElement>(null);
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented || keptBy(event.target)) return;
		event.preventDefault();
		onClose();
	};

	// Focus starts on the open file in the column, so the keyboard is where the pointer was.
	const openId = open?.item.id ?? null;
	useEffect(() => {
		if (!openId) return;
		const current = listRef.current?.querySelector<HTMLElement>(`[data-wc-media-narrow="${openId}"]`);
		if (current && !listRef.current?.contains(document.activeElement)) current.focus({ preventScroll: false });
	}, [openId]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the details from anywhere inside them.
		<div className="flex min-h-0 grow" onKeyDown={onKey} data-wc-media-details="">
			<ul
				ref={listRef}
				aria-label={t("media.listLabel")}
				className="m-0 flex w-[280px] shrink-0 list-none flex-col overflow-y-auto p-2"
			>
				{items.map((item) => {
					const current = item.id === openId;
					return (
						<li key={item.id}>
							<button
								type="button"
								aria-current={current ? "true" : undefined}
								onClick={() => onOpen(item)}
								className={`flex h-12 w-full items-center gap-2 rounded-lg px-2 text-start ${
									current ? "bg-chrome-raised text-chrome-strong" : "text-chrome-text opacity-55 hover:opacity-100"
								} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-media-narrow={item.id}
							>
								<Thumb siteId={siteId} item={item} size={30} />
								<span className="min-w-0 grow truncate text-[12px] font-medium">{item.fileName}</span>
							</button>
						</li>
					);
				})}
			</ul>
			<section
				aria-label={open ? open.item.fileName : t("media.details.heading")}
				className="bg-chrome-raised border-chrome-line relative flex min-w-0 grow flex-col overflow-y-auto border-s p-4 shadow-[-12px_0_24px_rgba(0,0,0,0.35)]"
				data-wc-media-pane=""
			>
				<span className="absolute end-2 top-2">
					<RowButton
						icon={XIcon}
						label={fill(shown.closeFile, { name: open?.item.fileName ?? "" })}
						onClick={onClose}
					/>
				</span>
				{failed ? (
					<p role="alert" className="text-chrome-danger m-0 text-[12px]">
						{fill(shown.loadFailed, { reason: failed })}
					</p>
				) : open ? (
					<FileDetails
						key={open.item.id}
						words={words}
						api={api}
						siteId={siteId}
						language={language}
						languages={languages}
						open={open}
						folders={folders}
						permissions={permissions}
						shownLanguage={shownLanguage}
						onLanguage={onLanguage}
						onChanged={onChanged}
						onRemoved={onRemoved}
						onSaving={onSaving}
						announce={announce}
					/>
				) : (
					<p role="status" className="text-chrome-muted m-0 flex items-center gap-2 text-[12px]">
						<LoaderIcon aria-hidden="true" className="size-3.5 animate-spin" />
						{shown.loading}
					</p>
				)}
			</section>
		</div>
	);
}

function FileDetails({
	words,
	api,
	siteId,
	language,
	languages,
	open,
	folders,
	permissions,
	shownLanguage,
	onLanguage,
	onChanged,
	onRemoved,
	onSaving,
	announce,
}: {
	words: Words;
	api: MediaApi;
	siteId: string;
	language: string;
	languages: readonly { code: string; name: string }[];
	open: OpenFile;
	folders: MediaFoldersData;
	permissions: readonly string[];
	shownLanguage: string | null;
	onLanguage(language: string | null): void;
	onChanged(): Promise<void>;
	onRemoved(): Promise<void>;
	onSaving(status: "saving" | "saved" | "failed"): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const t = useT();
	const shown = words.media;
	const id = useId();
	const { item, texts, usedIn } = open;
	const trashed = item.trashedAt !== null;
	const editable = item.canEdit && !trashed;
	const fallback = languages[0]?.code ?? item.language;
	const code = shownLanguage && languages.some((each) => each.code === shownLanguage) ? shownLanguage : fallback;
	const [alts, setAlts] = useState<Record<string, string>>(() =>
		Object.fromEntries([...texts].map(([key, text]) => [key, text.alt ?? ""])),
	);
	const [focal, setFocal] = useState<FocalPoint | null>(item.focalPoint);
	const [folderId, setFolderId] = useState(item.folderId ?? "");
	const saved = useRef<Record<string, string>>({ ...alts });
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const preview = imagePreview(siteId, item, 960, true);
	const Glyph = KIND_ICONS[item.kind];
	const widths = [...new Set(item.variants.map((variant) => variant.width))].sort((a, b) => a - b);
	const format = item.contentType.split("/")[1]?.replace(/\+.*$/, "").toUpperCase() ?? item.contentType;

	/** Saves one change of the file, saying so beside Publish; answers whether it was saved. */
	const change = useCallback(
		async (input: Omit<Parameters<MediaApi["update"]>[0], "siteId" | "mediaId">): Promise<boolean> => {
			onSaving("saving");
			try {
				await api.update({ siteId, mediaId: item.id, ...input });
				onSaving("saved");
				await onChanged();
				return true;
			} catch (error) {
				onSaving("failed");
				announce(fill(shown.saveFailed, { reason: reasonOf(error) }), true);
				return false;
			}
		},
		[api, siteId, item.id, onSaving, onChanged, announce, shown.saveFailed],
	);

	const saveAlt = useCallback(
		async (key: string, value: string) => {
			const timer = timers.current.get(key);
			if (timer) clearTimeout(timer);
			timers.current.delete(key);
			if ((saved.current[key] ?? "") === value) return;
			if (await change({ language: key, alt: value.trim() || null })) saved.current[key] = value;
		},
		[change],
	);

	// What is typed and not saved yet is saved when the details close or another file opens.
	const latest = useRef({ alts, saveAlt });
	latest.current = { alts, saveAlt };
	useEffect(
		() => () => {
			for (const [key, value] of Object.entries(latest.current.alts)) void latest.current.saveAlt(key, value);
		},
		[],
	);

	const focalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onFocal = (next: FocalPoint | null) => {
		setFocal(next);
		if (focalTimer.current) clearTimeout(focalTimer.current);
		focalTimer.current = setTimeout(() => void change({ focalPoint: next }), 400);
	};

	const missing = (key: string) => item.kind === "image" && !(alts[key] ?? "").trim();
	const altId = `${id}-alt`;

	return (
		<div className="grid min-h-full [grid-template-columns:minmax(0,420px)_minmax(0,1fr)] gap-6">
			<div className="flex min-w-0 flex-col justify-center gap-2" data-wc-media-picture="">
				{editable && item.kind === "image" && preview ? (
					<FocalPointPicker src={preview} value={focal} onChange={onFocal} />
				) : (
					<div className="bg-chrome flex aspect-square items-center justify-center overflow-hidden rounded-[10px]">
						{preview ? (
							<img src={preview} alt="" className="size-full object-contain" />
						) : (
							<Glyph aria-hidden="true" className="text-chrome-muted size-10" />
						)}
					</div>
				)}
				{item.status === "processing" || item.replacing ? (
					<p className="text-chrome-muted m-0 flex items-start gap-2 text-[12px]">
						<LoaderIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin" />
						{t(item.replacing ? "media.replace.processing" : "media.details.processingHelp")}
					</p>
				) : null}
			</div>

			<div className="flex min-w-0 flex-col gap-5 pe-6">
				{trashed ? (
					<div className="flex flex-col gap-1 text-[12px]">
						<span className="text-chrome-warn font-medium">{t("media.trash.badge")}</span>
						<span className="text-chrome-text">
							{t("media.trash.deletedOn", { date: shortDate(language, item.trashedAt ?? item.updatedAt) })}
						</span>
						<span className="text-chrome-muted">
							{t("media.trash.purgeOn", { date: shortDate(language, item.purgeAt ?? item.updatedAt) })}
						</span>
					</div>
				) : null}

				<section aria-labelledby={`${id}-file`} className="flex flex-col gap-2.5">
					<h3 id={`${id}-file`} className={LABEL}>
						{t("media.details.file")}
					</h3>
					{item.url ? (
						<div className="flex min-w-0 items-center gap-2">
							<GlobeIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
							<code className="text-chrome-text min-w-0 grow truncate font-mono text-[12px]" title={item.url}>
								{item.url}
							</code>
							<RowButton
								icon={CopyIcon}
								label={t("media.details.copy")}
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(new URL(item.url ?? "", window.location.origin).toString());
										announce(t("media.details.copied"));
									} catch {
										announce(shown.copyFailed);
									}
								}}
							/>
						</div>
					) : null}
					<div className="flex flex-wrap gap-1.5">
						<span className={CHIP}>{format}</span>
						<span className={CHIP}>{fileSize(item.sizeBytes)}</span>
						{item.width && item.height ? (
							<span className={CHIP}>
								{t("media.details.dimensionsValue", { width: item.width, height: item.height })}
							</span>
						) : null}
					</div>
				</section>

				{item.kind === "image" ? (
					<section aria-labelledby={`${id}-alt-label`} className="flex flex-col gap-2.5" data-wc-media-alt="">
						<div className="flex items-center gap-2">
							<h3 id={`${id}-alt-label`} className={LABEL}>
								<label htmlFor={altId}>{t("media.details.alt")}</label>
							</h3>
							{languages.length > 1 ? (
								<fieldset className="ms-auto flex gap-1 border-0 p-0" data-wc-media-languages="">
									<legend className="sr-only">{t("media.details.languages")}</legend>
									{languages.map((each) => (
										<button
											key={each.code}
											type="button"
											aria-pressed={each.code === code}
											aria-label={
												missing(each.code)
													? fill(shown.languageNoAlt, { language: each.name })
													: fill(shown.languageAlt, { language: each.name })
											}
											onClick={() => onLanguage(each.code === fallback ? null : each.code)}
											className={`inline-flex h-6 items-center gap-1 rounded-md px-2.5 text-[11px] font-semibold uppercase ${
												each.code === code
													? "bg-chrome border-chrome-hover text-chrome-strong border"
													: "text-chrome-muted hover:text-chrome-text"
											} ${CHROME_EASE} ${FOCUS_RING}`}
											data-wc-media-language={each.code}
										>
											{each.code}
											{missing(each.code) ? (
												<span aria-hidden="true" className="bg-chrome-warn size-[5px] rounded-full" />
											) : null}
										</button>
									))}
								</fieldset>
							) : null}
						</div>
						{editable ? (
							<textarea
								id={altId}
								key={code}
								lang={code}
								value={alts[code] ?? ""}
								rows={3}
								maxLength={1000}
								placeholder={shown.addAlt}
								onChange={(event) => {
									const value = event.target.value;
									setAlts((was) => ({ ...was, [code]: value }));
									const timer = timers.current.get(code);
									if (timer) clearTimeout(timer);
									timers.current.set(
										code,
										setTimeout(() => void saveAlt(code, value), 800),
									);
								}}
								onBlur={(event) => void saveAlt(code, event.target.value)}
								aria-describedby={`${id}-alt-help`}
								className={`bg-chrome border-chrome-hover text-chrome-text placeholder:text-chrome-faint min-h-16 w-full resize-y rounded-md border p-2.5 text-[12px] ${FOCUS_RING}`}
								data-wc-media-alt-text=""
							/>
						) : (
							<p id={altId} lang={code} className="text-chrome-text m-0 text-[12px]">
								{alts[code] || "—"}
							</p>
						)}
						<p id={`${id}-alt-help`} className="text-chrome-muted m-0 text-[11px]">
							{t("media.details.altHelp")}
						</p>
					</section>
				) : null}

				{widths.length > 0 ? (
					<section aria-labelledby={`${id}-sizes`} className="flex flex-col gap-2.5">
						<h3 id={`${id}-sizes`} className={LABEL}>
							{t("media.details.sizesMade")}
						</h3>
						<ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
							{widths.map((width) => (
								<li key={width} className={CHIP}>
									{width}
								</li>
							))}
						</ul>
					</section>
				) : null}

				<section className="flex flex-col gap-2.5">
					<h3 className={LABEL}>
						<label htmlFor={`${id}-folder`}>{t("media.details.folder")}</label>
					</h3>
					<select
						id={`${id}-folder`}
						value={folderId}
						disabled={!editable}
						onChange={(event) => {
							setFolderId(event.target.value);
							void change({ folderId: event.target.value || null });
						}}
						className={`bg-chrome border-chrome-hover text-chrome-text h-[30px] rounded-md border px-2 text-[12px] disabled:opacity-60 ${FOCUS_RING}`}
						data-wc-media-folder=""
					>
						<option value="">{t("media.folders.none")}</option>
						{folders.folders.map((folder) => (
							<option key={folder.id} value={folder.id}>
								{folder.name}
							</option>
						))}
					</select>
				</section>

				{trashed ? null : (
					<section aria-labelledby={`${id}-used`} className="flex flex-col gap-2.5" data-wc-media-used="">
						<h3 id={`${id}-used`} className={LABEL}>
							{usedIn.length === 0 ? t("media.usedIn.heading") : t("media.usedIn.count", { count: usedIn.length })}
						</h3>
						{usedIn.length === 0 ? (
							<p className="text-chrome-muted m-0 text-[12px]">{t("media.usedIn.none")}</p>
						) : (
							<div className="text-chrome-text text-[12px] [&_ul]:gap-1">
								<UsedInList siteId={siteId} usedIn={usedIn} permissions={permissions} />
							</div>
						)}
					</section>
				)}

				{item.canEdit ? null : <p className="text-chrome-muted m-0 text-[12px]">{t("media.details.readOnly")}</p>}

				<div className="mt-auto flex flex-wrap items-center gap-2 pt-4" data-wc-media-file-actions="">
					{trashed ? (
						item.canEdit ? (
							<>
								<RestoreButton siteId={siteId} item={item} onRestored={onRemoved} />
								<DeleteForeverDialog siteId={siteId} item={item} onDeleted={onRemoved} />
							</>
						) : null
					) : (
						<>
							{editable ? <ReplaceButton siteId={siteId} item={item} onChanged={onChanged} /> : null}
							{item.url ? (
								<a
									href={item.url}
									download={item.fileName}
									className={`border-chrome-hover text-chrome-text hover:bg-chrome-hover inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
								>
									<DownloadIcon aria-hidden="true" className="size-4" />
									{t("media.details.download")}
								</a>
							) : null}
							{editable ? (
								<span className="ms-auto">
									<DeleteDialog siteId={siteId} item={item} onDeleted={onRemoved} />
								</span>
							) : null}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
