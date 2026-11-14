import type { BuildingAreaApiClient } from "@webcraft/api";
import type { FieldDefinition, Json } from "@webcraft/core";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../controls.tsx";
import { codeOf, type LoopRow, reasonText } from "./data.ts";
import { SectionLabel, Select } from "./parts.tsx";

/** How long after the last key a typed value is saved. */
const SAVE_AFTER_MS = 800;
/** How long a remove button waits for its second press (SPEC 10: small things take a second click). */
const CONFIRM_MS = 4000;

type Item = Record<string, Json> & { id: string };

/** The Field types a cell changes in place; the others are changed in the admin. */
const IN_PLACE = new Set(["text", "email", "number", "boolean", "select", "date"]);

function inPlace(field: FieldDefinition): boolean {
	return IN_PLACE.has(field.type) && !(field.type === "select" && field.multiple);
}

/** A new item: an id the server keeps, and each Field's default (or nothing). */
function newItem(fields: readonly FieldDefinition[]): Item {
	return {
		id: crypto.randomUUID(),
		...Object.fromEntries(
			fields.map((field) => [field.key, field.default ?? (field.type === "boolean" ? false : null)]),
		),
	};
}

/** A value the grid shows but doesn't change, on one line. */
function summary(value: Json): string {
	if (value === null) return "—";
	if (typeof value !== "object") return String(value);
	if (Array.isArray(value)) return `[${value.length}]`;
	return Object.values(value)
		.filter((each) => typeof each === "string")
		.join(" · ");
}

/**
 * A Loop of its own items as a grid (SPEC 8: "a grid for a Loop with its own items"): one row per Loop
 * item in order, one column per Field. Text, numbers, true/false, a single choice and days change in
 * their cell; other values show and are changed in the admin, as are the Fields themselves. Items are
 * added, moved up and down and removed (a second press). Every change saves the whole list in the
 * Default language (`loops.saveItems`, Content: what clients change too), typing 0.8 s after the last key.
 */
