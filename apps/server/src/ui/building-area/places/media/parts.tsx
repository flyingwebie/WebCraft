import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { CheckIcon, ChevronDownIcon, LinkIcon, LoaderIcon, UploadIcon } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useId, useRef, useState } from "react";
import { errorMessage } from "../../../errors.ts";
import { useT } from "../../../i18n.tsx";
import type { MediaApi } from "../../../media/host.tsx";
import { ImportDialog } from "../../../media/ImportDialog.tsx";
import { imagePreview, KIND_ICONS, type MediaItem } from "../../../media/preview.ts";
import { fill, type Words } from "../../api.ts";
import { type ChoiceGroup, ChoiceMenu } from "../../ChoiceMenu.tsx";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../../controls.tsx";
import type { MediaFoldersData } from "./data.ts";
import { notify } from "./toasts.tsx";

/** A file's picture (or its kind's icon) in a square of `size` px, from the Site's own `/_media/`. */
export function Thumb({ siteId, item, size }: { siteId: string; item: MediaItem; size: number }) {
	const image = imagePreview(siteId, item, size * 2, true);
	const Glyph = KIND_ICONS[item.kind];
	return (
		<span
			className="bg-chrome-hover inline-grid shrink-0 place-items-center overflow-hidden rounded-md"
			style={{ width: size, height: size }}
		>
			{image ? (
				<img src={image} alt="" loading="lazy" className="size-full object-cover" />
			) : (
				<Glyph aria-hidden="true" className="text-chrome-muted size-4" />
			)}
		</span>
	);
}

/** A file's size as the frames write it: `412 KB`, `1.1 MB` (whole kilobytes, one decimal above). */
export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** A day as the lists show it ("2 Nov"), in the person's Admin language. */
export function shortDate(language: string, when: Date | string): string {
	return new Intl.DateTimeFormat(language, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(when));
}

/** A checkbox on the chrome (16 square), named for what it selects. */
export function Check({
	label,
	checked,
	onChange,
	className = "",
	data,
}: {
	label: string;
	checked: boolean;
	onChange(checked: boolean): void;
	className?: string;
	data?: Record<`data-${string}`, string>;
}) {
	return (
		<input
			type="checkbox"
			aria-label={label}
			checked={checked}
			onChange={(event) => onChange(event.target.checked)}
			className={`accent-selection size-4 shrink-0 cursor-pointer rounded-[4px] ${FOCUS_RING} ${className}`}
			{...data}
		/>
	);
}

/** A small icon button of a row (24 square), named and with its name as a tooltip. */
export function RowButton({
	icon: Glyph,
	label,
	onClick,
	buttonRef,
	expanded,
	controls,
	danger = false,
	data,
}: {
	icon: Icon;
	label: string;
	onClick(): void;
	buttonRef?: Ref<HTMLButtonElement>;
	expanded?: boolean;
	controls?: string;
	danger?: boolean;
	data?: Record<`data-${string}`, string>;
}) {
	return (
		<span className="group relative inline-flex">
			<button
				ref={buttonRef}
				type="button"
				aria-label={label}
				aria-haspopup={expanded === undefined ? undefined : "menu"}
				aria-expanded={expanded}
				aria-controls={controls}
				onClick={onClick}
				className={`text-chrome-muted inline-grid size-6 place-items-center rounded-[5px] ${
					danger ? "hover:text-chrome-danger" : "hover:text-chrome-strong"
				} hover:bg-chrome-hover ${CHROME_EASE} ${FOCUS_RING}`}
				{...data}
			>
				<Glyph aria-hidden="true" className="size-3.5" />
			</button>
			<Tip label={label} side="bottom" />
		</span>
	);
}

/**
 * Move to Folder: a menu of the folders (and Unfiled) under its button; choosing one answers its id
 * (null: Unfiled). `trigger` draws the button, given what it needs.
 */
