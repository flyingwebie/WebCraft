import { TEXT_VALUE_MAX_LENGTH } from "@webcraft/core/field-rules";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronDownIcon,
	CircleAlertIcon,
	EllipsisIcon,
	LockIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { Fragment, type ReactNode, useRef, useState } from "react";

import { useT } from "../i18n.tsx";
import { MediaPicker } from "../media/MediaPicker.tsx";
import type { MediaItem } from "../media/preview.ts";
import { BodyEditor } from "./body/BodyEditor.tsx";
import {
	controlId,
	type FieldDefinition,
	type FieldValues,
	groupValues,
	type Json,
	newRow,
	type Problem,
	problemsAt,
	problemsWithin,
	type RowValue,
	rowsOf,
} from "./model.ts";
import { problemText } from "./problems.ts";
import { RelationshipPicker, type RelationshipTargets } from "./RelationshipPicker.tsx";
import { RichTextEditor } from "./RichTextEditor.tsx";
import { Announcer, DragHandle, moveItem, useDragOrder } from "./reorder.tsx";

/** What every value's control needs to know about where it is. */
export type ValueContext = {
	siteId: string;
	postTypeId?: string;
	/** Makes control ids unique on the page (`entry`, `globals`, `default`). */
	idPrefix: string;
	/** The language being written; shared Fields are written in the Default language whatever the tab. */
	language: string;
	defaultLanguage: string;
	/** What keeps the values from being published or saved, each at its path. */
	problems: readonly Problem[];
	/** The Entries each Relationship can point at, by Post Type key. */
	relationships: RelationshipTargets;
	/** What the admin knows of the files media Fields hold, by id. */
	media: Readonly<Record<string, MediaItem>>;
	onMediaChosen(item: MediaItem): void;
	/** Whether to mark shared (not translatable) Fields with a lock: values that hold a language. */
	markShared: boolean;
};

/** A list of Fields' controls, each changing its own value by key. `at` starts each value's path. */
export function FieldValueList({
	fields,
	values,
	onChange,
	context,
	at = "fields.",
	wrap,
}: {
	fields: readonly FieldDefinition[];
	values: FieldValues;
	onChange(key: string, value: Json): void;
	context: ValueContext;
	at?: string;
	/** Wraps each Field's control, such as with who else is in it (Co-editing). */
	wrap?(field: FieldDefinition, control: ReactNode): ReactNode;
}) {
	return (
		<div className="grid gap-6">
			{fields.map((field) => {
				const control = (
					<FieldValue
						key={field.key}
						field={field}
						value={values[field.key] ?? null}
						onChange={(value) => onChange(field.key, value)}
						path={`${at}${field.key}`}
						context={context}
					/>
				);
				return wrap ? <Fragment key={field.key}>{wrap(field, control)}</Fragment> : control;
			})}
		</div>
	);
}

/** One Field's control, by its type, with its label, help text and problems. */
export function FieldValue({
	field,
	value,
	onChange,
	path,
	context,
}: {
	field: FieldDefinition;
	value: Json;
	onChange(value: Json): void;
	path: string;
	context: ValueContext;
}) {
	if (field.type === "group") {
		return <GroupValue field={field} value={value} onChange={onChange} path={path} context={context} />;
	}
	if (field.type === "repeater") {
		return <RepeaterValue field={field} value={value} onChange={onChange} path={path} context={context} />;
	}
	return <LeafValue field={field} value={value} onChange={onChange} path={path} context={context} />;
}

/** The parts every control shares: ids, problems, and the language its value is written in. */
function useControl(field: FieldDefinition, path: string, context: ValueContext) {
	const id = controlId(context.idPrefix, path);
	const own = problemsAt(context.problems, path);
	const describedBy = [field.help ? `${id}-help` : null, own.length > 0 ? `${id}-problems` : null]
		.filter(Boolean)
		.join(" ");
	return {
		id,
		labelId: `${id}-label`,
		describedBy: describedBy || undefined,
		invalid: own.length > 0,
		own,
		lang: field.translatable ? context.language : context.defaultLanguage,
	};
}