export function ItemsGrid({
	words,
	api,
	siteId,
	loop,
	admin,
	onSaved,
	onSaving,
	announce,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	loop: LoopRow;
	/** This Loop in the admin. */
	admin: string;
	onSaved(loop: LoopRow): void;
	onSaving(status: "saving" | "saved" | "failed"): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.loops;
	const fields = loop.draft.fields as FieldDefinition[];
	const [items, setItems] = useState<Item[]>(loop.draft.items as Item[]);
	const [failure, setFailure] = useState<string | null>(null);
	const [arming, setArming] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const waiting = useRef<Item[] | null>(null);
	const running = useRef(false);
	const latest = useRef({ onSaved, onSaving, loop });
	latest.current = { onSaved, onSaving, loop };

	// Another Loop opened: its items.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the Loop changes, not after each save.
	useEffect(() => setItems(loop.draft.items as Item[]), [loop.id]);

	const send = async () => {
		if (running.current) return;
		running.current = true;
		while (waiting.current) {
			const next = waiting.current;
			waiting.current = null;
			latest.current.onSaving("saving");
			try {
				const { loop: saved } = await api.loops.saveItems({ siteId, loopId: latest.current.loop.id, items: next });
				latest.current.onSaved(saved as LoopRow);
				latest.current.onSaving("saved");
				setFailure(null);
			} catch (error) {
				latest.current.onSaving("failed");
				setFailure(fill(shown.saveFailed, { reason: reasonText(words, error) }));
				if (codeOf(error) === "network") break;
			}
		}
		running.current = false;
	};
	const flush = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		void send();
	};
	// What waits is saved when the grid goes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `flush` reads only refs.
	useEffect(() => () => flush(), []);

	const change = (next: Item[], typed = false) => {
		setItems(next);
		waiting.current = next;
		if (typed) {
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(flush, SAVE_AFTER_MS);
		} else flush();
	};
	const setValue = (index: number, key: string, value: Json, typed = false) =>
		change(
			items.map((item, at) => (at === index ? { ...item, [key]: value } : item)),
			typed,
		);
	const move = (index: number, by: -1 | 1) => {
		const to = index + by;
		if (to < 0 || to >= items.length) return;
		const next = [...items];
		const [moved] = next.splice(index, 1);
		if (moved) next.splice(to, 0, moved);
		change(next);
	};
	const problemAt = (index: number, key: string) =>
		loop.problems.some((problem) => problem.at === `items[${index}].${key}`);

	return (
		<section aria-labelledby="wc-loop-items" className="flex min-h-0 flex-col gap-3" data-wc-loop-items="">
			<div className="flex items-center gap-2">
				<SectionLabel id="wc-loop-items">{shown.items}</SectionLabel>
				<a
					href={admin}
					target="_blank"
					rel="noopener noreferrer"
					className={`text-chrome-accent ms-auto rounded-sm text-[11px] font-medium underline-offset-2 hover:underline ${FOCUS_RING}`}
				>
					{shown.fieldsInAdmin}
				</a>
			</div>
			<p className="text-chrome-muted m-0 text-[12px]">{shown.itemsHelp}</p>
			{fields.length === 0 ? (
				<p className="border-chrome-hover text-chrome-muted m-0 rounded-md border border-dashed p-6 text-center text-[12px]">
					{shown.noFields}
				</p>
			) : (
				<div className="min-h-0 overflow-auto">
					<table className="w-full border-separate border-spacing-0 text-[12px]">
						<thead>
							<tr>
								<th scope="col" className="text-chrome-muted w-8 px-1 pb-1.5 text-start text-[11px] font-medium">
									#
								</th>
								{fields.map((field) => (
									<th
										key={field.key}
										scope="col"
										className="text-chrome-muted px-1 pb-1.5 text-start text-[11px] font-medium"
									>
										{field.label}
									</th>
								))}
								<th scope="col" className="w-[96px]">
									<span className="sr-only">{shown.items}</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{items.map((item, index) => {
								const number = String(index + 1);
								const armed = arming === item.id;
								return (
									<tr key={item.id} data-wc-loop-item={number}>
										<td className="text-chrome-muted px-1 py-0.5 font-mono text-[11px]">{number}</td>
										{fields.map((field) => (
											<td key={field.key} className="px-1 py-0.5">
												<Cell
													field={field}
													label={fill(shown.itemCell, { field: field.label, number })}
													value={item[field.key] ?? null}
													invalid={problemAt(index, field.key)}
													inAdmin={shown.valueInAdmin}
													onChange={(value, typed) => setValue(index, field.key, value, typed)}
													onBlur={flush}
												/>
											</td>
										))}
										<td className="px-1 py-0.5">
											<span className="flex items-center justify-end gap-0.5">
												<SmallButton
													label={fill(shown.moveUp, { number })}
													icon="up"
													disabled={index === 0}
													onClick={() => move(index, -1)}
												/>
												<SmallButton
													label={fill(shown.moveDown, { number })}
													icon="down"
													disabled={index === items.length - 1}
													onClick={() => move(index, 1)}
												/>
												<SmallButton
													label={fill(armed ? shown.removeAgain : shown.removeItem, { number })}
													icon="remove"
													armed={armed}
													onClick={() => {
														if (!armed) {
															setArming(item.id);
															setTimeout(() => setArming((was) => (was === item.id ? null : was)), CONFIRM_MS);
															return;
														}
														setArming(null);
														change(items.filter((each) => each.id !== item.id));
														announce(fill(shown.removeItem, { number }));
													}}
												/>
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{fields.length > 0 ? (
				<span>
					<button
						type="button"
						onClick={() => change([...items, newItem(fields)])}
						className={`text-chrome-muted hover:text-chrome-strong inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-loop-add-item=""
					>
						<PlusIcon aria-hidden="true" className="size-3.5" />
						{shown.addItem}
					</button>
				</span>
			) : null}
			{failure ? (
				<p role="alert" className="text-chrome-danger m-0 text-[11px]">
					{failure}
				</p>
			) : null}
		</section>
	);
}

/** One cell: the value changed in place, or shown with where it is changed. */
function Cell({
	field,
	label,
	value,
	invalid,
	inAdmin,
	onChange,
	onBlur,
}: {
	field: FieldDefinition;
	label: string;
	value: Json;
	invalid: boolean;
	inAdmin: string;
	onChange(value: Json, typed?: boolean): void;
	onBlur(): void;
}) {
	const look = `bg-chrome text-chrome-text h-[30px] w-full min-w-24 rounded-md border px-2 text-[12px] ${
		invalid ? "border-chrome-danger" : "border-chrome-hover"
	} ${FOCUS_RING}`;
	const common = { "aria-label": label, "aria-invalid": invalid || undefined };
	if (!inPlace(field)) {
		return (
			<span className="text-chrome-muted block max-w-56 truncate px-2 text-[12px]" title={inAdmin}>
				{summary(value)}
				<span className="sr-only">{` · ${inAdmin}`}</span>
			</span>
		);
	}
	if (field.type === "boolean") {
		return (
			<input
				{...common}
				type="checkbox"
				checked={value === true}
				onChange={(event) => onChange(event.target.checked)}
				className={`accent-primary size-4 ${FOCUS_RING}`}
			/>
		);
	}
	if (field.type === "select") {
		return (
			<Select
				{...common}
				value={typeof value === "string" ? value : ""}
				onChange={(event) => onChange(event.target.value || null)}
			>
				<option value="">—</option>
				{field.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		);
	}
	if (field.type === "date") {
		return (
			<input
				{...common}
				type="date"
				value={typeof value === "string" ? value.slice(0, 10) : ""}
				onChange={(event) => onChange(event.target.value || null)}
				className={`${look} [color-scheme:dark]`}
			/>
		);
	}
	const numeric = field.type === "number";
	return (
		<input
			{...common}
			type="text"
			inputMode={numeric ? "decimal" : undefined}
			value={value === null ? "" : String(value)}
			onChange={(event) => {
				const text = event.target.value;
				if (!numeric) return onChange(text === "" ? null : text, true);
				const number = Number(text.trim());
				onChange(text.trim() === "" || Number.isNaN(number) ? null : number, true);
			}}
			onBlur={onBlur}
			className={`${look} ${numeric ? "font-mono" : ""}`}
		/>
	);
}

/** A 24 px icon button of a row (move up, move down, remove), its name as a tooltip. */
function SmallButton({
	label,
	icon,
	disabled,
	armed,
	onClick,
}: {
	label: string;
	icon: "up" | "down" | "remove";
	disabled?: boolean;
	armed?: boolean;
	onClick(): void;
}) {
	const Glyph = icon === "up" ? ArrowUpIcon : icon === "down" ? ArrowDownIcon : Trash2Icon;
	return (
		<span className="group relative inline-flex">
			<button
				type="button"
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
				className={`inline-grid size-6 place-items-center rounded-[5px] disabled:opacity-30 ${
					armed
						? "bg-chrome-danger/20 text-chrome-danger"
						: icon === "remove"
							? "text-chrome-danger"
							: "text-chrome-muted"
				} hover:bg-chrome-hover hover:text-chrome-strong disabled:hover:bg-transparent ${CHROME_EASE} ${FOCUS_RING}`}
			>
				<Glyph aria-hidden="true" className="size-3.5" />
			</button>
			<Tip label={label} side="bottom" align="end" />
		</span>
	);
}
