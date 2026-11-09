import { FIELD_TYPES, type FieldType } from "@webcraft/core/field-rules";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	AtSignIcon,
	BracesIcon,
	CalendarIcon,
	CircleAlertIcon,
	CornerDownRightIcon,
	EllipsisIcon,
	FileTextIcon,
	HashIcon,
	ImageIcon,
	LinkIcon,
	ListIcon,
	ListOrderedIcon,
	type LucideIcon,
	PilcrowIcon,
	PlusIcon,
	ToggleLeftIcon,
	Trash2Icon,
	TypeIcon,
	WaypointsIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { useT } from "../i18n.tsx";
import { FieldSettingsPanel, type SettingProblems } from "./FieldSettingsPanel.tsx";
import { canHoldFields, changeList, type FieldDraft, newDraft, removeDraft, walk } from "./field-drafts.ts";
import { Announcer, DragHandle, moveItem, useDragOrder } from "./reorder.tsx";

/** The icon of each Field type, in the Field list and the settings panel. */
export const FIELD_TYPE_ICONS: { readonly [Type in FieldType]: LucideIcon } = {
	text: TypeIcon,
	richText: PilcrowIcon,
	body: FileTextIcon,
	number: HashIcon,
	boolean: ToggleLeftIcon,
	date: CalendarIcon,
	select: ListIcon,
	media: ImageIcon,
	link: LinkIcon,
	email: AtSignIcon,
	relationship: WaypointsIcon,
	group: BracesIcon,
	repeater: ListOrderedIcon,
};

/** Who the Fields belong to: a Post Type's Entries, or the Globals (which hold no Relationships). */
/** Whose Fields the builder shows: a Post Type's, the Page Post Type's or the Globals'. */
export type FieldOwner = "postType" | "page" | "globals" | "loop";

/**
 * The Field types a new Field can be, at a depth among `all` (every Field on the screen, `uid` being
 * the one changing type): Globals and Loop items hold no Relationships, Groups and Repeaters nest 3 deep, and only a
 * Post Type other than Pages has a Body field, one at most, at the top of its Fields.
 */
export function offeredTypes(owner: FieldOwner, depth: number, all: readonly FieldDraft[], uid?: string): FieldType[] {
	const hasBody = all.some((draft) => draft.field.type === "body" && draft.uid !== uid);
	return FIELD_TYPES.filter(
		(type) =>
			!((owner === "globals" || owner === "loop") && type === "relationship") &&
			!((type === "group" || type === "repeater") && !canHoldFields(type, depth)) &&
			!(type === "body" && (owner !== "postType" || depth > 1 || hasBody)),
	);
}

/**
 * The Field builder: a Post Type's (or the Globals') Fields as one list, the Fields inside Groups
 * and Repeaters indented under them, and the selected Field's settings in a side panel. Fields are
 * added from a menu of types, moved by dragging their handle or with Move up and Move down in their
 * menu, and removed. Nothing is saved until the screen saves the whole list.
 */
