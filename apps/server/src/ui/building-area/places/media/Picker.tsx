import { Dialog, DialogClose, DialogContent, DialogTitle } from "@webcraft/ui/components/dialog.tsx";
import { LoaderIcon, SearchIcon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../../../i18n.tsx";
import type { MediaApi } from "../../../media/host.tsx";
import type { MediaItem } from "../../../media/preview.ts";
import type { ShellConfig, Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { managementApi } from "../../management.ts";
import { type ListedMediaItem, useMediaData } from "./data.ts";
import { ChosenMark, fileSize, Thumb, UploadButton, UploadProgress, useUpload } from "./parts.tsx";
import type { PickMediaDetail } from "./pick.ts";
import { MediaSidebar } from "./Sidebar.tsx";
import { ShellMedia } from "./shell.tsx";
import { defaultView, type MediaPart } from "./view.ts";

/**
 * The Media picker as the shell opens it (`host.tsx`, the first time `pickMedia()` asks: this file is
 * fetched then, BA-30): the dialog, with the shared Media parts' words and host around it.
 */
export function PickerDialog({
	config,
	request,
	finalFocus,
	onAnswer,
}: {
	config: ShellConfig;
	request: PickMediaDetail;
	finalFocus: RefObject<HTMLElement | null>;
	onAnswer(item: MediaItem | null): void;
}) {
	return (
		<ShellMedia config={config}>
			<MediaPicker config={config} words={config.words} request={request} finalFocus={finalFocus} onAnswer={onAnswer} />
		</ShellMedia>
	);
}

/**
 * The Media picker (`places-assets/04`): the Media place in a dialog, "Choose a Media image". All files,
 * Unfiled and the folders on the left; on the right a search, Upload (an upload is chosen once it is
 * ready) and the files as a list to choose from, the one chosen marked; Cancel and Select. The list is
 * a listbox: arrows move the choice, Enter selects it, as does a double click.
 */
function MediaPicker({
	config,
	words,
	request,
	finalFocus,
	onAnswer,
}: {
	config: ShellConfig;
	words: Words;
	request: PickMediaDetail;
	finalFocus: RefObject<HTMLElement | null>;
	onAnswer(item: MediaItem | null): void;
}) {
	const t = useT();
	const shown = words.media.picker;
	const siteId = config.site.id;
	const api: MediaApi = useMemo(() => managementApi(config.token).media, [config.token]);
	const [part, setPart] = useState<MediaPart>({ kind: "all" });
	const [q, setQ] = useState("");
	const [query, setQuery] = useState("");
	const view = useMemo(() => ({ ...defaultView(), q: query, kind: request.kind ?? null }), [query, request.kind]);
	const { data, failed, reload } = useMediaData(api, siteId, part, view);
	const [chosen, setChosen] = useState<string | null>(request.current ?? null);
	const list = useRef<HTMLDivElement>(null);
	const folderId = part.kind === "folder" ? part.folderId : null;

	useEffect(() => {
		const timer = setTimeout(() => setQuery(q.trim()), 300);
		return () => clearTimeout(timer);
	}, [q]);

	const { uploading, upload } = useUpload({
		api,
		siteId,
		folderId,
		onDone: async (made) => {
			const first = made.find((item) => !request.kind || item.kind === request.kind);
			if (first) setChosen(first.id);
			await reload();
		},
	});

	const items = data?.list.items ?? [];
	const choosable = (item: ListedMediaItem) => item.status === "ready";
	const chosenItem = items.find((item) => item.id === chosen && choosable(item)) ?? null;

	const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const ready = items.filter(choosable);
		if (ready.length === 0) return;
		const at = ready.findIndex((item) => item.id === chosen);
		let next: number | null = null;
		if (event.key === "ArrowDown") next = Math.min(ready.length - 1, at + 1);
		else if (event.key === "ArrowUp") next = Math.max(0, at === -1 ? 0 : at - 1);
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = ready.length - 1;
		else if (event.key === "Enter" && chosenItem) {
			event.preventDefault();
			onAnswer(chosenItem);
			return;
		}
		if (next === null) return;
		event.preventDefault();
		const item = ready[next];
		if (!item) return;
		setChosen(item.id);
		list.current?.querySelector(`[data-wc-pick="${item.id}"]`)?.scrollIntoView({ block: "nearest" });
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onAnswer(null);
			}}
		>
			<DialogContent
				closeLabel={shown.close}
				finalFocus={finalFocus}
				className="bg-chrome-menu text-chrome-text border-chrome-hover grid h-[min(720px,calc(100dvh-4rem))] w-[min(1152px,calc(100vw-4rem))] max-w-none grid-rows-[48px_minmax(0,1fr)_56px] gap-0 overflow-hidden rounded-[10px] border p-0 ring-0 sm:max-w-none [&>[data-slot=dialog-close]]:end-2.5 [&>[data-slot=dialog-close]]:top-2.5"
				data-wc-media-picker=""
			>
				<div className="border-chrome-line flex items-center border-b px-4">
					<DialogTitle className="text-chrome-strong text-[15px] font-semibold">
						{request.kind === "image" ? shown.titleImage : shown.title}
					</DialogTitle>
				</div>
				<div className="flex min-h-0">
					<nav
						aria-label={shown.folders}
						className="border-chrome-line w-[260px] shrink-0 overflow-y-auto border-e p-3"
					>
						{data ? (
							<MediaSidebar
								words={words}
								siteId={siteId}
								part={part}
								folders={data.folders}
								trashCount={0}
								canManage={false}
								picker
								onGo={setPart}
								onChanged={reload}
							/>
						) : null}
					</nav>
					<div className="flex min-w-0 grow flex-col">
						<div className="border-chrome-line flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
							<span className="relative inline-flex w-[220px]">
								<SearchIcon
									aria-hidden="true"
									className="text-chrome-muted pointer-events-none absolute start-2.5 top-2 size-3.5"
								/>
								<input
									type="search"
									aria-label={t("media.search")}
									placeholder={words.media.search}
									value={q}
									onChange={(event) => setQ(event.target.value)}
									className={`bg-chrome-raised text-chrome-text placeholder:text-chrome-faint h-[30px] w-full rounded-md border-0 ps-8 pe-2 text-[12px] ${FOCUS_RING}`}
									data-wc-pick-search=""
								/>
							</span>
							<span className="grow" />
							{config.permissions.includes("media.upload") ? (
								<UploadButton
									siteId={siteId}
									folderId={folderId}
									busy={uploading !== null}
									accept={request.kind === "image" ? "image/*" : undefined}
									onFiles={(files) => void upload(files)}
									onImported={reload}
								/>
							) : null}
						</div>
						{uploading ? <UploadProgress uploading={uploading} /> : null}
						{failed && !data ? (
							<p role="alert" className="text-chrome-danger m-0 p-4 text-[12px]">
								{failed}
							</p>
						) : !data ? (
							<p role="status" className="text-chrome-muted m-0 flex items-center gap-2 p-4 text-[12px]">
								<LoaderIcon aria-hidden="true" className="size-3.5 animate-spin" />
								{words.media.loading}
							</p>
						) : items.length === 0 ? (
							<p className="border-chrome-hover text-chrome-muted m-3 rounded-lg border border-dashed p-8 text-center text-[12px]">
								{query ? t("media.noMatch") : t("media.empty")}
							</p>
						) : (
							<div
								ref={list}
								role="listbox"
								aria-label={shown.files}
								aria-activedescendant={chosenItem ? `wc-pick-${chosenItem.id}` : undefined}
								tabIndex={0}
								onKeyDown={onListKey}
								className={
									"focus-visible:ring-chrome-focus min-h-0 grow overflow-y-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset"
								}
								data-wc-pick-list=""
							>
								{items.map((item) => {
									const ready = choosable(item);
									const on = ready && item.id === chosen;
									return (
										// biome-ignore lint/a11y/useKeyWithClickEvents: the listbox takes the keys (arrows, Enter).
										<div
											key={item.id}
											id={`wc-pick-${item.id}`}
											role="option"
											tabIndex={-1}
											aria-selected={on}
											aria-disabled={ready ? undefined : true}
											onClick={() => ready && setChosen(item.id)}
											onDoubleClick={() => ready && onAnswer(item)}
											className={`flex h-12 cursor-pointer items-center gap-2.5 rounded-lg border px-2 ${
												on ? "border-primary bg-chrome-raised" : "hover:bg-chrome-raised border-transparent"
											} ${ready ? "" : "cursor-default opacity-50"} ${CHROME_EASE}`}
											data-wc-pick={item.id}
										>
											<Thumb siteId={siteId} item={item} size={30} />
											<span className="text-chrome-strong min-w-0 grow truncate text-[13px] font-medium">
												{item.fileName}
											</span>
											{ready ? null : <span className="text-chrome-warn text-[11px]">{t("media.processing")}</span>}
											<span className="text-chrome-muted w-28 truncate font-mono text-[11px]">{item.contentType}</span>
											<span className="text-chrome-muted w-16 text-end font-mono text-[11px] tabular-nums">
												{fileSize(item.sizeBytes)}
											</span>
											<span className="inline-flex w-6 justify-center">
												{on ? <ChosenMark label={shown.chosen} /> : null}
											</span>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
				<div className="border-chrome-line flex items-center justify-end gap-2 border-t px-4">
					<DialogClose
						render={
							<button
								type="button"
								className={`border-chrome-hover text-chrome-text hover:bg-chrome-hover inline-flex h-8 items-center rounded-md border px-3 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
							/>
						}
					>
						{shown.cancel}
					</DialogClose>
					<button
						type="button"
						disabled={!chosenItem}
						onClick={() => chosenItem && onAnswer(chosenItem)}
						className={`bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center rounded-md px-3 text-[12px] font-semibold disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-pick-select=""
					>
						{shown.select}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
