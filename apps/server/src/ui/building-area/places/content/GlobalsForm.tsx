import type { BuildingAreaApiClient } from "@webcraft/api";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { FOCUS_RING } from "../../controls.tsx";
import { type GlobalsData, reasonOf } from "./data.ts";

type Field = GlobalsData["fields"][number];
type Json = GlobalsData["draft"][string];
type Values = Record<string, Json>;

/** How long after the last key a value is saved (as Edit mode saves text). */
const SAVE_AFTER_MS = 800;

/** The Field kinds the form changes in place; every other kind is changed in the admin. */
const IN_PLACE = new Set(["text", "email", "number", "boolean", "date", "select", "link"]);

/** A Group's values (by key). */
function groupOf(value: Json | undefined): Values {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {};
}

/** A value as one line of text, for a Field the form doesn't change. */
function summary(words: Words, field: Field, value: Json | undefined): string {
	const none = words.content.globalsForm.none;
	if (value === null || value === undefined || value === "") return none;
	if (Array.isArray(value)) return value.length ? String(value.length) : none;
	if (typeof value === "object") return "…";
	if (field.type === "richText")
		return (
			String(value)
				.replace(/<[^>]*>/g, " ")
				.replace(/\s+/g, " ")
				.trim() || none
		);
	return String(value);
}

const FIELD =
	"bg-chrome-raised text-chrome-strong placeholder:text-chrome-muted border-chrome-hover h-8 w-full rounded-md border px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-chrome-focus";

/**
 * The Globals as a form in the Content place (SPEC 8 and 13.6): each Field with its label and help,
 * its Draft value changed in place and saved 0.8 s after typing stops and when the field is left
 * (`globals.saveDraft`, which Members may call as Staff do). Groups show as sections; Fields of a kind
 * the place doesn't change yet (rich text, Media, Repeaters) show their value and link to the admin.
 * `group` limits the form to one Group (a Member's "Site details" row).
 */