export function FieldBuilder({
	drafts,
	onChange,
	selected,
	onSelect,
	problems,
	owner,
	postTypes,
	siteId,
	defaultLanguage,
}: {
	drafts: readonly FieldDraft[];
	onChange(drafts: FieldDraft[]): void;
	selected: string | null;
	onSelect(uid: string | null): void;
	/** Problems the server found with each Field's settings, by the Field's draft id. */
	problems: ReadonlyMap<string, SettingProblems>;
	owner: FieldOwner;
	/** The Site's Post Types, which a Relationship may point at. */
	postTypes: readonly { key: string; name: string }[];
	siteId: string;
	defaultLanguage: string;
}) {
	const t = useT();
	const [announcement, setAnnouncement] = useState("");
	const rows = walk(drafts);
	const current = selected ? rows.find((row) => row.draft.uid === selected) : undefined;

	const add = (parent: string | null, siblings: readonly FieldDraft[], type: FieldType) => {
		const draft = newDraft(type, siblings, t(`content.types.${type}`));
		onChange(changeList(drafts, parent, (list) => [...list, draft]));
		onSelect(draft.uid);
		setAnnouncement(t("postTypes.fields.added", { type: t(`content.types.${type}`) }));
	};

	const move = (parent: string | null, list: readonly FieldDraft[], from: number, to: number) => {
		if (to < 0 || to >= list.length) return;
		onChange(changeList(drafts, parent, (items) => moveItem(items, from, to)));
		const moved = list[from];
		if (moved) {
			setAnnouncement(
				t("postTypes.fields.moved", { label: moved.field.label || moved.field.key, place: to + 1, count: list.length }),
			);
		}
	};

	const remove = (draft: FieldDraft) => {
		onChange(removeDraft(drafts, draft.uid));
		if (selected === draft.uid) onSelect(null);
		setAnnouncement(t("postTypes.fields.removed", { label: draft.field.label || draft.field.key }));
	};

	return (
		<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
			<section aria-labelledby="field-list-heading" className="grid min-w-0 content-start gap-3">
				<h2 id="field-list-heading" className="text-lg font-semibold tracking-tight">
					{t("postTypes.fields.heading")}
				</h2>
				<div className="rounded-lg border">
					{drafts.length === 0 ? (
						<p className="text-muted-foreground p-6 text-center text-sm">{t("postTypes.fields.empty")}</p>
					) : (
						<FieldList
							drafts={drafts}
							parent={null}
							depth={1}
							all={drafts}
							selected={selected}
							problems={problems}
							owner={owner}
							onSelect={onSelect}
							onMove={move}
							onRemove={remove}
							onAdd={add}
						/>
					)}
					<div className="border-t p-2">
						<AddFieldMenu
							id="field-list-add"
							owner={owner}
							depth={1}
							all={drafts}
							label={t("postTypes.fields.add")}
							description={t("postTypes.fields.addHelp")}
							onAdd={(type) => add(null, drafts, type)}
						/>
					</div>
				</div>
				<Announcer message={announcement} />
			</section>
			{current ? (
				<FieldSettingsPanel
					key={current.draft.uid}
					draft={current.draft}
					depth={current.depth}
					siblings={current.siblings}
					all={drafts}
					problems={problems.get(current.draft.uid) ?? []}
					owner={owner}
					postTypes={postTypes}
					siteId={siteId}
					defaultLanguage={defaultLanguage}
					onChange={onChange}
					onClose={() => {
						onSelect(null);
						document.getElementById(`field-row-${current.draft.uid}`)?.focus();
					}}
					onRemove={() => {
						remove(current.draft);
						document.getElementById("field-list-add")?.focus();
					}}
				/>
			) : (
				<p className="text-muted-foreground hidden rounded-lg border border-dashed p-6 text-center text-sm xl:block">
					{t("postTypes.fields.selectHint")}
				</p>
			)}
		</div>
	);
}

/** One list of Fields (the top, or a Group's or Repeater's), each row with the Fields inside it below. */
function FieldList({
	drafts,
	parent,
	depth,
	all,
	selected,
	problems,
	owner,
	onSelect,
	onMove,
	onRemove,
	onAdd,
}: {
	drafts: readonly FieldDraft[];
	parent: string | null;
	depth: number;
	all: readonly FieldDraft[];
	selected: string | null;
	problems: ReadonlyMap<string, SettingProblems>;
	owner: FieldOwner;
	onSelect(uid: string): void;
	onMove(parent: string | null, list: readonly FieldDraft[], from: number, to: number): void;
	onRemove(draft: FieldDraft): void;
	onAdd(parent: string | null, siblings: readonly FieldDraft[], type: FieldType): void;
}) {
	const drag = useDragOrder((from, to) => onMove(parent, drafts, from, to));
	return (
		<ol className={depth === 1 ? "divide-y" : "divide-y border-t"}>
			{drafts.map((draft, index) => (
				<FieldRow
					key={draft.uid}
					draft={draft}
					index={index}
					count={drafts.length}
					depth={depth}
					all={all}
					selected={selected}
					problems={problems}
					owner={owner}
					drag={drag}
					onSelect={onSelect}
					onMove={(to) => onMove(parent, drafts, index, to)}
					onRemove={() => onRemove(draft)}
					onListMove={onMove}
					onListRemove={onRemove}
					onAdd={onAdd}
				/>
			))}
		</ol>
	);
}

