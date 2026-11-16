import { CheckIcon, FolderInputIcon, LinkIcon, RotateCcwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";

import type { KeyboardEvent } from "react";

import { useT } from "../../../i18n.tsx";
import { imagePreview, KIND_ICONS } from "../../../media/preview.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import type { ListedMediaItem, MediaFoldersData } from "./data.ts";
import { shapeOf } from "./masonry.ts";
import { Check, FolderMenu, fileSize, RowButton, shortDate, Thumb } from "./parts.tsx";
import { arrowTarget, useMasonry } from "./use-masonry.ts";

/** What a row or a tile can do with its file. */
export type FileActions = {
	open(item: ListedMediaItem): void;
	copy(item: ListedMediaItem): void;
	move(items: readonly ListedMediaItem[], folderId: string | null): void;
	remove(items: readonly ListedMediaItem[]): void;
	restore(item: ListedMediaItem): void;
};

const HEAD = "text-chrome-muted h-9 px-2 text-start text-[11px] font-semibold tracking-[0.04em] uppercase";
const CELL = "text-chrome-text px-2 text-[12px]";

/**
 * The files as a list (`places-assets/01`, the default): a box to select each, its picture and name
 * (which opens its details in place), its alt text in the language shown, its type, pixels, size,
 * when it was added (deleted, in the Trash) and in how many places it is used; then copy its
 * address, move it to a folder and delete it (in the Trash: restore it). Rows are 50 high.
 */
export function FileList({
	words,
	siteId,
	language,
	items,
	trash,
	folders,
	selected,
	onSelect,
	actions,
}: {
	words: Words;
	siteId: string;
	/** The person's Admin language, for dates. */
	language: string;
	items: readonly ListedMediaItem[];
	trash: boolean;
	folders: MediaFoldersData;
	selected: ReadonlySet<string>;
	onSelect(id: string, on: boolean): void;
	actions: FileActions;
}) {
	const t = useT();
	const shown = words.media;
	const altLanguage = (items[0]?.language ?? "").toUpperCase();
	const all = items.length > 0 && items.every((item) => selected.has(item.id));
	return (
		<table className="w-full min-w-[860px] table-fixed border-separate border-spacing-0" data-wc-media-list="">
			<caption className="sr-only">{t("media.listLabel")}</caption>
			<colgroup>
				<col />
				<col />
				<col className="w-[110px]" />
				<col className="w-[90px]" />
				<col className="w-[84px]" />
				<col className="w-[78px]" />
				<col className="w-[56px]" />
				<col className="w-[96px]" />
			</colgroup>
			<thead className="bg-chrome-raised">
				<tr>
					<th scope="col" className={`${HEAD} rounded-s-md ps-2.5`}>
						<span className="flex items-center gap-2.5">
							{trash ? null : (
								<Check
									label={shown.selectAll}
									checked={all}
									onChange={(on) => {
										for (const item of items) onSelect(item.id, on);
									}}
									data={{ "data-wc-media-select-all": "" }}
								/>
							)}
							{t("media.columns.name")}
						</span>
					</th>
					<th scope="col" className={HEAD}>
						{t("media.columns.alt", { language: altLanguage })}
					</th>
					<th scope="col" className={HEAD}>
						{t("media.columns.type")}
					</th>
					<th scope="col" className={HEAD}>
						{t("media.columns.pixels")}
					</th>
					<th scope="col" className={HEAD}>
						{t("media.columns.size")}
					</th>
					<th scope="col" className={HEAD}>
						{trash ? t("media.columns.deleted") : t("media.columns.added")}
					</th>
					<th scope="col" className={HEAD}>
						{t("media.columns.used")}
					</th>
					<th scope="col" className={`${HEAD} rounded-e-md`}>
						<span className="sr-only">{shown.actions}</span>
					</th>
				</tr>
			</thead>
			<tbody>
				{items.map((item) => (
					<tr
						key={item.id}
						className={`group/row hover:bg-chrome-raised ${selected.has(item.id) ? "bg-chrome-raised" : ""}`}
						data-wc-media-file={item.id}
					>
						<td className={`${CELL} border-chrome-line h-[50px] border-b ps-2.5`}>
							<span className="flex min-w-0 items-center gap-2">
								{trash ? null : (
									<Check
										label={fill(shown.select, { name: item.fileName })}
										checked={selected.has(item.id)}
										onChange={(on) => onSelect(item.id, on)}
									/>
								)}
								<Thumb siteId={siteId} item={item} size={30} />
								<button
									type="button"
									onClick={() => actions.open(item)}
									className={`text-chrome-text min-w-0 truncate rounded-sm text-start font-medium hover:underline ${FOCUS_RING}`}
									data-wc-media-open={item.id}
								>
									{item.fileName}
								</button>
								{item.status !== "ready" ? (
									<span className="text-chrome-warn shrink-0 text-[11px]">
										{t(item.status === "failed" ? "media.failed" : "media.processing")}
									</span>
								) : null}
							</span>
						</td>
						<td className={`${CELL} border-chrome-line border-b`}>
							{item.kind !== "image" ? (
								<span className="text-chrome-muted">—</span>
							) : item.alt ? (
								<span className="block truncate" lang={item.language}>
									{item.alt}
								</span>
							) : (
								<span className="text-chrome-muted block truncate">{shown.addAlt}</span>
							)}
						</td>
						<td className={`${CELL} border-chrome-line truncate border-b`}>{item.contentType}</td>
						<td className={`${CELL} border-chrome-line border-b tabular-nums`}>
							{item.width && item.height ? `${item.width}×${item.height}` : "—"}
						</td>
						<td className={`${CELL} border-chrome-line border-b tabular-nums`}>{fileSize(item.sizeBytes)}</td>
						<td className={`${CELL} border-chrome-line border-b`}>
							{shortDate(language, trash ? (item.trashedAt ?? item.createdAt) : item.createdAt)}
						</td>
						<td className={`${CELL} border-chrome-line border-b tabular-nums`}>
							<span aria-hidden="true">{item.uses}</span>
							<span className="sr-only">{t("media.usedIn.count", { count: item.uses })}</span>
						</td>
						<td className={`${CELL} border-chrome-line border-b`}>
							<span className="flex items-center justify-end gap-1">
								{trash ? (
									item.canEdit ? (
										<RowButton
											icon={RotateCcwIcon}
											label={fill(shown.restoreOne, { name: item.fileName })}
											onClick={() => actions.restore(item)}
											data={{ "data-wc-media-restore": item.id }}
										/>
									) : null
								) : (
									<>
										{item.url ? (
											<RowButton
												icon={LinkIcon}
												label={fill(shown.copyAddress, { name: item.fileName })}
												onClick={() => actions.copy(item)}
											/>
										) : null}
										{item.canEdit ? (
											<>
												<FolderMenu
													words={words}
													folders={folders}
													current={item.folderId}
													onChoose={(folderId) => actions.move([item], folderId)}
													trigger={({ buttonRef, expanded, controls, toggle }) => (
														<RowButton
															icon={FolderInputIcon}
															label={fill(shown.moveOne, { name: item.fileName })}
															onClick={toggle}
															buttonRef={buttonRef}
															expanded={expanded}
															controls={controls}
															data={{ "data-wc-media-move": item.id }}
														/>
													)}
												/>
												<RowButton
													icon={Trash2Icon}
													label={fill(shown.deleteOne, { name: item.fileName })}
													onClick={() => actions.remove([item])}
													danger
													data={{ "data-wc-media-delete": item.id }}
												/>
											</>
										) : null}
									</>
								)}
							</span>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** What a file that isn't a picture is, as its tile says it: its kind of file, from its name (`PDF`, `MP4`). */
export function kindOf(item: ListedMediaItem): string {
	const extension = /\.([A-Za-z0-9]{1,8})$/.exec(item.fileName)?.[1];
	return (extension ?? item.contentType.split("/")[1] ?? item.kind).toUpperCase();
}

/**
 * The files as a masonry grid (`places-assets/03`): each picture in its own shape, in columns about
 * 196 wide, laid out from the files' sizes before the pictures load (`masonry.ts`), so nothing moves
 * as they arrive; its box to select it at its top corner (shown under the pointer, on focus, and while
 * anything is selected); "No alt text" on an image without one; its name and size under the pointer
 * and on focus; a file that isn't an image shows its kind. While something is selected, the pictures
 * not selected are dimmed. The picture opens its details in place; the arrow keys move between the
 * pictures (Home and End: the first and the last), and Enter opens one (FX-03).
 */
export function FileGrid({
	words,
	siteId,
	items,
	trash,
	selected,
	onSelect,
	actions,
}: {
	words: Words;
	siteId: string;
	items: readonly ListedMediaItem[];
	trash: boolean;
	selected: ReadonlySet<string>;
	onSelect(id: string, on: boolean): void;
	actions: FileActions;
}) {
	const t = useT();
	const shown = words.media;
	const selecting = selected.size > 0;
	const { ref, layout } = useMasonry(
		items.map((item) => shapeOf(item.width, item.height)),
		{ minColumn: 196, gap: 8 },
	);

	const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
		const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-wc-media-open]");
		if (!focused) return;
		const from = items.findIndex((item) => item.id === focused.dataset.wcMediaOpen);
		const to = arrowTarget(event, layout, from, getComputedStyle(focused).direction === "rtl");
		if (to === undefined) return;
		event.preventDefault();
		const item = to === null ? null : items[to];
		if (!item) return;
		event.currentTarget.querySelector<HTMLElement>(`[data-wc-media-open="${item.id}"]`)?.focus();
	};

	return (
		<ul
			ref={ref}
			aria-label={t("media.listLabel")}
			className="relative m-0 list-none p-0"
			style={{ height: layout.height }}
			onKeyDown={onKey}
			data-wc-media-grid=""
			data-wc-grid-columns={layout.columns}
		>
			{items.map((item, index) => {
				const box = layout.boxes[index];
				const on = selected.has(item.id);
				const image = imagePreview(siteId, item, 480, true);
				const Glyph = KIND_ICONS[item.kind];
				const missingAlt = item.kind === "image" && item.status === "ready" && !item.alt;
				return (
					<li
						key={item.id}
						className={`group/tile absolute overflow-hidden rounded-md ${
							selecting && !on ? "opacity-60" : ""
						} ${CHROME_EASE}`}
						style={
							box
								? { insetInlineStart: box.x, top: box.y, width: box.width, height: box.height }
								: { visibility: "hidden" }
						}
						data-wc-media-file={item.id}
					>
						<button
							type="button"
							onClick={() => actions.open(item)}
							className={`bg-chrome-raised relative flex size-full items-center justify-center overflow-hidden rounded-md ${FOCUS_RING}`}
							data-wc-media-open={item.id}
						>
							{image ? (
								<img src={image} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
							) : (
								<span className="text-chrome-muted grid justify-items-center gap-1.5 p-3 text-center text-[11px]">
									<Glyph aria-hidden="true" className="size-7" />
									<span className="text-chrome-text text-[11px] font-semibold tracking-[0.04em]">{kindOf(item)}</span>
								</span>
							)}
							<span className="sr-only">
								{item.fileName}, {fileSize(item.sizeBytes)}
							</span>
						</button>
						{on ? (
							<span
								aria-hidden="true"
								className="ring-selection pointer-events-none absolute inset-0 rounded-md ring-[3px] ring-inset"
							/>
						) : null}
						<span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-start gap-1 p-2">
							{missingAlt ? (
								<span className="text-chrome-warn flex h-[22px] items-center gap-1 rounded-full bg-[#18181bcc] px-2 text-[10px] font-medium">
									<TriangleAlertIcon aria-hidden="true" className="size-3" />
									{t("media.noAltShort")}
								</span>
							) : null}
							<span
								aria-hidden="true"
								className={`flex w-full min-w-0 items-baseline gap-2 rounded-[5px] bg-[#18181bd9] px-1.5 py-1 text-[11px] text-white opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 ${CHROME_EASE}`}
								data-wc-media-caption=""
							>
								<span className="min-w-0 grow truncate font-medium">{item.fileName}</span>
								<span className="shrink-0 text-white/80 tabular-nums">{fileSize(item.sizeBytes)}</span>
							</span>
						</span>
						{trash ? null : (
							<label
								className={`absolute end-2 top-2 inline-grid size-[22px] cursor-pointer place-items-center rounded-full border-2 border-white ${
									on ? "bg-selection" : "bg-[#18181b99]"
								} ${selecting || on ? "" : "opacity-0 group-hover/tile:opacity-100 has-[:focus-visible]:opacity-100"} has-[:focus-visible]:ring-chrome-focus has-[:focus-visible]:ring-2 ${CHROME_EASE}`}
							>
								<input
									type="checkbox"
									aria-label={fill(shown.select, { name: item.fileName })}
									checked={on}
									onChange={(event) => onSelect(item.id, event.target.checked)}
									className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-full opacity-0"
								/>
								{on ? <CheckIcon aria-hidden="true" className="pointer-events-none size-3 text-white" /> : null}
							</label>
						)}
					</li>
				);
			})}
		</ul>
	);
}
