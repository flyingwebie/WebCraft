import type { BuildingAreaApiClient } from "@webcraft/api";
import { ListIcon, SlidersHorizontalIcon, TextCursorInputIcon } from "lucide-react";
import { useRef, useState } from "react";

import { fill, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../../../controls.tsx";
import type { PostTypeRow } from "../../../management.ts";
import { DeleteDialog, type Deleting } from "./DeleteDialog.tsx";
import { FieldsTab } from "./FieldsTab.tsx";
import { SettingsTab } from "./SettingsTab.tsx";

/** A Post Type's tabs: its Entries (the grid), its Fields, its Settings. */
export type PostTypeTab = "entries" | "fields" | "settings";

/** The chosen Field's path in a Fields tab's view (`field=seo.meta_title`), if any. */
export function fieldOfView(view: string | null): string | null {
	const field = new URLSearchParams(view ?? "").get("field");
	return field && /^[a-z][A-Za-z0-9_]{0,63}(?:\.[a-z][A-Za-z0-9_]{0,63}){0,2}$/.test(field) ? field : null;
}

/** A Fields tab's view naming its chosen Field (null: none). */
export function viewOfField(path: string | null): string | null {
	return path === null ? null : new URLSearchParams({ field: path }).toString();
}

/**
 * One Post Type in the Content place (SPEC 8, `places-content/03`): a header 40 high with its name and
 * its tabs (Entries, Fields, Settings: sections of the place, so each has an icon and a word), and the
 * open tab under it. The tabs are addresses (`content/<id>`, `content/<id>/fields`,
 * `content/<id>/settings`), so Back returns to the one before.
 */
export function PostTypePane({
	words,
	language,
	api,
	siteId,
	postType,
	postTypes,
	tab,
	view,
	admin,
	onTab,
	onView,
	onSaved,
	onSaving,
	onDeleted,
	announce,
}: {
	words: Words;
	language: string;
	api: BuildingAreaApiClient;
	siteId: string;
	postType: PostTypeRow;
	postTypes: readonly PostTypeRow[];
	tab: Exclude<PostTypeTab, "entries">;
	view: string | null;
	/** The Site in the admin. */
	admin: string;
	onTab(tab: PostTypeTab): void;
	/** Changes the place's view in place (the chosen Field). */
	onView(view: string | null): void;
	onSaved(postType: PostTypeRow): void;
	onSaving(status: "saving" | "saved" | "failed"): void;
	onDeleted(postType: Deleting): Promise<void>;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.postTypes;
	const pages = postType.builtIn === "page";
	const name = pages ? words.content.pages : postType.name;
	const [deleting, setDeleting] = useState(false);
	const opener = useRef<HTMLElement | null>(null);
	const here = `${admin}/post-types/${postType.id}`;

	const tabs: { key: PostTypeTab; label: string; icon: Icon }[] = [
		{ key: "entries", label: shown.tabs.entries, icon: ListIcon },
		{ key: "fields", label: shown.tabs.fields, icon: TextCursorInputIcon },
		{ key: "settings", label: shown.tabs.settings, icon: SlidersHorizontalIcon },
	];

	return (
		<div className="flex h-full min-h-0 flex-col" data-wc-post-type-pane={postType.key} data-wc-post-type-tab={tab}>
			<div className="border-chrome-line flex h-10 shrink-0 items-center gap-4 border-b px-4">
				<h2 className="text-chrome-strong m-0 truncate text-[16px] font-semibold">{name}</h2>
				<nav aria-label={fill(shown.tabs.label, { name })} className="flex items-center gap-1.5">
					{tabs.map(({ key, label, icon: Glyph }) => {
						const current = key === tab;
						return (
							<button
								key={key}
								type="button"
								aria-current={current ? "page" : undefined}
								onClick={() => onTab(key)}
								className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium ${
									current
										? "border-chrome-hover bg-chrome-raised text-chrome-strong"
										: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text border-transparent"
								} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-post-type-tab-button={key}
							>
								<Glyph aria-hidden="true" className="size-3.5" />
								{label}
							</button>
						);
					})}
				</nav>
			</div>
			{tab === "fields" ? (
				<FieldsTab
					key={postType.id}
					words={words}
					api={api}
					siteId={siteId}
					postType={postType}
					postTypes={postTypes}
					selected={fieldOfView(view)}
					admin={here}
					onSelect={(path) => onView(viewOfField(path))}
					onSaved={onSaved}
					onSaving={onSaving}
					announce={announce}
				/>
			) : (
				<div className="min-h-0 grow overflow-y-auto">
					<SettingsTab
						key={postType.id}
						words={words}
						api={api}
						siteId={siteId}
						postType={postType}
						admin={here}
						onSaved={onSaved}
						onSaving={onSaving}
						onDelete={() => {
							opener.current = document.activeElement as HTMLElement | null;
							setDeleting(true);
						}}
						announce={announce}
					/>
				</div>
			)}
			{deleting ? (
				<DeleteDialog
					words={words}
					language={language}
					api={api}
					siteId={siteId}
					postType={{ id: postType.id, name }}
					onClose={() => {
						setDeleting(false);
						opener.current?.focus();
					}}
					onDeleted={() => {
						setDeleting(false);
						announce(fill(shown.deleted, { name }));
						void onDeleted({ id: postType.id, name });
					}}
				/>
			) : null}
		</div>
	);
}
