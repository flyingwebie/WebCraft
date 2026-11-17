import type { FieldDefinition } from "@webcraft/core";
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, ImageIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";

import { newRowId } from "../../co-editing/values.ts";
import { imagePreview, type MediaItem } from "../../media/preview.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { boxClass, describedBy, Labelled, Switch } from "../panels/field-controls.tsx";
import { pickMedia } from "../places/media/pick.ts";
import type { MemberSections, SectionsSnapshot } from "./sections.ts";

/**
 * A section's settings (SPEC 13.3: "settings in the side panel"): its Placement's Props, each typed,
 * in the side panel's look. What is typed shows as typed while others change the page; it is saved
 * when its box is left (a choice, a switch or a photo at once), through the Page layout controller's
 * Props (the page's Entry's shared Draft). A refused change says so and shows what is saved.
 */
export function SectionSettings({
	sections,
	snapshot,
	id,
	words,
	handled,
}: {
	sections: MemberSections;
	snapshot: SectionsSnapshot;
	id: string;
	words: Words;
	/** The focus asked for so far (`SectionsPanel`): the settings take the next one. */
	handled: RefObject<number>;
}) {
	const said = words.sections;
	const [, redraw] = useState(0);
	// Its values change with every keystroke and every change from elsewhere: read on each one.
	useEffect(() => sections.subscribe(() => redraw((count) => count + 1)), [sections]);
	// Moving on (another section, the panel closing) finishes what was typed.
	useEffect(() => sections.finishWith(() => sections.finishProps(id)), [sections, id]);
	const form = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (handled.current === snapshot.focusRequest) return;
		handled.current = snapshot.focusRequest;
		form.current?.querySelector<HTMLElement>("input, textarea, select, button, [contenteditable='true']")?.focus();
	}, [snapshot.focusRequest, handled]);

	const fields = snapshot.props[id] ?? [];
	const values = sections.values(id);
	if (fields.length === 0) return <p className="text-chrome-muted m-0 text-[13px]">{said.noProps}</p>;
	const context: Context = {
		words,
		several: snapshot.language !== snapshot.defaultLanguage || false,
		language: snapshot.language,
		relationships: snapshot.relationships,
		media: (mediaId) => sections.media(mediaId),
	};
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- leaving a box finishes what was typed; the boxes are the controls.
		<div
			ref={form}
			className="flex flex-col gap-4"
			data-wc-section-settings={id}
			// A box left (for another, or elsewhere): what was typed in it is finished.
			onBlur={() => sections.finishProps(id)}
		>
			{fields.map((field) => (
				<FieldInput
					key={`${field.id ?? ""}${field.key}`}
					field={field}
					value={values[field.key] ?? null}
					context={context}
					onChange={(value, finish) => sections.prop(id, field, value, finish)}
				/>
			))}
		</div>
	);
}

type Context = {
	words: Words;
	several: boolean;
	language: string;
	relationships: SectionsSnapshot["relationships"];
	media(id: string): Promise<MediaItem | null>;
};