export function FolderMenu({
	words,
	folders,
	current,
	onChoose,
	trigger,
	side = "bottom",
	align = "end",
}: {
	words: Words;
	folders: MediaFoldersData;
	/** The folder the files are in now, when they share one. */
	current?: string | null;
	onChoose(folderId: string | null): void;
	trigger(props: {
		buttonRef: Ref<HTMLButtonElement>;
		expanded: boolean;
		controls: string | undefined;
		toggle(): void;
	}): ReactNode;
	side?: "top" | "bottom";
	align?: "start" | "end";
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const groups: ChoiceGroup[] = [
		{
			label: null,
			choices: [
				{ key: "", label: t("media.folders.none"), current: current === null },
				...folders.folders.map((folder) => ({ key: folder.id, label: folder.name, current: current === folder.id })),
			],
		},
	];
	return (
		<span className="relative inline-flex">
			{trigger({
				buttonRef: button,
				expanded: open,
				controls: open ? id : undefined,
				toggle: () => setOpen((was) => !was),
			})}
			{open ? (
				<ChoiceMenu
					id={id}
					label={words.media.moveTo}
					groups={groups}
					button={button}
					side={side}
					align={align}
					onChoose={(choice) => onChoose(choice.key || null)}
					onClose={(focusButton) => {
						setOpen(false);
						if (focusButton) button.current?.focus();
					}}
				/>
			) : null}
		</span>
	);
}

/** Where an upload stands: how many files of how many are done, and the one going now. */
export type Uploading = { total: number; done: number; name: string };

/**
 * Uploads files one after another into a folder (null: none), as the admin's Media screen does: a
 * toast for each (and for each refusal), then `onDone` with the files made.
 */
export function useUpload({
	api,
	siteId,
	folderId,
	onDone,
}: {
	api: MediaApi;
	siteId: string;
	folderId: string | null;
	onDone(made: MediaItem[]): Promise<void> | void;
}) {
	const t = useT();
	const [uploading, setUploading] = useState<Uploading | null>(null);
	const upload = useCallback(
		async (files: readonly File[]) => {
			if (files.length === 0) return;
			const made: MediaItem[] = [];
			for (const [index, file] of files.entries()) {
				setUploading({ total: files.length, done: index, name: file.name });
				try {
					made.push((await api.upload({ siteId, file, folderId })).media);
					notify("success", t("media.uploaded", { name: file.name }));
				} catch (failure) {
					notify("error", t("media.uploadFailed", { name: file.name, reason: t(errorMessage(failure)) }));
				}
			}
			setUploading(null);
			await onDone(made);
		},
		[api, siteId, folderId, onDone, t],
	);
	return { uploading, upload };
}

/**
 * Upload (`places-assets/01`, 30 high, the primary colour), and beside it a menu with Import from URL
 * (the admin's dialog). The file input takes several files.
 */
export function UploadButton({
	siteId,
	folderId,
	busy,
	accept,
	onFiles,
	onImported,
}: {
	siteId: string;
	folderId: string | null;
	busy: boolean;
	/** The kinds of file the file chooser offers (`image/*` in the picker for a Media image). */
	accept?: string;
	onFiles(files: readonly File[]): void;
	onImported(): Promise<void>;
}) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const more = useRef<HTMLButtonElement>(null);
	const [importing, setImporting] = useState(false);
	const look = `bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-[30px] items-center ${CHROME_EASE} ${FOCUS_RING}`;
	return (
		<span className="inline-flex" data-wc-media-upload="">
			<input
				ref={input}
				type="file"
				multiple
				hidden
				tabIndex={-1}
				aria-hidden="true"
				accept={accept}
				onChange={(event) => {
					onFiles([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
			<button
				type="button"
				onClick={() => input.current?.click()}
				disabled={busy}
				className={`${look} gap-1.5 rounded-s-md px-2.5 text-[12px] font-semibold disabled:opacity-60`}
			>
				{busy ? (
					<LoaderIcon aria-hidden="true" className="size-3.5 animate-spin" />
				) : (
					<UploadIcon aria-hidden="true" className="size-3.5" />
				)}
				{t("media.upload")}
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={more}
					render={
						<button
							type="button"
							aria-label={t("media.uploadMore")}
							className={`${look} w-7 justify-center rounded-e-md border-s border-black/20`}
						/>
					}
				>
					<ChevronDownIcon aria-hidden="true" className="size-3.5" />
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
		</span>
	);
}

/** How far an upload is: a thin bar of the files done, and the one going now. */
export function UploadProgress({ uploading }: { uploading: Uploading }) {
	const t = useT();
	const id = useId();
	return (
		<div className="border-chrome-line flex items-center gap-3 border-b px-3 py-2" data-wc-media-uploading="">
			<LoaderIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0 animate-spin" />
			<span id={id} className="text-chrome-text min-w-0 truncate text-[12px]">
				{t("media.uploadingOne", { done: uploading.done + 1, total: uploading.total, name: uploading.name })}
			</span>
			<progress
				aria-labelledby={id}
				max={uploading.total}
				value={uploading.done}
				className="[&::-webkit-progress-bar]:bg-chrome-line [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary ms-auto h-1 w-40 overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full"
			/>
		</div>
	);
}

/** The mark of the chosen file in the picker. */
export function ChosenMark({ label }: { label: string }) {
	return (
		<span className="border-primary text-primary inline-grid size-[18px] place-items-center rounded-full border-2">
			<CheckIcon aria-hidden="true" className="size-3" />
			<span className="sr-only">{label}</span>
		</span>
	);
}

/** "Copy the address" of a file: its address on the Site, written to the clipboard. */
export async function copyAddress(item: MediaItem, words: Words, announce: (text: string) => void): Promise<void> {
	if (!item.url) return;
	try {
		await navigator.clipboard.writeText(new URL(item.url, window.location.origin).toString());
		announce(fill(words.media.copied, { name: item.fileName }));
	} catch {
		announce(words.media.copyFailed);
	}
}
