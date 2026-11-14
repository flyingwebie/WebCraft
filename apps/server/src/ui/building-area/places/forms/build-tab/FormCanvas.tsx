import type { FormField } from "@webcraft/renderer/forms";
import type { FormWords } from "@webcraft/renderer/forms/words";
import { EyeOffIcon, GitBranchIcon, GripVerticalIcon, PlusIcon } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";

import { fill, type Words } from "../../../api.ts";
import { type FieldWidth, WIDTH_SHARES } from "./layout.ts";

/**
 * What the Build tab draws on the sheet (BA-26, SPEC 15.2, `forms-builder/01` to `03` and `06`): the
 * step's items as the Site renders them (`renderForm`'s elements and its classes, so the Site's
 * styles apply as on its pages), with the builder's marks: the field chosen outlined in indigo with
 * its grip at its start and its width handle at its end, a "+" in the gap below a field under the
 * pointer, a chip naming a field's rule ("Shown when Cake is Wedding cake"), and a hidden field as a
 * slim dashed row seen only here.
 *
 * The items are one listbox for the keyboard (`role="option"` on a layer over each, which also takes
 * the pointer): one Tab stop, the arrows choose; focus alone chooses nothing, so the panel beside
 * changes only when asked. What visitors would fill in is inert here, so nothing of it is a stop.
 */

/** What an item is called on the canvas and to screen readers. */
export type Naming = {
	/** A field's kind, in the place's words ("Dropdown"). */
	kind(field: FormField): string;
	/** The chip of a field with a rule, or null. */
	rule(field: FormField): string | null;
	/** Where a hidden field's value comes from, in words. */
	source(field: FormField): string;
};

export type CanvasState = {
	fields: readonly FormField[];
	/** The indexes of the items the step shows. */
	shown: readonly number[];
	/** Whether the Form's button shows below them (no steps, or the last one). */
	lastStep: boolean;
	submitLabel: string;
	formWords: FormWords;
	selected: number | null;
	/** The item picked up (Space) or being dragged: drawn faint. */
	lifted: number | null;
	/** Items with a problem the server answered. */
	problems: ReadonlySet<number>;
	/** A width being dragged, shown before it is let go, with its readout. */
	widthPreview: { index: number; width: FieldWidth } | null;
	dragging: boolean;
};

export type CanvasActions = {
	select(index: number): void;
	key(event: KeyboardEvent<HTMLElement>, index: number): void;
	grip(event: PointerEvent<HTMLElement>, index: number): void;
	width(event: PointerEvent<HTMLElement>, index: number): void;
	/** The "+" below an item: add a field after it. */
	addAfter(index: number): void;
};

/** Every item's id on the sheet starts here (ids are the shadow root's own). */
const ID = "wcb";