/** One Prop with its typed control. `finish` saves it now (a choice), else when its box is left. */
function FieldInput({
	field,
	value,
	context,
	onChange,
}: {
	field: FieldDefinition;
	value: unknown;
	context: Context;
	onChange(value: unknown, finish: boolean): void;
}) {
	const id = useId();
	const said = context.words.sections.fields;
	const label = field.label || field.key;
	const hint = field.help || null;
	const common = { id, "aria-describedby": describedBy(id, hint, null) } as const;
	switch (field.type) {
		case "text":
		case "email":
		case "number":
		case "date": {
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
			const shown = value === null || value === undefined ? "" : String(value);
			return (
				<Labelled look="client" id={id} label={label} hint={hint}>
					<input
						{...common}
						type={type}
						value={type === "datetime-local" ? shown.slice(0, 16) : shown}
						maxLength={field.type === "text" && field.maxLength ? field.maxLength : undefined}
						onChange={(event) => {
							const text = event.target.value;
							if (field.type === "number") onChange(text === "" ? null : Number(text), false);
							else if (field.type === "date") onChange(text === "" ? null : text, true);
							else onChange(text === "" ? null : text, false);
						}}
						className={boxClass("client", "h-10")}
					/>
				</Labelled>
			);
		}
		case "richText":
			return (
				<Labelled look="client" id={id} label={label} hint={hint} as="span">
					<RichBox id={id} label={label} value={typeof value === "string" ? value : ""} onChange={onChange} />
				</Labelled>
			);
		case "boolean":
			return (
				<div className="flex items-center justify-between gap-3">
					<span id={`${id}-label`} className="text-chrome-strong text-[13px] font-medium">
						{label}
					</span>
					<Switch
						look="client"
						id={id}
						on={value === true}
						labelledBy={`${id}-label`}
						onChange={(on) => onChange(on, true)}
					/>
				</div>
			);
		case "select": {
			if (field.multiple) {
				const chosen = Array.isArray(value) ? (value as string[]) : [];
				return (
					<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
						<legend className="text-chrome-strong mb-1 p-0 text-[13px] font-medium">{label}</legend>
						{field.options.map((option) => (
							<label key={option.value} className="text-chrome-text flex items-center gap-2 text-[14px]">
								<input
									type="checkbox"
									checked={chosen.includes(option.value)}
									onChange={(event) =>
										onChange(
											event.target.checked ? [...chosen, option.value] : chosen.filter((each) => each !== option.value),
											true,
										)
									}
									className={`size-4 accent-[#6366f1] ${FOCUS_RING}`}
								/>
								{option.label}
							</label>
						))}
					</fieldset>
				);
			}
			return (
				<Labelled look="client" id={id} label={label} hint={hint}>
					<select
						{...common}
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value === "" ? null : event.target.value, true)}
						className={boxClass("client", "h-10")}
					>
						<option value="">{said.none}</option>
						{field.options.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Labelled>
			);
		}
		case "relationship": {
			const entries = field.postTypes.flatMap((key) => context.relationships[key]?.entries ?? []);
			if (field.multiple) {
				const chosen = Array.isArray(value) ? (value as string[]) : [];
				return (
					<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
						<legend className="text-chrome-strong mb-1 p-0 text-[13px] font-medium">{label}</legend>
						{entries.map((entry) => (
							<label key={entry.id} className="text-chrome-text flex items-center gap-2 text-[14px]">
								<input
									type="checkbox"
									checked={chosen.includes(entry.id)}
									onChange={(event) =>
										onChange(
											event.target.checked ? [...chosen, entry.id] : chosen.filter((each) => each !== entry.id),
											true,
										)
									}
									className={`size-4 accent-[#6366f1] ${FOCUS_RING}`}
								/>
								{entry.title}
							</label>
						))}
					</fieldset>
				);
			}
			const one = Array.isArray(value) ? (value[0] as string | undefined) : typeof value === "string" ? value : "";
			return (
				<Labelled look="client" id={id} label={label} hint={hint}>
					<select
						{...common}
						value={one ?? ""}
						onChange={(event) => onChange(event.target.value === "" ? null : event.target.value, true)}
						className={boxClass("client", "h-10")}
					>
						<option value="">{said.none}</option>
						{entries.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.title}
							</option>
						))}
					</select>
				</Labelled>
			);
		}
		case "media":
			return (
				<Labelled look="client" id={id} label={label} hint={hint} as="span">
					<PhotoBox
						label={label}
						value={typeof value === "string" ? value : null}
						context={context}
						onChange={(next) => onChange(next, true)}
					/>
				</Labelled>
			);
		case "link": {
			const link =
				value && typeof value === "object" && !Array.isArray(value) ? (value as { url?: string; text?: string }) : {};
			const change = (part: "url" | "text", text: string) => {
				const next = { url: link.url ?? "", text: link.text ?? "", [part]: text };
				onChange(next.url === "" && next.text === "" ? null : next, false);
			};
			return (
				<fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-wc-section-link={field.key}>
					<legend className="text-chrome-strong mb-1 p-0 text-[13px] font-medium">{label}</legend>
					<Labelled look="client" id={`${id}-text`} label={said.words}>
						<input
							id={`${id}-text`}
							type="text"
							value={link.text ?? ""}
							onChange={(event) => change("text", event.target.value)}
							className={boxClass("client", "h-10")}
						/>
					</Labelled>
					<Labelled look="client" id={`${id}-url`} label={said.address}>
						<input
							id={`${id}-url`}
							type="text"
							inputMode="url"
							value={link.url ?? ""}
							onChange={(event) => change("url", event.target.value)}
							className={boxClass("client", "h-10")}
						/>
					</Labelled>
				</fieldset>
			);
		}
		case "group": {
			const inner =
				value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
			return (
				<fieldset
					className="m-0 flex flex-col gap-3 rounded-lg border border-[#2f2f36] p-3"
					data-wc-section-group={field.key}
				>
					<legend className="text-chrome-strong px-1 text-[13px] font-medium">{label}</legend>
					{field.fields.map((child) => (
						<FieldInput
							key={`${child.id ?? ""}${child.key}`}
							field={child}
							value={inner[child.key] ?? null}
							context={context}
							onChange={(next, finish) => onChange({ ...inner, [child.key]: next }, finish)}
						/>
					))}
				</fieldset>
			);
		}
		case "repeater":
			return (
				<Rows
					label={label}
					fields={field.fields}
					rows={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
					context={context}
					onChange={onChange}
				/>
			);
		default:
			return null;
	}
}