/** A Field's label: its name, a mark when it must have a value to publish, and the shared lock. */
function ValueLabel({
	field,
	id,
	htmlFor,
	context,
	as = "label",
}: {
	field: FieldDefinition;
	id: string;
	htmlFor?: string;
	context: ValueContext;
	as?: "label" | "legend" | "span";
}) {
	const t = useT();
	const text = (
		<>
			{field.label}
			{field.required ? (
				<>
					<span aria-hidden="true" className="text-destructive">
						{" "}
						*
					</span>
					<span className="sr-only"> {t("content.requiredToPublish")}</span>
				</>
			) : null}
		</>
	);
	const shared = <SharedMark field={field} context={context} />;
	if (as === "legend") {
		return (
			<legend id={id} className="flex w-full items-center justify-between gap-2 text-sm font-medium">
				<span>{text}</span>
				{shared}
			</legend>
		);
	}
	return (
		<div className="flex items-center justify-between gap-2">
			{as === "label" ? (
				<Label id={id} htmlFor={htmlFor}>
					{text}
				</Label>
			) : (
				<span id={id} className="text-sm leading-none font-medium">
					{text}
				</span>
			)}
			{shared}
		</div>
	);
}

/** A Field's help text and its problems, in the person's language. */
function FieldNotes({
	field,
	id,
	problems,
	children,
}: {
	field: FieldDefinition;
	id: string;
	problems: readonly Problem[];
	children?: ReactNode;
}) {
	const t = useT();
	return (
		<>
			{field.help ? (
				<p id={`${id}-help`} className="text-muted-foreground text-sm">
					{field.help}
				</p>
			) : null}
			{children}
			{problems.length > 0 ? (
				<ul id={`${id}-problems`} className="text-destructive grid gap-1 text-sm">
					{problems.map((problem) => (
						<li key={`${problem.at}:${problem.rule ?? problem.message}`} className="flex items-start gap-1.5">
							<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>{problemText(t, problem, field)}</span>
						</li>
					))}
				</ul>
			) : null}
		</>
	);
}

type LeafField = Exclude<FieldDefinition, { type: "group" | "repeater" }>;