export function FormCanvas({
	words,
	state,
	naming,
	on,
	listLabel,
}: {
	words: Words;
	state: CanvasState;
	naming: Naming;
	on: CanvasActions;
	listLabel: string;
}) {
	const { fields, shown, selected } = state;
	const shownSet = new Set(shown);
	const focusable = selected !== null && shownSet.has(selected) ? selected : (shown[0] ?? null);

	/** The marks and the layer over an item (its option), after its content. */
	const marks = (index: number, field: FormField, layout: boolean) => {
		const name = optionName(words, naming, field);
		return (
			<>
				<div
					role="option"
					aria-selected={selected === index}
					aria-label={name}
					tabIndex={index === focusable ? 0 : -1}
					data-wcb-hit=""
					onClick={() => on.select(index)}
					onKeyDown={(event) => on.key(event, index)}
				/>
				<span aria-hidden="true" data-wcb-grip="" onPointerDown={(event) => on.grip(event, index)}>
					<GripVerticalIcon width={12} height={12} />
				</span>
				{layout || field.type === "hidden" ? null : (
					<span aria-hidden="true" data-wcb-width="" onPointerDown={(event) => on.width(event, index)} />
				)}
				{state.widthPreview?.index === index ? (
					<span aria-hidden="true" data-wcb-readout="">
						{`${Math.round(WIDTH_SHARES[state.widthPreview.width] * 100)}%`}
					</span>
				) : null}
				{field.type === "step" ? null : (
					<span aria-hidden="true" data-wcb-add="" onClick={() => on.addAfter(index)}>
						<span>
							<PlusIcon width={12} height={12} />
						</span>
					</span>
				)}
			</>
		);
	};

	const flags = (index: number) => ({
		"data-wcb-index": String(index),
		"data-wcb-selected": selected === index ? "" : undefined,
		"data-wcb-lifted": state.lifted === index ? "" : undefined,
		"data-wcb-problem": state.problems.has(index) && selected !== index ? "" : undefined,
	});

	const item = (index: number): ReactNode => {
		const field = fields[index];
		if (!field) return null;
		if (field.type === "hidden") {
			return (
				<div key={index} role="none" data-wcb-hidden-row="" {...flags(index)}>
					<EyeOffIcon width={14} height={14} aria-hidden="true" />
					<span inert>{`${field.label.text} · ${naming.source(field)}`}</span>
					{marks(index, field, false)}
				</div>
			);
		}
		const width =
			state.widthPreview?.index === index ? state.widthPreview.width : ((field.width as FieldWidth | null) ?? "whole");
		return (
			<FieldView
				key={index}
				field={field}
				width={width}
				chip={naming.rule(field)}
				words={state.formWords}
				attributes={flags(index)}
			>
				{marks(index, field, false)}
			</FieldView>
		);
	};

	// The step's items, sections holding the fields after them up to the next section.
	const blocks: ReactNode[] = [];
	let section: { index: number; children: ReactNode[] } | null = null;
	const close = () => {
		if (!section) return;
		const { index, children } = section;
		const field = fields[index];
		if (field) {
			blocks.push(
				<fieldset
					key={`section-${index}`}
					className="wc-form-section"
					aria-label={field.label.text}
					data-wcb-section=""
					{...flags(index)}
				>
					<legend inert className={field.hideLabel ? "wc-visually-hidden" : undefined} data-wcb-box="">
						{field.label.text}
					</legend>
					{field.help ? (
						<p inert className="wc-form-help">
							{field.help.text}
						</p>
					) : null}
					{marks(index, field, true)}
					{children}
				</fieldset>,
			);
		}
		section = null;
	};
	for (const index of shown) {
		const field = fields[index];
		if (!field) continue;
		if (field.type === "section") {
			close();
			section = { index, children: [] };
			continue;
		}
		const drawn = item(index);
		if (section) section.children.push(drawn);
		else blocks.push(drawn);
	}
	close();

	const required = shown.some((index) => fields[index]?.required);
	if (shown.length === 0) {
		return (
			<div className="wc-form" data-wcb-list="">
				<p data-wcb-empty="">{words.forms.sheet.empty}</p>
				{state.lastStep ? <Submit label={state.submitLabel} /> : null}
			</div>
		);
	}
	return (
		<div
			className="wc-form"
			role="listbox"
			aria-label={listLabel}
			aria-orientation="vertical"
			data-wcb-list=""
			data-wcb-dragging={state.dragging ? "" : undefined}
		>
			{required ? (
				<p inert className="wc-form-note">
					{state.formWords.required}
				</p>
			) : null}
			{blocks}
			{state.lastStep ? <Submit label={state.submitLabel} /> : null}
		</div>
	);
}

/** The Form's button, as visitors see it: inert on the canvas. */
function Submit({ label }: { label: string }) {
	return (
		<button type="button" inert className="wc-form-submit">
			{label}
		</button>
	);
}

/** An option's name: its label, its kind, and whether it is required or shown only under a rule. */
function optionName(words: Words, naming: Naming, field: FormField): string {
	const parts = [fill(words.forms.sheet.option, { label: field.label.text || field.key, kind: naming.kind(field) })];
	if (field.required) parts.push(words.forms.sheet.required);
	const rule = naming.rule(field);
	if (rule) parts.push(rule);
	return parts.join(", ");
}

/**
 * One field as the Site renders it (`renderField`): its wrapper with the Site's classes and its width,
 * its label, help and control. On the canvas the content is inert and `children` are the builder's
 * marks; trying the Form (`values`), it is what visitors fill in.
 */