/** Text that takes formatting: typed in a box of its own (⌘B, ⌘I); the server keeps only what a page may hold. */
function RichBox({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	onChange(value: unknown, finish: boolean): void;
}) {
	const box = useRef<HTMLDivElement>(null);
	// What it shows follows the value, except while the person types in it.
	useEffect(() => {
		const element = box.current;
		if (!element || document.activeElement === element) return;
		if (element.innerHTML !== value) element.innerHTML = value;
	}, [value]);
	return (
		// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- rich text needs an editable element, not a textarea.
		<div
			ref={box}
			id={id}
			role="textbox"
			aria-multiline="true"
			aria-label={label}
			tabIndex={0}
			contentEditable
			suppressContentEditableWarning
			onInput={(event) => {
				const html = event.currentTarget.innerHTML;
				onChange(html === "" || html === "<br>" ? null : html, false);
			}}
			className={boxClass("client", "min-h-20 py-2 [&_p]:m-0")}
		/>
	);
}

/** A photo Prop: its picture and name, Choose (the Media picker), Remove. */
function PhotoBox({
	label,
	value,
	context,
	onChange,
}: {
	label: string;
	value: string | null;
	context: Context;
	onChange(value: string | null): void;
}) {
	const said = context.words.sections.fields;
	const [file, setFile] = useState<{ id: string; fileName: string; thumbnail: string | null } | null>(null);
	useEffect(() => {
		if (!value || file?.id === value) return;
		let current = true;
		void context.media(value).then((found) => {
			if (current && found)
				setFile({ id: value, fileName: found.fileName, thumbnail: imagePreview("", found, 112, true) });
		});
		return () => {
			current = false;
		};
	}, [value, file?.id, context]);
	const shown = value && file?.id === value ? file : null;
	return (
		<span className="flex items-center gap-3" data-wc-section-photo="">
			<span className="bg-chrome-raised grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-[#2f2f36]">
				{shown?.thumbnail ? (
					<img src={shown.thumbnail} alt="" className="size-full object-cover" />
				) : (
					<ImageIcon aria-hidden="true" className="text-chrome-faint size-5" />
				)}
			</span>
			<span className="flex min-w-0 grow flex-col gap-1.5">
				<span className="text-chrome-muted truncate text-[12px]">{shown?.fileName ?? (value ? "" : said.noPhoto)}</span>
				<span className="flex gap-2">
					<button
						type="button"
						onClick={async () => {
							const chosen = await pickMedia({ kind: "image", current: value });
							if (!chosen) return;
							setFile({ id: chosen.id, fileName: chosen.fileName, thumbnail: imagePreview("", chosen, 112, true) });
							onChange(chosen.id);
						}}
						className={`bg-chrome-hover text-chrome-strong h-8 rounded-lg px-3 text-[13px] font-medium hover:bg-[#34343b] ${CHROME_EASE} ${FOCUS_RING}`}
					>
						{fill(value ? said.changePhoto : said.choosePhoto, { label })}
					</button>
					{value ? (
						<button
							type="button"
							aria-label={fill(said.removePhoto, { label })}
							onClick={() => onChange(null)}
							className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-8 place-items-center rounded-lg ${CHROME_EASE} ${FOCUS_RING}`}
						>
							<XIcon aria-hidden="true" className="size-4" />
						</button>
					) : null}
				</span>
			</span>
		</span>
	);
}

/** A Repeater's rows: each a group of its Fields with a menu (move up, move down, remove), and Add. */
function Rows({
	label,
	fields,
	rows,
	context,
	onChange,
}: {
	label: string;
	fields: FieldDefinition[];
	rows: Record<string, unknown>[];
	context: Context;
	onChange(value: unknown, finish: boolean): void;
}) {
	const said = context.words.sections.fields;
	const [menu, setMenu] = useState<string | null>(null);
	const heading = useId();
	const move = (from: number, to: number) => {
		const next = [...rows];
		const [row] = next.splice(from, 1);
		if (!row) return;
		next.splice(to, 0, row);
		onChange(next, true);
	};
	return (
		<section aria-labelledby={heading} className="flex flex-col gap-2" data-wc-section-rows="">
			<h3 id={heading} className="text-chrome-strong m-0 text-[13px] font-medium">
				{label}
			</h3>
			{rows.length === 0 ? <p className="text-chrome-muted m-0 text-[13px]">{said.emptyRows}</p> : null}
			{rows.map((row, index) => {
				const rowId = typeof row.id === "string" ? row.id : String(index);
				const name = fill(said.row, { number: String(index + 1) });
				return (
					<fieldset
						key={rowId}
						className="m-0 flex flex-col gap-3 rounded-lg border border-[#2f2f36] p-3"
						data-wc-section-row-of={rowId}
					>
						<legend className="flex w-full items-center gap-2 px-1">
							<span className="text-chrome-muted grow text-[12px] font-semibold">{name}</span>
							<RowMenu
								label={fill(said.rowActions, { number: String(index + 1) })}
								open={menu === rowId}
								onOpen={(open) => setMenu(open ? rowId : null)}
								words={context.words}
								first={index === 0}
								last={index === rows.length - 1}
								onMove={(step) => move(index, index + step)}
								onRemove={() =>
									onChange(
										rows.filter((_, at) => at !== index),
										true,
									)
								}
							/>
						</legend>
						{fields.map((child) => (
							<FieldInput
								key={`${child.id ?? ""}${child.key}`}
								field={child}
								value={row[child.key] ?? null}
								context={context}
								onChange={(next, finish) =>
									onChange(
										rows.map((each, at) => (at === index ? { ...each, [child.key]: next } : each)),
										finish,
									)
								}
							/>
						))}
					</fieldset>
				);
			})}
			<button
				type="button"
				onClick={() => {
					const empty: Record<string, unknown> = { id: newRowId() };
					for (const child of fields) empty[child.key] = null;
					onChange([...rows, empty], true);
				}}
				className={`border-chrome-line text-chrome-text hover:bg-chrome-hover flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed text-[13px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
			>
				<PlusIcon aria-hidden="true" className="size-3.5" />
				{fill(said.addRow, { label })}
			</button>
		</section>
	);
}

function RowMenu({
	label,
	open,
	onOpen,
	words,
	first,
	last,
	onMove,
	onRemove,
}: {
	label: string;
	open: boolean;
	onOpen(open: boolean): void;
	words: Words;
	first: boolean;
	last: boolean;
	onMove(step: number): void;
	onRemove(): void;
}) {
	const said = words.sections.fields;
	const button = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();
	useEffect(() => {
		if (!open) return;
		list.current?.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (list.current?.contains(target) || button.current?.contains(target))) return;
			onOpen(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open, onOpen]);
	const items: { key: string; label: string; icon: typeof ArrowUpIcon; off: boolean; run(): void }[] = [
		{ key: "up", label: said.rowUp, icon: ArrowUpIcon, off: first, run: () => onMove(-1) },
		{ key: "down", label: said.rowDown, icon: ArrowDownIcon, off: last, run: () => onMove(1) },
		{ key: "remove", label: said.removeRow, icon: Trash2Icon, off: false, run: onRemove },
	];
	return (
		<span className="relative">
			<button
				ref={button}
				type="button"
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => onOpen(!open)}
				className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-7 place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
			>
				<EllipsisIcon aria-hidden="true" className="size-4" />
			</button>
			{open ? (
				<MenuList
					id={id}
					label={label}
					refTo={list}
					onClose={(focus) => {
						onOpen(false);
						if (focus) button.current?.focus();
					}}
				>
					{items.map((item) => (
						<MenuItem
							key={item.key}
							icon={item.icon}
							label={item.label}
							off={item.off}
							danger={item.key === "remove"}
							onRun={() => {
								onOpen(false);
								button.current?.focus();
								item.run();
							}}
						/>
					))}
				</MenuList>
			) : null}
		</span>
	);
}

/** A menu of the side panel (`client/06`): its items with the keys menus have. */
export function MenuList({
	id,
	label,
	refTo,
	onClose,
	children,
	className = "end-0 top-[calc(100%+4px)]",
	fixed,
}: {
	id: string;
	label: string;
	refTo: RefObject<HTMLDivElement | null>;
	onClose(focusButton: boolean): void;
	children: ReactNode;
	className?: string;
	/** Placed on the window (out of a panel that would clip it): its top and end. */
	fixed?: { top: number; right: number } | null;
}) {
	return (
		<div
			ref={refTo}
			id={id}
			role="menu"
			aria-label={label}
			tabIndex={-1}
			onKeyDown={(event) => {
				const all = [...(refTo.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
				const at = all.indexOf(document.activeElement as HTMLElement);
				const go = (index: number) => all[(index + all.length) % all.length]?.focus();
				switch (event.key) {
					case "ArrowDown":
						go(at + 1);
						break;
					case "ArrowUp":
						go(at - 1);
						break;
					case "Home":
						go(0);
						break;
					case "End":
						go(all.length - 1);
						break;
					case "Escape":
						onClose(true);
						break;
					case "Tab":
						onClose(false);
						return;
					default:
						return;
				}
				event.preventDefault();
				event.stopPropagation();
			}}
			className={`border-chrome-hover bg-chrome-menu z-50 flex w-[196px] flex-col gap-0.5 rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)] ${
				fixed ? "fixed" : `absolute ${className}`
			}`}
			style={fixed ? { top: fixed.top, right: fixed.right } : undefined}
		>
			{children}
		</div>
	);
}

export function MenuItem({
	icon: Glyph,
	label,
	off,
	danger,
	onRun,
	separated,
}: {
	icon: typeof ArrowUpIcon;
	label: string;
	off: boolean;
	danger?: boolean;
	onRun(): void;
	separated?: boolean;
}) {
	return (
		<>
			{separated ? <span aria-hidden="true" className="my-1 h-px bg-[#2a2a30]" /> : null}
			<button
				type="button"
				role="menuitem"
				tabIndex={-1}
				aria-disabled={off ? true : undefined}
				onClick={() => {
					if (!off) onRun();
				}}
				className={`flex h-[30px] items-center gap-2 rounded-md px-2 text-start text-[13px] ${
					off
						? "text-chrome-faint cursor-default"
						: danger
							? "text-chrome-danger hover:bg-chrome-hover focus:bg-chrome-hover"
							: "text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover"
				} ${FOCUS_RING}`}
				data-wc-menu-item=""
			>
				<Glyph aria-hidden="true" className="size-3.5 shrink-0" />
				{label}
			</button>
		</>
	);
}