function LeafValue({
	field,
	value,
	onChange,
	path,
	context,
}: {
	field: LeafField;
	value: Json;
	onChange(value: Json): void;
	path: string;
	context: ValueContext;
}) {
	const t = useT();
	const control = useControl(field, path, context);
	const common = {
		id: control.id,
		"aria-describedby": control.describedBy,
		"aria-invalid": control.invalid ? true : undefined,
		lang: control.lang,
	} as const;

	switch (field.type) {
		case "boolean":
			return (
				<div className="grid gap-2">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<Checkbox
								id={control.id}
								checked={value === true}
								onCheckedChange={(checked) => onChange(checked === true)}
								aria-describedby={control.describedBy}
								aria-invalid={control.invalid ? true : undefined}
							/>
							<Label id={control.labelId} htmlFor={control.id}>
								{field.label}
							</Label>
						</div>
						<SharedMark field={field} context={context} />
					</div>
					<FieldNotes field={field} id={control.id} problems={control.own} />
				</div>
			);
		case "link": {
			const link = value && typeof value === "object" && !Array.isArray(value) ? (value as FieldValues) : {};
			const set = (part: "url" | "text", next: string) =>
				onChange({ url: String(link.url ?? ""), text: String(link.text ?? ""), [part]: next });
			return (
				<fieldset className="grid gap-2" aria-describedby={control.describedBy}>
					<ValueLabel field={field} id={control.labelId} context={context} as="legend" />
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor={control.id} className="text-muted-foreground font-normal">
								{t("content.link.address")}
							</Label>
							<Input
								{...common}
								value={String(link.url ?? "")}
								onChange={(event) => set("url", event.target.value)}
								inputMode="url"
								autoComplete="off"
								placeholder="https://"
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor={`${control.id}-text`} className="text-muted-foreground font-normal">
								{t("content.link.text")}
							</Label>
							<Input
								{...common}
								id={`${control.id}-text`}
								value={String(link.text ?? "")}
								onChange={(event) => set("text", event.target.value)}
								maxLength={300}
								autoComplete="off"
							/>
						</div>
					</div>
					<FieldNotes field={field} id={control.id} problems={control.own} />
				</fieldset>
			);
		}
		case "select":
			if (field.multiple) {
				const chosen = Array.isArray(value) ? (value as string[]) : [];
				return (
					<fieldset className="grid gap-2" aria-describedby={control.describedBy}>
						<ValueLabel field={field} id={control.labelId} context={context} as="legend" />
						<div className="flex flex-wrap gap-x-5 gap-y-2">
							{field.options.map((option) => {
								const optionId = `${control.id}-${option.value}`;
								return (
									<div key={option.value} className="flex items-center gap-2">
										<Checkbox
											id={optionId}
											checked={chosen.includes(option.value)}
											onCheckedChange={(checked) =>
												onChange(
													checked === true
														? [...chosen, option.value]
														: chosen.filter((choice) => choice !== option.value),
												)
											}
										/>
										<Label htmlFor={optionId} className="font-normal">
											{option.label}
										</Label>
									</div>
								);
							})}
						</div>
						<FieldNotes field={field} id={control.id} problems={control.own} />
					</fieldset>
				);
			}
			return (
				<LeafFrame field={field} control={control} context={context}>
					<NativeSelect
						{...common}
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value || null)}
						className="w-full"
					>
						<NativeSelectOption value="">{t("content.select.none")}</NativeSelectOption>
						{typeof value === "string" && value && !field.options.some((option) => option.value === value) ? (
							<NativeSelectOption value={value}>{value}</NativeSelectOption>
						) : null}
						{field.options.map((option) => (
							<NativeSelectOption key={option.value} value={option.value}>
								{option.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</LeafFrame>
			);
		case "richText":
			return (
				<LeafFrame field={field} control={control} context={context} labelAs="span">
					<RichTextEditor
						id={control.id}
						labelledBy={control.labelId}
						describedBy={control.describedBy}
						invalid={control.invalid}
						lang={control.lang}
						value={typeof value === "string" ? value : null}
						onChange={onChange}
					/>
				</LeafFrame>
			);
		case "body":
			return (
				<LeafFrame field={field} control={control} context={context} labelAs="span">
					<BodyEditor
						postTypeId={context.postTypeId}
						siteId={context.siteId}
						id={control.id}
						labelledBy={control.labelId}
						describedBy={control.describedBy}
						invalid={control.invalid}
						lang={control.lang}
						path={path}
						value={value}
						blocksOff={field.blocksOff}
						problems={context.problems}
						media={context.media}
						onMediaChosen={context.onMediaChosen}
						onChange={(blocks) => onChange(blocks as unknown as Json)}
					/>
				</LeafFrame>
			);
		case "media": {
			const mediaId = typeof value === "string" ? value : null;
			return (
				<LeafFrame field={field} control={control} context={context} labelAs="span">
					<MediaPicker
						siteId={context.siteId}
						id={control.id}
						labelledBy={control.labelId}
						describedBy={control.describedBy}
						invalid={control.invalid}
						value={mediaId}
						item={mediaId ? (context.media[mediaId] ?? null) : null}
						onChange={(next) => {
							if (next) context.onMediaChosen(next.item);
							onChange(next ? next.id : null);
						}}
					/>
				</LeafFrame>
			);
		}
		case "relationship":
			return (
				<LeafFrame field={field} control={control} context={context} labelAs={field.multiple ? "span" : "label"}>
					<RelationshipPicker
						id={control.id}
						labelledBy={control.labelId}
						describedBy={control.describedBy}
						invalid={control.invalid}
						field={field}
						value={Array.isArray(value) ? (value as string[]) : typeof value === "string" ? value : null}
						targets={context.relationships}
						onChange={onChange}
					/>
				</LeafFrame>
			);
		case "number":
			return (
				<LeafFrame field={field} control={control} context={context}>
					<NumberInput
						common={common}
						value={typeof value === "number" ? value : null}
						integer={field.integer}
						min={field.min}
						max={field.max}
						onChange={onChange}
					/>
				</LeafFrame>
			);
		case "date":
			return (
				<LeafFrame field={field} control={control} context={context}>
					<div className="flex items-center gap-2">
						<Input
							{...common}
							type={field.mode === "dateTime" ? "datetime-local" : field.mode}
							value={dateInputValue(value, field.mode)}
							onChange={(event) => onChange(dateValue(event.target.value, field.mode))}
							className="w-auto"
						/>
						{field.mode === "dateTime" ? <span className="text-muted-foreground text-sm">UTC</span> : null}
					</div>
				</LeafFrame>
			);
		case "email":
			return (
				<LeafFrame field={field} control={control} context={context}>
					<Input
						{...common}
						type="email"
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value)}
						maxLength={320}
						autoComplete="off"
					/>
				</LeafFrame>
			);
		case "text":
			return (
				<LeafFrame field={field} control={control} context={context}>
					<Input
						{...common}
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value)}
						maxLength={field.maxLength ?? TEXT_VALUE_MAX_LENGTH}
						autoComplete="off"
					/>
				</LeafFrame>
			);
	}
}

