import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { ImagesIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";

import { EditorEnvironment, useEditorApi } from "../builder/editor-api.tsx";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { formatBytes, imagePreview, KIND_ICONS, type MediaItem } from "./preview.ts";

/** How many files the picker shows at once; a search finds the rest. */
const PICKER_PAGE = 60;

/**
 * A media Field's control: the chosen file of the Site's Media library (its preview, name and size),
 * with Choose and Remove. Choosing opens the library's files in a dialog, searched by name or alt
 * text; uploads happen on the Media screen.
 */
export function MediaPicker({
	siteId,
	id,
	labelledBy,
	describedBy,
	invalid,
	value,
	item,
	onChange,
}: {
	siteId: string;
	/** The id of the control's main button. */
	id: string;
	labelledBy: string;
	describedBy?: string;
	invalid?: boolean;
	/** The chosen file's id, or null. */
	value: string | null;
	/** What the admin knows about the chosen file; null while unknown (or no longer in the library). */
	item: MediaItem | null;
	onChange(next: { id: string; item: MediaItem } | null): void;
}) {
	const t = useT();
	const environment = useContext(EditorEnvironment);
	const [open, setOpen] = useState(false);
	const chooseButton = useRef<HTMLButtonElement>(null);
	const preview = item ? imagePreview(siteId, item, 320, environment.siteMedia) : null;
	const Icon = item ? KIND_ICONS[item.kind] : ImagesIcon;
	return (
		<div
			className="data-[invalid=true]:border-destructive flex flex-wrap items-center gap-4 rounded-lg border p-3"
			data-invalid={invalid ? true : undefined}
		>
			{value ? (
				<>
					<span className="bg-muted flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md">
						{preview ? (
							<img src={preview} alt="" className="size-full object-cover" />
						) : (
							<Icon className="text-muted-foreground size-6" aria-hidden="true" />
						)}
					</span>
					<span className="grid min-w-0 flex-1 gap-0.5 text-sm">
						<span className="truncate font-medium">{item?.fileName ?? t("content.media.unknownFile")}</span>
						{item ? (
							<span className="text-muted-foreground">
								{item.width && item.height ? `${item.width} × ${item.height} · ` : ""}
								{formatBytes(item.sizeBytes)}
							</span>
						) : null}
					</span>
				</>
			) : (
				<span className="text-muted-foreground flex-1 text-sm">{t("content.media.none")}</span>
			)}
			<span className="flex gap-2">
				<Button
					ref={chooseButton}
					id={id}
					type="button"
					variant="outline"
					size="sm"
					aria-labelledby={`${id} ${labelledBy}`}
					aria-describedby={describedBy}
					onClick={() => setOpen(true)}
				>
					{t(value ? "content.media.change" : "content.media.choose")}
				</Button>
				{value ? (
					<Button
						id={`${id}-remove`}
						type="button"
						variant="ghost"
						size="sm"
						aria-labelledby={`${id}-remove ${labelledBy}`}
						onClick={() => {
							onChange(null);
							chooseButton.current?.focus();
						}}
					>
						{t("content.media.remove")}
					</Button>
				) : null}
			</span>
			<MediaChooser
				siteId={siteId}
				open={open}
				onOpenChange={setOpen}
				current={value}
				finalFocus={chooseButton}
				onChoose={(chosen) => {
					onChange({ id: chosen.id, item: chosen });
					setOpen(false);
				}}
			/>
		</div>
	);
}

/** The Media library's files in a dialog, searched by name or alt text; choosing one closes it. */
function MediaChooser({
	siteId,
	open,
	onOpenChange,
	current,
	finalFocus,
	onChoose,
}: {
	siteId: string;
	open: boolean;
	onOpenChange(open: boolean): void;
	current: string | null;
	finalFocus: React.RefObject<HTMLElement | null>;
	onChoose(item: MediaItem): void;
}) {
	const t = useT();
	const environment = useContext(EditorEnvironment);
	const getApi = useEditorApi();
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<MediaItem[] | null>(null);
	const [error, setError] = useState<MessageKey | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const timer = setTimeout(
			async () => {
				try {
					const api = await getApi();
					const list = await api.media.list({ siteId, search: query.trim() || undefined, limit: PICKER_PAGE });
					if (!cancelled) {
						setItems(list.items.filter((item) => item.status === "ready"));
						setError(null);
					}
				} catch (failure) {
					if (!cancelled) setError(errorMessage(failure));
				}
			},
			query ? 300 : 0,
		);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, query, siteId, getApi]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("content.media.close")} finalFocus={finalFocus} className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("content.media.dialogTitle")}</DialogTitle>
					<DialogDescription>{t("content.media.dialogHelp")}</DialogDescription>
				</DialogHeader>
				<div className="w-full max-w-sm">
					<Label htmlFor="media-chooser-search" className="sr-only">
						{t("media.search")}
					</Label>
					<InputGroup>
						<InputGroupAddon>
							<SearchIcon aria-hidden="true" />
						</InputGroupAddon>
						<InputGroupInput
							id="media-chooser-search"
							type="search"
							placeholder={t("media.search")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</InputGroup>
				</div>
				<div className="max-h-[50vh] overflow-y-auto p-1">
					{error ? (
						<p className="text-destructive text-sm">{t(error)}</p>
					) : items === null ? (
						<p className="text-muted-foreground flex items-center gap-2 text-sm">
							<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
							{t("content.media.loading")}
						</p>
					) : items.length === 0 ? (
						<p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
							{t(query ? "media.noMatch" : "media.empty")}
						</p>
					) : (
						<ul aria-label={t("media.listLabel")} className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
							{items.map((item) => {
								const image = imagePreview(siteId, item, 320, environment.siteMedia);
								const Icon = KIND_ICONS[item.kind];
								const chosen = item.id === current;
								return (
									<li key={item.id}>
										<button
											type="button"
											aria-pressed={chosen}
											onClick={() => onChoose(item)}
											className="group focus-visible:ring-ring/50 grid w-full gap-1.5 rounded-lg text-start outline-none focus-visible:ring-3"
										>
											<span
												className={`bg-muted relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border-2 ${
													chosen ? "border-primary" : "group-hover:border-border border-transparent"
												}`}
											>
												{image ? (
													<img src={image} alt="" loading="lazy" className="size-full object-cover" />
												) : (
													<Icon className="text-muted-foreground size-7" aria-hidden="true" />
												)}
												{chosen ? <Badge className="absolute start-2 top-2">{t("content.media.chosen")}</Badge> : null}
											</span>
											<span className="truncate text-sm">{item.fileName}</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>
				<DialogFooter>
					<a
						href={`${environment.adminOrigin}/sites/${siteId}/media`}
						className="focus-visible:ring-ring/50 me-auto rounded-sm text-sm underline underline-offset-4 outline-none focus-visible:ring-3"
					>
						{t("content.media.openLibrary")}
					</a>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