export function FieldView({
	field,
	width,
	chip,
	words,
	attributes,
	children,
	trying,
}: {
	field: FormField;
	width: FieldWidth;
	chip?: string | null;
	words: FormWords;
	attributes?: Record<string, string | undefined>;
	children?: ReactNode;
	/** Trying the Form: the values filled in, the error shown, and how a value changes. */
	trying?: {
		values: readonly string[];
		error: string | null;
		onValue(values: string[]): void;
		onFiles(files: File[]): void;
	};
}) {
	const inert = trying ? undefined : true;
	const id = `${ID}-${field.key}`;
	const helpId = `${id}-help`;
	const errorId = `${id}-error`;
	const error = trying?.error ?? null;
	const describedBy = [field.help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
	const widthAttribute = width === "half" || width === "third" ? width : undefined;
	const value = trying?.values[0] ?? "";
	const help = field.help ? (
		<p inert={inert} className="wc-form-help" id={helpId}>
			{field.help.text}
		</p>
	) : null;
	const errorLine = error ? (
		<p className="wc-form-error" id={errorId}>
			<span className="wc-visually-hidden">{words.errorPrefix}</span> {error}
		</p>
	) : null;
	const mark = field.required ? (
		<span className="wc-form-required" aria-hidden="true">
			{" *"}
		</span>
	) : null;
	const chipped = chip ? (
		<span aria-hidden="true" data-wcb-chip="">
			<GitBranchIcon width={10} height={10} />
			{chip}
		</span>
	) : null;
	const labelClass = field.hideLabel ? "wc-form-label wc-visually-hidden" : "wc-form-label";
	const common = {
		inert,
		required: field.required || undefined,
		"aria-invalid": error ? true : undefined,
		"aria-describedby": describedBy,
	};
	const placeholder = field.placeholder?.text;
	const wrapper = {
		className: "wc-form-field",
		"data-type": field.type,
		"data-wc-width": widthAttribute,
		role: trying ? undefined : "none",
		...attributes,
	};

	if (field.type === "radio" || field.type === "checkboxes") {
		const type = field.type === "radio" ? "radio" : "checkbox";
		return (
			<fieldset {...wrapper} aria-describedby={trying ? describedBy : undefined}>
				<legend inert={inert} className={field.hideLabel ? "wc-visually-hidden" : undefined} data-wcb-box="">
					{field.label.text}
					{mark}
				</legend>
				{chipped}
				{help}
				{errorLine}
				<div inert={inert} className="wc-form-options">
					{field.options.map((option, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: options are edited in place; their values can repeat while typing.
						<div key={`${option.value}-${at}`} className="wc-form-option">
							<input
								type={type}
								id={`${id}-${at}`}
								name={field.key}
								value={option.value}
								checked={trying ? trying.values.includes(option.value) : false}
								readOnly={!trying}
								onChange={(event) => {
									if (!trying) return;
									if (type === "radio") trying.onValue([option.value]);
									else
										trying.onValue(
											event.target.checked
												? [...trying.values, option.value]
												: trying.values.filter((each) => each !== option.value),
										);
								}}
								aria-invalid={error && at === 0 ? true : undefined}
							/>
							<label htmlFor={`${id}-${at}`}>{option.label.text}</label>
						</div>
					))}
				</div>
				{children}
			</fieldset>
		);
	}

	if (field.type === "consent") {
		return (
			<div {...wrapper}>
				{chipped}
				{errorLine}
				<div inert={inert} className="wc-form-option">
					<input
						type="checkbox"
						id={id}
						name={field.key}
						value="yes"
						checked={trying ? trying.values.includes("yes") : false}
						readOnly={!trying}
						onChange={(event) => trying?.onValue(event.target.checked ? ["yes"] : [])}
						{...common}
					/>
					<label className={labelClass} htmlFor={id}>
						{field.label.text}
						{mark}
					</label>
				</div>
				{help}
				{children}
			</div>
		);
	}

	const label = (
		<label inert={inert} className={labelClass} htmlFor={id}>
			{field.label.text}
			{mark}
		</label>
	);
	let control: ReactNode;
	if (field.type === "textarea") {
		control = (
			<textarea
				id={id}
				name={field.key}
				rows={5}
				placeholder={placeholder}
				value={value}
				readOnly={!trying}
				onChange={(event) => trying?.onValue([event.target.value])}
				{...common}
			/>
		);
	} else if (field.type === "select") {
		control = (
			<select
				id={id}
				name={field.key}
				value={value}
				onChange={(event) => trying?.onValue(event.target.value === "" ? [] : [event.target.value])}
				{...common}
			>
				<option value="">{placeholder ?? words.choose}</option>
				{field.options.map((option, at) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: options are edited in place; their values can repeat while typing.
					<option key={`${option.value}-${at}`} value={option.value}>
						{option.label.text}
					</option>
				))}
			</select>
		);
	} else if (field.type === "file") {
		control = (
			<input
				type="file"
				id={id}
				name={field.key}
				multiple={(field.maxFiles ?? 1) > 1}
				onChange={(event) => trying?.onFiles([...(event.target.files ?? [])])}
				{...common}
			/>
		);
	} else {
		control = (
			<input
				type={INPUT_TYPES[field.type] ?? "text"}
				id={id}
				name={field.key}
				placeholder={placeholder}
				value={value}
				readOnly={!trying}
				min={
					field.type === "number"
						? (field.min ?? undefined)
						: field.type === "date"
							? (field.minDate ?? undefined)
							: undefined
				}
				max={
					field.type === "number"
						? (field.max ?? undefined)
						: field.type === "date"
							? (field.maxDate ?? undefined)
							: undefined
				}
				step={field.type === "number" ? (field.integer ? "1" : "any") : undefined}
				onChange={(event) => trying?.onValue([event.target.value])}
				{...common}
			/>
		);
	}
	return (
		<div {...wrapper}>
			{chipped}
			{label}
			{help}
			{errorLine}
			{control}
			{children}
		</div>
	);
}

const INPUT_TYPES: Partial<Record<FormField["type"], string>> = {
	text: "text",
	email: "email",
	phone: "tel",
	url: "url",
	number: "number",
	date: "date",
};
