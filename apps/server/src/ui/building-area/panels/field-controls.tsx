import { CalendarIcon, ChevronDownIcon, ImageIcon, TagIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { pickMedia } from "../places/media/pick.ts";
import {
	type EntryDetails,
	type FieldDef,
	fieldsAt,
	type Json,
	type LinkTarget,
	SAVE_AFTER_MS,
	shownFile,
	valueAtPath,
} from "./entry-details.ts";

/**
 * The controls of the Entry panel (Staff, `builder/08`) and of Page details / Post details (Members,
 * `client-flows/01` and `03`), in two looks: `dock`, a field card of a dock's panel (a raised card, a
 * small label over the value, 12 px); and `client`, a field of the Members' side panel (a 13 px label
 * over a 40 high box, 14 px). Each Field is typed: text, rich text, number, a switch, a date, a choice,
 * a Relationship, a file, a link; a Repeater is changed in the admin.
 */
export type Look = "dock" | "client";

/** A box's look: a bare value inside a field card, or a 40 high box of the side panel. */
export function boxClass(look: Look, extra = ""): string {
	return look === "dock"
		? `text-chrome-strong placeholder:text-chrome-faint w-full min-w-0 rounded-[3px] bg-transparent text-[12px] font-medium outline-none ${extra}`
		: `bg-chrome-raised text-chrome-strong placeholder:text-chrome-faint w-full min-w-0 rounded-lg border border-[#3f3f46] px-3 text-[14px] outline-none focus:border-chrome-focus focus:ring-1 focus:ring-chrome-focus ${CHROME_EASE} ${extra}`;
}

/**
 * A labelled field: a raised card with its label (and a count or note at the end) over the control
 * (`dock`), or a label over a box with help under it (`client`). A problem shows under the control.
 */
export function Labelled({
	look,
	id,
	label,
	count,
	hint,
	problem,
	children,
	data,
	as = "label",
}: {
	look: Look;
	/** The control's id: the label names it, and the hint and problem describe it. */
	id: string;
	label: string;
	/** At the label's end: "44 of 60". */
	count?: ReactNode;
	hint?: string | null;
	problem?: string | null;
	children: ReactNode;
	data?: Record<`data-${string}`, string>;
	/** A label for one control; a plain heading for a group of them (named by `aria-labelledby`). */
	as?: "label" | "span";
}) {
	const Label = as;
	const labelProps = as === "label" ? { htmlFor: id } : { id: `${id}-label` };
	return (
		<div
			className={
				look === "dock"
					? "bg-chrome-raised focus-within:ring-chrome-focus/70 flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 focus-within:ring-1"
					: "flex min-w-0 flex-col gap-1.5"
			}
			{...data}
		>
			<div className="flex min-w-0 items-center gap-2">
				<Label
					{...labelProps}
					className={
						look === "dock"
							? "text-chrome-muted min-w-0 grow truncate text-[11px]"
							: "text-chrome-strong min-w-0 grow text-[13px] font-medium"
					}
				>
					{label}
				</Label>
				{count ? (
					<span className={`text-chrome-faint shrink-0 ${look === "dock" ? "text-[11px]" : "text-[12px]"}`}>
						{count}
					</span>
				) : null}
			</div>
			{children}
			{hint ? (
				<p id={`${id}-hint`} className={`text-chrome-muted m-0 ${look === "dock" ? "text-[11px]" : "text-[12px]"}`}>
					{hint}
				</p>
			) : null}
			{problem ? (
				<p
					id={`${id}-problem`}
					className={`text-chrome-danger m-0 ${look === "dock" ? "text-[11px]" : "text-[12px]"}`}
					data-wc-details-problem=""
				>
					{problem}
				</p>
			) : null}
		</div>
	);
}

/** The ids that describe a control: its hint and its problem, when it has them. */
export function describedBy(id: string, hint: unknown, problem: unknown): string | undefined {
	const ids = [hint ? `${id}-hint` : "", problem ? `${id}-problem` : ""].filter(Boolean).join(" ");
	return ids || undefined;
}

/**
 * A value the person types, kept as typed while its box has focus or its change waits to be saved, and
 * following the Entry otherwise (a save answered, someone else's change, another page).
 */
export function useTyped<Value>(value: Value, pending: () => boolean): [Value, (next: Value) => void, Focus] {
	const [typed, setTyped] = useState(value);
	const focused = useRef(false);
	const waiting = useRef(pending);
	waiting.current = pending;
	useEffect(() => {
		if (!focused.current && !waiting.current()) setTyped(value);
	}, [value]);
	return [
		typed,
		setTyped,
		{
			onFocus: () => {
				focused.current = true;
			},
			onBlur: () => {
				focused.current = false;
			},
		},
	];
}

type Focus = { onFocus(): void; onBlur(): void };

/** A switch (role `switch`): 26 × 15 on a card, 40 × 24 in the side panel. */
export function Switch({
	look,
	id,
	on,
	onChange,
	describedBy: description,
	labelledBy,
	label,
}: {
	look: Look;
	id?: string;
	on: boolean;
	onChange(on: boolean): void;
	describedBy?: string;
	labelledBy?: string;
	label?: string;
}) {
	return (
		<button
			id={id}
			type="button"
			role="switch"
			aria-checked={on}
			aria-labelledby={labelledBy}
			aria-label={label}
			aria-describedby={description}
			onClick={() => onChange(!on)}
			className={`inline-flex shrink-0 items-center rounded-full ${on ? "bg-chrome-ok justify-end" : "justify-start bg-[#3f3f46]"} ${
				look === "dock" ? "h-[15px] w-[26px] px-0.5" : "h-6 w-10 px-[3px]"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			data-wc-switch=""
		>
			<span
				aria-hidden="true"
				className={`rounded-full ${on ? "bg-[#052e16]" : "bg-[#e4e4e7]"} ${look === "dock" ? "size-[11px]" : "size-[18px]"}`}
			/>
		</button>
	);
}

/** Initials of a name, for the small avatar beside a Relationship's choice. */
function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "·";
}

function Avatar({ name, look }: { name: string; look: Look }) {
	return (
		<span
			aria-hidden="true"
			className={`inline-grid shrink-0 place-items-center rounded-full bg-[#52525b] font-semibold text-white ${
				look === "dock" ? "size-[18px] text-[8px]" : "size-[22px] text-[9px]"
			}`}
		>
			{initialsOf(name)}
		</span>
	);
}

/** One of the Entry's Fields with its typed control, saving to the Draft as it changes. */
export function FieldControl({
	look,
	words,
	details,
	field,
	path,
	label,
	admin,
	count,
}: {
	look: Look;
	words: Words;
	details: EntryDetails;
	field: FieldDef;
	/** Where its value is among the Entry's Fields (`credits.photographer` inside a Group). */
	path: string;
	label: string;
	/** The admin's Entry editor, for what is changed there (a Repeater). */
	admin: string;
	/** A length to count against ("112 of 160", a Summary). */
	count?: number;
}) {
	const said = words.details;
	const id = useId();
	const key = `fields.${path}`;
	const value = valueAtPath(details.entry?.draft.fields, path);
	const problem = details.problems.get(key) ?? null;
	const language = details.page?.language.name ?? "";
	const shownLabel = details.several && field.translatable ? fill(said.fieldIn, { label, language }) : label;
	const hint = field.help || null;
	const save = (next: unknown, wait = SAVE_AFTER_MS) => details.change(key, { fields: fieldsAt(path, next) }, wait);
	const leave = () => details.flush(key);
	const pending = () => details.pending(key);
	const common = {
		id,
		"aria-describedby": describedBy(id, hint, problem),
		"aria-invalid": problem ? true : undefined,
	} as const;
	const data = { "data-wc-entry-field": path };

	switch (field.type) {
		case "text":
		case "email":
		case "number":
		case "date":
			return (
				<Labelled look={look} id={id} label={shownLabel} hint={hint} problem={problem} data={data}>
					<TypedBox
						look={look}
						field={field}
						value={value}
						save={save}
						leave={leave}
						pending={pending}
						common={common}
						count={count}
					/>
				</Labelled>
			);
		case "richText":
			return (
				<Labelled look={look} id={id} label={shownLabel} hint={hint} problem={problem} data={data} as="span">
					<RichBox look={look} value={value} save={save} leave={leave} pending={pending} common={common} />
				</Labelled>
			);
		case "boolean":
			return (
				<div
					className={
						look === "dock"
							? "bg-chrome-raised flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
							: "flex min-w-0 items-center gap-3"
					}
					{...data}
				>
					<span
						id={`${id}-label`}
						className={
							look === "dock"
								? "text-chrome-muted min-w-0 grow text-[11px]"
								: "text-chrome-strong min-w-0 grow text-[13px] font-medium"
						}
					>
						{shownLabel}
					</span>
					<Switch
						look={look}
						id={id}
						on={value === true}
						onChange={(on) => save(on, 0)}
						labelledBy={`${id}-label`}
						describedBy={common["aria-describedby"]}
					/>
				</div>
			);
		case "select":
			return (
				<Labelled
					look={look}
					id={id}
					label={shownLabel}
					hint={hint}
					problem={problem}
					data={data}
					as={field.multiple ? "span" : "label"}
				>
					{field.multiple ? (
						<fieldset aria-labelledby={`${id}-label`} className="m-0 flex flex-col gap-1 border-0 p-0">
							{field.options.map((option) => {
								const chosen = Array.isArray(value) ? (value as string[]) : [];
								return (
									<label key={option.value} className="text-chrome-text flex items-center gap-2 text-[12px]">
										<input
											type="checkbox"
											checked={chosen.includes(option.value)}
											onChange={(event) =>
												save(
													event.target.checked
														? [...chosen, option.value]
														: chosen.filter((each) => each !== option.value),
													0,
												)
											}
											className={`accent-primary size-3.5 ${FOCUS_RING}`}
										/>
										{option.label}
									</label>
								);
							})}
						</fieldset>
					) : (
						<ChoiceBox look={look} icon={<TagIcon aria-hidden="true" className="text-chrome-muted size-4 shrink-0" />}>
							<select
								{...common}
								value={typeof value === "string" ? value : ""}
								onChange={(event) => save(event.target.value || null, 0)}
								className={choiceClass(look)}
							>
								<option value="">{said.none}</option>
								{field.options.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</ChoiceBox>
					)}
				</Labelled>
			);
		case "relationship":
			return (
				<Labelled
					look={look}
					id={id}
					label={shownLabel}
					hint={hint}
					problem={problem}
					data={data}
					as={field.multiple ? "span" : "label"}
				>
					<RelationshipBox
						look={look}
						words={words}
						id={id}
						common={common}
						field={field}
						value={value}
						targets={details.targets}
						onChange={(next) => save(next, 0)}
					/>
				</Labelled>
			);
		case "media":
			return (
				<Labelled look={look} id={id} label={shownLabel} hint={hint} problem={problem} data={data} as="span">
					<FileBox
						look={look}
						words={words}
						id={id}
						label={shownLabel}
						value={typeof value === "string" ? value : null}
						files={details.files}
						onChoose={async () => {
							const chosen = await pickMedia({ current: typeof value === "string" ? value : null });
							if (!chosen) return;
							details.remember(shownFile(chosen));
							save(chosen.id, 0);
						}}
						onRemove={() => save(null, 0)}
					/>
				</Labelled>
			);
		case "link": {
			const link =
				value && typeof value === "object" && !Array.isArray(value) ? (value as { url?: string; text?: string }) : {};
			return (
				<Labelled look={look} id={id} label={shownLabel} hint={hint} problem={problem} data={data} as="span">
					<LinkBox
						look={look}
						words={words}
						label={shownLabel}
						link={link}
						save={save}
						leave={leave}
						pending={pending}
						common={common}
					/>
				</Labelled>
			);
		}
		default: {
			// A Repeater's rows (and anything else the panels don't change) are changed in the admin.
			const rows = Array.isArray(value) ? value.length : 0;
			return (
				<Labelled look={look} id={id} label={shownLabel} hint={hint} problem={problem} data={data} as="span">
					<p className={`text-chrome-text m-0 ${look === "dock" ? "text-[12px]" : "text-[13px]"}`}>
						{fill(said.rows, { count: String(rows) })} ·{" "}
						<a
							href={admin}
							target="_blank"
							rel="noopener noreferrer"
							className={`text-chrome-accent rounded-sm hover:underline ${FOCUS_RING}`}
						>
							{said.changeInAdmin}
						</a>
					</p>
				</Labelled>
			);
		}
	}
}

type Common = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

/** Text, an email address, a number or a date, typed. */
function TypedBox({
	look,
	field,
	value,
	save,
	leave,
	pending,
	common,
	count,
}: {
	look: Look;
	field: Extract<FieldDef, { type: "text" | "email" | "number" | "date" }>;
	value: Json;
	save(next: unknown, wait?: number): void;
	leave(): void;
	pending(): boolean;
	common: Common;
	count?: number;
}) {
	const shown = value === null || value === undefined ? "" : String(value);
	const [typed, setTyped, focus] = useTyped(shown, pending);
	const type =
		field.type === "number"
			? "number"
			: field.type === "email"
				? "email"
				: field.type === "date"
					? field.mode === "time"
						? "time"
						: field.mode === "dateTime"
							? "datetime-local"
							: "date"
					: "text";
	const read = (text: string): unknown =>
		field.type === "number" ? (text.trim() === "" ? null : Number(text)) : text === "" ? null : text;
	const many = count !== undefined && field.type === "text";
	const box = many ? (
		<textarea
			{...common}
			rows={3}
			value={typed}
			onChange={(event) => {
				setTyped(event.target.value);
				save(read(event.target.value));
			}}
			onFocus={focus.onFocus}
			onBlur={() => {
				focus.onBlur();
				leave();
			}}
			className={boxClass(look, look === "dock" ? "resize-none leading-[18px]" : "resize-none py-2.5 leading-5")}
		/>
	) : (
		<input
			{...common}
			type={type}
			value={typed}
			step={field.type === "number" ? (field.integer ? 1 : "any") : undefined}
			autoComplete="off"
			onChange={(event) => {
				setTyped(event.target.value);
				save(read(event.target.value));
			}}
			onFocus={focus.onFocus}
			onBlur={() => {
				focus.onBlur();
				leave();
			}}
			className={boxClass(look, look === "dock" ? "h-[18px] [color-scheme:dark]" : "h-10 [color-scheme:dark]")}
		/>
	);
	if (field.type !== "date" || look === "dock") return box;
	return (
		<span className="relative flex">
			<CalendarIcon
				aria-hidden="true"
				className="text-chrome-muted pointer-events-none absolute start-3 top-3 size-4"
			/>
			<span className="contents [&>input]:ps-9">{box}</span>
		</span>
	);
}

/** Rich text, in a box that takes formatting (the server keeps what a region keeps). */
function RichBox({
	look,
	value,
	save,
	leave,
	pending,
	common,
}: {
	look: Look;
	value: Json;
	save(next: unknown, wait?: number): void;
	leave(): void;
	pending(): boolean;
	common: Common;
}) {
	const box = useRef<HTMLDivElement>(null);
	const focused = useRef(false);
	const html = typeof value === "string" ? value : "";
	const waiting = useRef(pending);
	waiting.current = pending;
	useEffect(() => {
		const element = box.current;
		if (!element || focused.current || waiting.current()) return;
		// The stored rich text was cleaned by the server: only formatting, lists and links remain.
		if (element.innerHTML !== html) element.innerHTML = html;
	}, [html]);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a box that takes formatting is a contenteditable textbox.
		<div
			ref={box}
			{...common}
			role="textbox"
			tabIndex={0}
			aria-multiline="true"
			aria-labelledby={`${common.id}-label`}
			contentEditable
			suppressContentEditableWarning
			onInput={(event) => save(event.currentTarget.innerHTML)}
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				focused.current = false;
				leave();
			}}
			className={boxClass(look, look === "dock" ? "min-h-[18px] leading-[18px]" : "min-h-20 py-2.5 leading-5")}
		/>
	);
}

/** A native choice drawn as the chrome's: an icon (client), the value, a chevron. */
function ChoiceBox({ look, icon, children }: { look: Look; icon?: ReactNode; children: ReactNode }) {
	return (
		<span className="relative flex min-w-0 items-center">
			{look === "client" && icon ? <span className="pointer-events-none absolute start-3 flex">{icon}</span> : null}
			{children}
			<ChevronDownIcon
				aria-hidden="true"
				className={`text-chrome-muted pointer-events-none absolute ${look === "dock" ? "end-0 size-3" : "end-3 size-4"}`}
			/>
		</span>
	);
}

function choiceClass(look: Look, withIcon = true): string {
	return boxClass(
		look,
		look === "dock"
			? "h-[18px] cursor-pointer appearance-none pe-4 [color-scheme:dark]"
			: `h-10 cursor-pointer appearance-none pe-9 ${withIcon ? "ps-9" : ""} [color-scheme:dark]`,
	);
}

/** The Entries a Relationship points at: one in a list of choices, or several as chips with an Add list. */
function RelationshipBox({
	look,
	words,
	id,
	common,
	field,
	value,
	targets,
	onChange,
}: {
	look: Look;
	words: Words;
	id: string;
	common: Common;
	field: Extract<FieldDef, { type: "relationship" }>;
	value: Json;
	targets: EntryDetails["targets"];
	onChange(next: string | string[] | null): void;
}) {
	const said = words.details;
	const groups = field.postTypes.flatMap((key) => (targets[key] ? [{ key, ...targets[key] }] : []));
	const known = new Map<string, LinkTarget>(groups.flatMap((group) => group.entries.map((entry) => [entry.id, entry])));
	const chosen = Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : [];
	const titleOf = (entryId: string) => known.get(entryId)?.title || said.untitled;
	const options = (leaveOut: readonly string[]) =>
		groups.map((group) => (
			<optgroup key={group.key} label={group.name}>
				{group.entries
					.filter((entry) => !leaveOut.includes(entry.id))
					.map((entry) => (
						<option key={entry.id} value={entry.id}>
							{entry.title || said.untitled}
						</option>
					))}
			</optgroup>
		));
	if (!field.multiple) {
		const current = chosen[0] ?? "";
		return (
			<ChoiceBox look={look} icon={current ? <Avatar name={titleOf(current)} look={look} /> : undefined}>
				{look === "dock" && current ? (
					<span className="pointer-events-none absolute start-0 flex">
						<Avatar name={titleOf(current)} look={look} />
					</span>
				) : null}
				<select
					{...common}
					value={current}
					onChange={(event) => onChange(event.target.value || null)}
					className={`${choiceClass(look, Boolean(current))} ${look === "dock" && current ? "ps-6" : ""}`}
				>
					<option value="">{said.none}</option>
					{current && !known.has(current) ? <option value={current}>{said.untitled}</option> : null}
					{options([])}
				</select>
			</ChoiceBox>
		);
	}
	return (
		<fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" aria-labelledby={`${id}-label`}>
			{chosen.length ? (
				<ul className="m-0 flex list-none flex-wrap gap-1 p-0">
					{chosen.map((entryId) => (
						<li
							key={entryId}
							className={`bg-chrome-hover text-chrome-strong inline-flex items-center gap-1.5 rounded-full ps-1 pe-0.5 font-medium ${
								look === "dock" ? "h-6 text-[12px]" : "h-8 text-[13px]"
							}`}
						>
							<Avatar name={titleOf(entryId)} look={look} />
							{titleOf(entryId)}
							<button
								type="button"
								aria-label={fill(said.removeEntry, { title: titleOf(entryId) })}
								onClick={() => onChange(chosen.filter((each) => each !== entryId))}
								className={`text-chrome-muted hover:text-chrome-strong inline-grid size-5 place-items-center rounded-full ${FOCUS_RING}`}
							>
								<XIcon aria-hidden="true" className="size-3" />
							</button>
						</li>
					))}
				</ul>
			) : null}
			<ChoiceBox look={look}>
				<select
					aria-label={said.addEntry}
					aria-describedby={common["aria-describedby"]}
					value=""
					onChange={(event) => {
						if (event.target.value) onChange([...chosen, event.target.value]);
					}}
					className={choiceClass(look, false)}
				>
					<option value="">{said.addEntry}</option>
					{options(chosen)}
				</select>
			</ChoiceBox>
		</fieldset>
	);
}

/** A file a media Field holds: its picture, name and alt text; Choose opens the Media picker. */
function FileBox({
	look,
	words,
	id,
	label,
	value,
	files,
	onChoose,
	onRemove,
}: {
	look: Look;
	words: Words;
	id: string;
	label: string;
	value: string | null;
	files: EntryDetails["files"];
	onChoose(): void;
	onRemove(): void;
}) {
	const said = words.details;
	const file = value ? files[value] : undefined;
	const size = look === "dock" ? "size-7 rounded-md" : "h-11 w-16 rounded-lg";
	const button = `text-chrome-text hover:bg-chrome-hover inline-flex shrink-0 items-center rounded-md border border-[#3f3f46] font-medium ${
		look === "dock" ? "h-6 px-2 text-[11px]" : "h-[34px] px-3 text-[13px]"
	} ${CHROME_EASE} ${FOCUS_RING}`;
	return (
		<fieldset className="m-0 flex min-w-0 items-center gap-2 border-0 p-0" aria-labelledby={`${id}-label`}>
			{file?.thumbnail ? (
				<img src={file.thumbnail} alt="" className={`${size} shrink-0 object-cover`} />
			) : (
				<span
					aria-hidden="true"
					className={`${size} bg-chrome-hover text-chrome-muted grid shrink-0 place-items-center`}
				>
					<ImageIcon className="size-3.5" />
				</span>
			)}
			<span className="flex min-w-0 grow flex-col gap-0.5">
				<span
					className={`truncate font-medium ${value ? "text-chrome-strong" : "text-chrome-faint"} ${
						look === "dock" ? "text-[12px]" : "text-[13px]"
					}`}
				>
					{value ? (file?.name ?? "…") : said.noFile}
				</span>
				{value ? (
					<span className={`text-chrome-faint truncate ${look === "dock" ? "text-[11px]" : "text-[12px]"}`}>
						{file?.alt ? fill(said.alt, { alt: file.alt }) : said.noAlt}
					</span>
				) : null}
			</span>
			<button type="button" onClick={onChoose} aria-label={fill(said.chooseFile, { field: label })} className={button}>
				{value ? said.change : said.choose}
			</button>
			{value ? (
				<button
					type="button"
					onClick={onRemove}
					aria-label={fill(said.removeFile, { field: label })}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-grid size-6 shrink-0 place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			) : null}
		</fieldset>
	);
}

/** A link: where it goes and its words. */
function LinkBox({
	look,
	words,
	label,
	link,
	save,
	leave,
	pending,
	common,
}: {
	look: Look;
	words: Words;
	label: string;
	link: { url?: string; text?: string };
	save(next: unknown, wait?: number): void;
	leave(): void;
	pending(): boolean;
	common: Common;
}) {
	const said = words.details;
	const [typed, setTyped, focus] = useTyped({ url: link.url ?? "", text: link.text ?? "" }, pending);
	const set = (part: "url" | "text", text: string) => {
		const next = { ...typed, [part]: text };
		setTyped(next);
		save(next.url || next.text ? next : null);
	};
	const box = boxClass(look, look === "dock" ? "h-[18px]" : "h-10");
	return (
		<span className="flex flex-col gap-1">
			<input
				{...common}
				type="url"
				value={typed.url}
				placeholder={said.linkUrl}
				aria-label={fill(said.linkPart, { field: label, part: said.linkUrl })}
				onChange={(event) => set("url", event.target.value)}
				onFocus={focus.onFocus}
				onBlur={() => {
					focus.onBlur();
					leave();
				}}
				className={box}
			/>
			<input
				type="text"
				value={typed.text}
				placeholder={said.linkText}
				aria-label={fill(said.linkPart, { field: label, part: said.linkText })}
				onChange={(event) => set("text", event.target.value)}
				onFocus={focus.onFocus}
				onBlur={() => {
					focus.onBlur();
					leave();
				}}
				className={box}
			/>
		</span>
	);
}