function FieldRow({
	draft,
	index,
	count,
	depth,
	all,
	selected,
	problems,
	owner,
	drag,
	onSelect,
	onMove,
	onRemove,
	onListMove,
	onListRemove,
	onAdd,
}: {
	draft: FieldDraft;
	index: number;
	count: number;
	depth: number;
	all: readonly FieldDraft[];
	selected: string | null;
	problems: ReadonlyMap<string, SettingProblems>;
	owner: FieldOwner;
	drag: ReturnType<typeof useDragOrder>;
	onSelect(uid: string): void;
	onMove(to: number): void;
	onRemove(): void;
	onListMove(parent: string | null, list: readonly FieldDraft[], from: number, to: number): void;
	onListRemove(draft: FieldDraft): void;
	onAdd(parent: string | null, siblings: readonly FieldDraft[], type: FieldType): void;
}) {
	const t = useT();
	const row = useRef<HTMLLIElement>(null);
	const { field } = draft;
	const Icon = FIELD_TYPE_ICONS[field.type];
	const current = selected === draft.uid;
	const hasProblems = (problems.get(draft.uid)?.length ?? 0) > 0;
	const label = field.label || field.key;
	const holds = canHoldFields(field.type, depth);
	return (
		<li ref={row} {...drag.itemProps(index)} className="data-[drop-target=true]:bg-muted">
			<div
				className={`flex items-center gap-1 py-1.5 pe-2 ${current ? "bg-muted" : ""}`}
				style={{ paddingInlineStart: `${(depth - 1) * 1.5 + 0.25}rem` }}
			>
				<DragHandle {...drag.handleProps(index, () => row.current)} />
				{depth > 1 ? (
					<CornerDownRightIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				) : null}
				<button
					id={`field-row-${draft.uid}`}
					type="button"
					aria-current={current ? "true" : undefined}
					onClick={() => onSelect(draft.uid)}
					className="hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1 text-start outline-none focus-visible:ring-3"
				>
					<span className="bg-background flex size-8 shrink-0 items-center justify-center rounded-md border">
						<Icon className="size-4" aria-hidden="true" />
					</span>
					<span className="grid min-w-32 flex-1">
						<span className="truncate font-medium">{label}</span>
						<span className="text-muted-foreground truncate font-mono text-xs">{field.key}</span>
					</span>
					<span className="text-muted-foreground w-28 shrink-0 text-sm">{t(`content.types.${field.type}`)}</span>
					<span className="flex flex-wrap justify-end gap-1">
						{hasProblems ? (
							<Badge variant="outline" className="border-destructive/60">
								<CircleAlertIcon className="text-destructive" aria-hidden="true" />
								{t("postTypes.fields.needsAttention")}
							</Badge>
						) : null}
						{!draft.saved ? <Badge variant="outline">{t("postTypes.fields.new")}</Badge> : null}
						{field.required ? <Badge variant="secondary">{t("postTypes.settings.required")}</Badge> : null}
						{field.translatable ? <Badge variant="outline">{t("postTypes.settings.translatable")}</Badge> : null}
						{field.type === "relationship" ? (
							<Badge variant="outline">
								{t(field.twoWay ? "postTypes.settings.twoWay" : "postTypes.settings.oneWay")}
							</Badge>
						) : null}
					</span>
				</button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("postTypes.fields.actions", { label })}
							/>
						}
					>
						<EllipsisIcon aria-hidden="true" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-auto min-w-40">
						<DropdownMenuItem disabled={index === 0} onClick={() => onMove(index - 1)}>
							<ArrowUpIcon aria-hidden="true" />
							{t("content.moveUp")}
						</DropdownMenuItem>
						<DropdownMenuItem disabled={index === count - 1} onClick={() => onMove(index + 1)}>
							<ArrowDownIcon aria-hidden="true" />
							{t("content.moveDown")}
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onClick={onRemove}>
							<Trash2Icon aria-hidden="true" />
							{t("postTypes.fields.remove")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{holds ? (
				<>
					{draft.children.length > 0 ? (
						<FieldList
							drafts={draft.children}
							parent={draft.uid}
							depth={depth + 1}
							all={all}
							selected={selected}
							problems={problems}
							owner={owner}
							onSelect={onSelect}
							onMove={onListMove}
							onRemove={onListRemove}
							onAdd={onAdd}
						/>
					) : null}
					<div className="border-t py-1" style={{ paddingInlineStart: `${depth * 1.5 + 1.75}rem` }}>
						<AddFieldMenu
							owner={owner}
							depth={depth + 1}
							all={all}
							label={t("postTypes.fields.addInside", { label })}
							onAdd={(type) => onAdd(draft.uid, draft.children, type)}
							size="sm"
						/>
					</div>
				</>
			) : null}
		</li>
	);
}

/** A menu of the Field types that can be added at a depth (Globals hold no Relationships). */
function AddFieldMenu({
	id,
	owner,
	depth,
	all,
	label,
	description,
	onAdd,
	size = "default",
}: {
	id?: string;
	owner: FieldOwner;
	depth: number;
	/** Every Field on the screen, top level first. */
	all: readonly FieldDraft[];
	label: string;
	description?: string;
	onAdd(type: FieldType): void;
	size?: "default" | "sm";
}) {
	const t = useT();
	const types = offeredTypes(owner, depth, all);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button id={id} type="button" variant="ghost" size={size} />}>
				<PlusIcon aria-hidden="true" />
				{label}
				{description ? <span className="text-muted-foreground font-normal">{description}</span> : null}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-auto min-w-48">
				{types.map((type) => {
					const Icon = FIELD_TYPE_ICONS[type];
					return (
						<DropdownMenuItem key={type} onClick={() => onAdd(type)}>
							<Icon aria-hidden="true" />
							{t(`content.types.${type}`)}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