/** The lock a shared (not translatable) Field shows beside its label: one value in every language. */
function SharedMark({ field, context }: { field: FieldDefinition; context: ValueContext }) {
	const t = useT();
	if (!context.markShared || field.translatable || field.type === "group" || field.type === "repeater") return null;
	return (
		<span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-normal">
			<LockIcon className="size-3" aria-hidden="true" />
			{t("content.shared")}
			<span className="sr-only"> {t("content.sharedHelp")}</span>
		</span>
	);
}

/** A leaf Field's label, its control, then its help text and problems. */
function LeafFrame({
	field,
	control,
	context,
	labelAs = "label",
	children,
}: {
	field: FieldDefinition;
	control: ReturnType<typeof useControl>;
	context: ValueContext;
	labelAs?: "label" | "span";
	children: ReactNode;
}) {
	return (
		<div className="grid gap-2">
			<ValueLabel
				field={field}
				id={control.labelId}
				htmlFor={labelAs === "label" ? control.id : undefined}
				context={context}
				as={labelAs}
			/>
			{children}
			<FieldNotes field={field} id={control.id} problems={control.own} />
		</div>
	);
}

/** A number box that keeps what is being typed (`-`, `1.`) until it is a number. */
function NumberInput({
	common,
	value,
	integer,
	min,
	max,
	onChange,
}: {
	common: Record<string, unknown>;
	value: number | null;
	integer: boolean;
	min: number | null;
	max: number | null;
	onChange(value: Json): void;
}) {
	const [text, setText] = useState(value === null ? "" : String(value));
	return (
		<Input
			{...common}
			type="number"
			inputMode={integer ? "numeric" : "decimal"}
			step={integer ? 1 : "any"}
			min={min ?? undefined}
			max={max ?? undefined}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				const typed = event.target.value.trim();
				if (typed === "") onChange(null);
				else if (Number.isFinite(Number(typed))) onChange(Number(typed));
			}}
			className="w-48"
		/>
	);
}

/** A stored date as a date, time or date-and-time box shows it (moments in UTC, without the zone). */
function dateInputValue(value: Json, mode: "date" | "time" | "dateTime"): string {
	if (typeof value !== "string") return "";
	return mode === "dateTime" ? value.replace(/:\d\dZ$/, "").replace(/Z$/, "") : value;
}

/** What a date box holds, as WebCraft stores it; empty clears it. */
function dateValue(input: string, mode: "date" | "time" | "dateTime"): Json {
	if (input === "") return null;
	return mode === "dateTime" ? `${input.slice(0, 16)}:00Z` : input;
}

type GroupField = Extract<FieldDefinition, { type: "group" }>;
type RepeaterField = Extract<FieldDefinition, { type: "repeater" }>;

function GroupValue({
	field,
	value,
	onChange,
	path,
	context,
}: {
	field: GroupField;
	value: Json;
	onChange(value: Json): void;
	path: string;
	context: ValueContext;
}) {
	const control = useControl(field, path, context);
	const values = groupValues(value);
	return (
		<fieldset className="grid gap-4 rounded-lg border p-4" aria-describedby={control.describedBy}>
			<ValueLabel field={field} id={control.labelId} context={context} as="legend" />
			<FieldNotes field={field} id={control.id} problems={control.own} />
			<FieldValueList
				fields={field.fields}
				values={values}
				onChange={(key, next) => onChange({ ...values, [key]: next })}
				context={context}
				at={`${path}.`}
			/>
		</fieldset>
	);
}

/**
 * A Repeater's rows, in order, each with its Fields. Rows are added at the end, removed, and moved
 * by dragging their handle or with Move up and Move down in their menu.
 */