export function GlobalsForm({
	words,
	api,
	siteId,
	globals,
	group,
	title,
	admin,
	onSaved,
	onSaving,
	announce,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	globals: GlobalsData;
	group: string | null;
	title: string;
	/** The Globals in the admin. */
	admin: string;
	onSaved(globals: GlobalsData): void;
	onSaving(status: "saving" | "saved" | "failed"): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.content.globalsForm;
	const [values, setValues] = useState<Values>(() => ({ ...globals.draft }));
	const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const latest = useRef(values);
	latest.current = values;

	const save = async (key: string) => {
		pending.current.delete(key);
		onSaving("saving");
		try {
			const { globals: saved } = await api.globals.saveDraft({
				siteId,
				fields: { [key]: latest.current[key] ?? null },
			});
			onSaved(saved);
			onSaving("saved");
		} catch (error) {
			onSaving("failed");
			const field = globals.fields.find((each) => each.key === key);
			announce(fill(shown.saveFailed, { field: field?.label ?? key, reason: reasonOf(error) }), true);
		}
	};

	const saveNow = useRef(save);
	saveNow.current = save;

	// Whatever waits to be saved is saved when the form goes (leaving the place, another row).
	useEffect(() => {
		const waiting = pending.current;
		return () => {
			for (const [key, timer] of waiting) {
				clearTimeout(timer);
				void saveNow.current(key);
			}
			waiting.clear();
		};
	}, []);

	/** A top-level value changed: saved after a pause, or at once (`now`: a switch, a choice, leaving). */
	const change = (key: string, value: Json, now = false) => {
		setValues((was) => ({ ...was, [key]: value }));
		latest.current = { ...latest.current, [key]: value };
		const timer = pending.current.get(key);
		if (timer) clearTimeout(timer);
		if (now) void save(key);
		else
			pending.current.set(
				key,
				setTimeout(() => void save(key), SAVE_AFTER_MS),
			);
	};

	/** Leaving a field saves what waits for it. */
	const leave = (key: string) => {
		const timer = pending.current.get(key);
		if (!timer) return;
		clearTimeout(timer);
		void save(key);
	};

	const fields = group ? globals.fields.filter((field) => field.key === group) : globals.fields;
	return (
		<div className="flex max-w-[640px] min-w-0 flex-col gap-5 p-5" data-wc-globals={group ?? ""}>
			<div className="flex flex-col gap-1">
				<h2 className="text-chrome-strong m-0 text-[16px] font-semibold">{title}</h2>
				<p className="text-chrome-muted m-0 text-[12px]">{shown.intro}</p>
			</div>
			{fields.length === 0 ? (
				<p className="text-chrome-muted m-0 text-[12px]">{shown.empty}</p>
			) : (
				fields.map((field) =>
					field.type === "group" ? (
						<fieldset
							key={field.key}
							className="border-chrome-line m-0 flex min-w-0 flex-col gap-4 rounded-lg border p-4"
							data-wc-global-group={field.key}
						>
							<legend className="text-chrome-strong px-1 text-[13px] font-semibold">{field.label}</legend>
							{field.help ? <p className="text-chrome-muted m-0 -mt-2 text-[12px]">{field.help}</p> : null}
							{field.fields.map((inner) => (
								<Control
									key={inner.key}
									words={words}
									field={inner}
									value={groupOf(values[field.key])[inner.key]}
									admin={admin}
									onChange={(value, now) =>
										change(field.key, { ...groupOf(values[field.key]), [inner.key]: value }, now)
									}
									onLeave={() => leave(field.key)}
								/>
							))}
						</fieldset>
					) : (
						<Control
							key={field.key}
							words={words}
							field={field}
							value={values[field.key]}
							admin={admin}
							onChange={(value, now) => change(field.key, value, now)}
							onLeave={() => leave(field.key)}
						/>
					),
				)
			)}
		</div>
	);
}

/** One Field: its label, its control (or its value and a link to the admin), its help. */
function Control({
	words,
	field,
	value,
	admin,
	onChange,
	onLeave,
}: {
	words: Words;
	field: Field;
	value: Json | undefined;
	admin: string;
	onChange(value: Json, now?: boolean): void;
	onLeave(): void;
}) {
	const shown = words.content.globalsForm;
	const id = useId();
	const help = field.help ? `${id}-help` : undefined;
	const label = (
		<label htmlFor={id} className="text-chrome-text text-[12px] font-medium">
			{field.label}
			{field.required ? <span className="text-chrome-muted font-normal"> · {shown.required}</span> : null}
		</label>
	);
	let control: ReactNode;
	if (!IN_PLACE.has(field.type)) {
		return (
			<div className="flex flex-col gap-1.5" data-wc-global={field.key}>
				<span className="text-chrome-text text-[12px] font-medium">{field.label}</span>
				<p className="text-chrome-muted m-0 truncate text-[12px]">{summary(words, field, value)}</p>
				<p className="text-chrome-muted m-0 text-[11px]">
					{shown.notHere} ·{" "}
					<a
						href={admin}
						target="_blank"
						rel="noopener noreferrer"
						className={`text-chrome-accent rounded-sm hover:underline ${FOCUS_RING}`}
					>
						{shown.editInAdmin}
					</a>
				</p>
			</div>
		);
	}
	switch (field.type) {
		case "boolean":
			control = (
				<label className="text-chrome-text flex items-center gap-2 text-[12px]">
					<input
						id={id}
						type="checkbox"
						checked={value === true}
						onChange={(event) => onChange(event.target.checked, true)}
						aria-describedby={help}
						className="accent-primary size-4"
					/>
					{field.label}
				</label>
			);
			return (
				<div className="flex flex-col gap-1.5" data-wc-global={field.key}>
					{control}
					{field.help ? (
						<p id={help} className="text-chrome-muted m-0 text-[11px]">
							{field.help}
						</p>
					) : null}
				</div>
			);
		case "select":
			control = field.multiple ? (
				<select
					id={id}
					multiple
					value={Array.isArray(value) ? (value as string[]) : []}
					onChange={(event) =>
						onChange(
							[...event.target.selectedOptions].map((option) => option.value),
							true,
						)
					}
					aria-describedby={help}
					className={`${FIELD} h-auto py-1`}
				>
					{field.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			) : (
				<select
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value || null, true)}
					aria-describedby={help}
					className={FIELD}
				>
					<option value="">{shown.none}</option>
					{field.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			);
			break;
		case "link": {
			const link =
				value && typeof value === "object" && !Array.isArray(value) ? (value as { url?: string; text?: string }) : {};
			const set = (part: "url" | "text", text: string) => {
				const next = { url: link.url ?? "", text: link.text ?? "", [part]: text };
				onChange(next.url || next.text ? next : null);
			};
			control = (
				<div className="grid grid-cols-2 gap-2">
					<input
						id={id}
						type="url"
						value={link.url ?? ""}
						placeholder={shown.linkUrl}
						aria-label={`${field.label}: ${shown.linkUrl}`}
						onChange={(event) => set("url", event.target.value)}
						onBlur={onLeave}
						aria-describedby={help}
						className={FIELD}
					/>
					<input
						type="text"
						value={link.text ?? ""}
						placeholder={shown.linkText}
						aria-label={`${field.label}: ${shown.linkText}`}
						onChange={(event) => set("text", event.target.value)}
						onBlur={onLeave}
						className={FIELD}
					/>
				</div>
			);
			break;
		}
		case "number":
			control = (
				<input
					id={id}
					type="number"
					value={typeof value === "number" ? String(value) : ""}
					step={field.integer ? 1 : "any"}
					min={field.min ?? undefined}
					max={field.max ?? undefined}
					onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
					onBlur={onLeave}
					aria-describedby={help}
					className={FIELD}
				/>
			);
			break;
		case "date":
			control = (
				<input
					id={id}
					type={field.mode === "time" ? "time" : field.mode === "dateTime" ? "datetime-local" : "date"}
					value={typeof value === "string" ? value.slice(0, field.mode === "dateTime" ? 16 : undefined) : ""}
					onChange={(event) => onChange(event.target.value || null, true)}
					aria-describedby={help}
					className={`${FIELD} [color-scheme:dark]`}
				/>
			);
			break;
		default:
			control = (
				<input
					id={id}
					type={field.type === "email" ? "email" : "text"}
					value={typeof value === "string" ? value : ""}
					maxLength={field.type === "text" ? (field.maxLength ?? undefined) : undefined}
					onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
					onBlur={onLeave}
					aria-describedby={help}
					className={FIELD}
				/>
			);
	}
	return (
		<div className="flex flex-col gap-1.5" data-wc-global={field.key}>
			{label}
			{control}
			{field.help ? (
				<p id={help} className="text-chrome-muted m-0 text-[11px]">
					{field.help}
				</p>
			) : null}
		</div>
	);
}