function RepeaterValue({
	field,
	value,
	onChange,
	path,
	context,
}: {
	field: RepeaterField;
	value: Json;
	onChange(value: Json): void;
	path: string;
	context: ValueContext;
}) {
	const t = useT();
	const control = useControl(field, path, context);
	const rows = rowsOf(value);
	const [open, setOpen] = useState<ReadonlySet<string>>(
		() => new Set(rows.length <= 3 ? rows.map((row) => row.id) : []),
	);
	const [announcement, setAnnouncement] = useState("");
	const addButton = useRef<HTMLButtonElement>(null);
	const move = (from: number, to: number) => {
		if (to < 0 || to >= rows.length) return;
		onChange(moveItem(rows, from, to));
		setAnnouncement(t("content.repeater.moved", { from: from + 1, to: to + 1, count: rows.length }));
	};
	const drag = useDragOrder(move);
	const full = field.max !== null && rows.length >= field.max;

	return (
		<fieldset className="grid gap-3" aria-describedby={control.describedBy}>
			<ValueLabel field={field} id={control.labelId} context={context} as="legend" />
			<FieldNotes field={field} id={control.id} problems={control.own} />
			{rows.length > 0 ? (
				<ol className="grid gap-2">
					{rows.map((row, index) => (
						<RepeaterRow
							key={row.id}
							field={field}
							row={row}
							index={index}
							count={rows.length}
							expanded={open.has(row.id) || problemsWithin(context.problems, `${path}[${index}]`).length > 0}
							onToggle={() =>
								setOpen((before) => {
									const next = new Set(before);
									if (next.has(row.id)) next.delete(row.id);
									else next.add(row.id);
									return next;
								})
							}
							onChange={(next) => onChange(rows.map((other) => (other.id === row.id ? next : other)))}
							onMove={(to) => move(index, to)}
							onRemove={() => {
								onChange(rows.filter((other) => other.id !== row.id));
								setAnnouncement(t("content.repeater.removed", { row: index + 1 }));
								addButton.current?.focus();
							}}
							path={`${path}[${index}]`}
							context={context}
							drag={drag}
						/>
					))}
				</ol>
			) : null}
			<div>
				<Button
					ref={addButton}
					type="button"
					variant="ghost"
					disabled={full}
					onClick={() => {
						const row = newRow(field.fields);
						setOpen((before) => new Set([...before, row.id]));
						onChange([...rows, row]);
						setAnnouncement(t("content.repeater.added", { row: rows.length + 1 }));
					}}
				>
					<PlusIcon aria-hidden="true" />
					{t("content.repeater.add", { label: field.label })}
				</Button>
			</div>
			<Announcer message={announcement} />
		</fieldset>
	);
}

/** What a row is called in its header: its first text value, else its number. */
function rowSummary(field: RepeaterField, row: RowValue): string {
	for (const inner of field.fields) {
		const value = row[inner.key];
		if ((inner.type === "text" || inner.type === "email") && typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return "";
}

function RepeaterRow({
	field,
	row,
	index,
	count,
	expanded,
	onToggle,
	onChange,
	onMove,
	onRemove,
	path,
	context,
	drag,
}: {
	field: RepeaterField;
	row: RowValue;
	index: number;
	count: number;
	expanded: boolean;
	onToggle(): void;
	onChange(row: RowValue): void;
	onMove(to: number): void;
	onRemove(): void;
	path: string;
	context: ValueContext;
	drag: ReturnType<typeof useDragOrder>;
}) {
	const t = useT();
	const item = useRef<HTMLLIElement>(null);
	const id = controlId(context.idPrefix, path);
	const summary = rowSummary(field, row);
	const name = t("content.repeater.row", { row: index + 1 });
	return (
		<li
			ref={item}
			{...drag.itemProps(index)}
			className="data-[drop-target=true]:border-primary rounded-lg border data-[drop-target=true]:border-dashed"
		>
			<div className="flex items-center gap-1 p-1 ps-0">
				<DragHandle {...drag.handleProps(index, () => item.current)} />
				<Button
					type="button"
					variant="ghost"
					className="h-auto min-w-0 flex-1 justify-start py-1.5"
					aria-expanded={expanded}
					aria-controls={`${id}-fields`}
					onClick={onToggle}
				>
					<ChevronDownIcon
						className={`transition-transform ${expanded ? "" : "-rotate-90 rtl:rotate-90"}`}
						aria-hidden="true"
					/>
					<span className="text-muted-foreground tabular-nums">{index + 1}</span>
					<span className="truncate">{summary || name}</span>
					{summary ? <span className="sr-only">, {name}</span> : null}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("content.repeater.actions", { row: index + 1 })}
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
							{t("content.repeater.remove")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div id={`${id}-fields`} hidden={!expanded} className="border-t p-4">
				<FieldValueList
					fields={field.fields}
					values={row}
					onChange={(key, next) => onChange({ ...row, [key]: next })}
					context={context}
					at={`${path}.`}
				/>
			</div>
		</li>
	);
}
