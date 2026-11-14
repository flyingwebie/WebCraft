import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../../api.ts";
import { FOCUS_RING } from "../../../controls.tsx";
import type { PostTypeRow } from "../../../management.ts";
import { buttonLook, PlaceIconButton } from "../ui.tsx";
import { BARE_INPUT, Card, Locked, NumberSetting, Switch, TextSetting } from "./controls.tsx";
import { dangerLook } from "./DeleteDialog.tsx";
import type { FieldDefinition } from "./fields.ts";
import { traitsOf } from "./fields.ts";

/** A change to one Field's settings. */
export type FieldChange = (field: FieldDefinition) => FieldDefinition;

/** How long the second click of Delete Field is waited for (SPEC 10: a small thing, a second click). */
const CONFIRM_MS = 4000;

/**
 * The details panel of the Field chosen in the list (SPEC 8, `places-content/03`): its name and kind
 * at the top, then Label, Key (locked: Templates read the Field by it), Kind (locked: a Field keeps
 * it), the kind's own settings, Required, Translatable and Help text, each on its card, and Delete
 * Field at the foot. Text saves when it is left or 0.8 s after typing stops; switches and choices at
 * once. Delete Field takes a second click.
 */
export function FieldDetails({
	words,
	field,
	path,
	postTypes,
	admin,
	problems,
	canAddInside,
	onChange,
	onAddInside,
	onDelete,
}: {
	words: Words;
	field: FieldDefinition;
	path: string;
	/** The Site's Post Types, which a Relationship may point at. */
	postTypes: readonly PostTypeRow[];
	/** This Post Type in the admin, for what the place doesn't set (a Body field's Blocks). */
	admin: string;
	/** Problems the last save had with this Field's settings, by setting (`label`, `options[1].value`). */
	problems: ReadonlyMap<string, string>;
	canAddInside: boolean;
	onChange(change: FieldChange): void;
	onAddInside(): void;
	onDelete(): void;
}) {
	const shown = words.postTypes.fields;
	const kind = shown.kinds[field.type];
	const traits = traitsOf(field.type);
	const id = useId();
	const [confirming, setConfirming] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const problem = (setting: string) => problems.get(setting) ?? null;
	const set = <Key extends string>(key: Key, value: unknown) =>
		onChange((current) => ({ ...current, [key]: value }) as FieldDefinition);

	const remove = () => {
		if (!confirming) {
			setConfirming(true);
			timer.current = setTimeout(() => setConfirming(false), CONFIRM_MS);
			return;
		}
		if (timer.current) clearTimeout(timer.current);
		setConfirming(false);
		onDelete();
	};

	return (
		<section
			aria-labelledby={`${id}-heading`}
			className="flex min-h-full flex-col gap-2.5"
			data-wc-field-details={path}
		>
			<div className="flex flex-col gap-0.5">
				<h3 id={`${id}-heading`} className="text-chrome-strong m-0 truncate text-[14px] font-semibold">
					{field.label || field.key}
				</h3>
				<p className="text-chrome-muted m-0 text-[12px]">{fill(shown.kindField, { kind })}</p>
			</div>

			<Card label={shown.label} htmlFor={`${id}-label`} problem={problem("label")}>
				<TextSetting
					id={`${id}-label`}
					value={field.label}
					maxLength={200}
					invalid={problem("label") !== null}
					onSave={(text) => set("label", text)}
					data={{ "data-wc-field-setting": "label" }}
				/>
			</Card>
			<Card label={shown.key} problem={problem("key")}>
				<Locked value={field.key} why={shown.keyLocked} mono />
			</Card>
			<Card label={shown.kind}>
				<Locked value={kind} why={shown.kindLocked} />
			</Card>

			<KindSettings
				words={words}
				field={field}
				id={id}
				postTypes={postTypes}
				admin={admin}
				problem={problem}
				set={set}
				onChange={onChange}
			/>

			{traits.requirable || traits.translatable ? (
				<div className="flex gap-2.5">
					{traits.requirable ? (
						<Card label={shown.required} htmlFor={`${id}-required`} grow problem={problem("required")}>
							<Switch
								id={`${id}-required`}
								checked={field.required}
								words={shown}
								onChange={(checked) => set("required", checked)}
							/>
						</Card>
					) : null}
					{traits.translatable ? (
						<Card
							label={shown.translatableSetting}
							htmlFor={`${id}-translatable`}
							grow
							problem={problem("translatable")}
						>
							<Switch
								id={`${id}-translatable`}
								checked={field.translatable}
								words={shown}
								onChange={(checked) => set("translatable", checked)}
							/>
						</Card>
					) : null}
				</div>
			) : null}

			<Card label={shown.help} htmlFor={`${id}-help`} problem={problem("help")}>
				<TextSetting
					id={`${id}-help`}
					value={field.help}
					multiline
					maxLength={1000}
					placeholder={shown.helpPlaceholder}
					invalid={problem("help") !== null}
					onSave={(text) => set("help", text)}
					data={{ "data-wc-field-setting": "help" }}
				/>
			</Card>

			{canAddInside ? (
				<button
					type="button"
					onClick={onAddInside}
					className={`${buttonLook("quiet")} w-full`}
					data-wc-field-add-inside=""
				>
					<PlusIcon aria-hidden="true" className="size-3.5" />
					{fill(shown.newIn, { label: field.label || field.key })}
				</button>
			) : null}

			<div className="mt-auto pt-4">
				<button type="button" onClick={remove} className={`${dangerLook} w-full`} data-wc-field-delete="">
					<Trash2Icon aria-hidden="true" className="size-3.5" />
					{confirming ? fill(shown.confirmDeleteField, { label: field.label || field.key }) : shown.deleteField}
				</button>
			</div>
		</section>
	);
}

/** The settings a Field's kind adds (its lengths, choices, Post Types, rows…). */
function KindSettings({
	words,
	field,
	id,
	postTypes,
	admin,
	problem,
	set,
	onChange,
}: {
	words: Words;
	field: FieldDefinition;
	id: string;
	postTypes: readonly PostTypeRow[];
	admin: string;
	problem(setting: string): string | null;
	set(key: string, value: unknown): void;
	onChange(change: FieldChange): void;
}) {
	const shown = words.postTypes.fields;
	const number = (key: string, label: string, value: number | null) => (
		<Card key={key} label={label} htmlFor={`${id}-${key}`} grow problem={problem(key)}>
			<NumberSetting
				id={`${id}-${key}`}
				value={value}
				invalid={problem(key) !== null}
				onSave={(next) => set(key, next)}
			/>
		</Card>
	);
	const pair = (left: ReturnType<typeof number>, right: ReturnType<typeof number>) => (
		<div className="flex gap-2.5">
			{left}
			{right}
		</div>
	);
	const pattern = (value: string | null) => (
		<Card
			label={shown.pattern}
			htmlFor={`${id}-pattern`}
			problem={problem("pattern")}
			help={shown.patternHelp}
			helpId={`${id}-pattern-help`}
		>
			<TextSetting
				id={`${id}-pattern`}
				value={value ?? ""}
				mono
				describedBy={`${id}-pattern-help`}
				invalid={problem("pattern") !== null}
				onSave={(text) => set("pattern", text.trim() === "" ? null : text)}
			/>
		</Card>
	);
	const several = (label: string, checked: boolean) => (
		<Card label={label} htmlFor={`${id}-multiple`} problem={problem("multiple")}>
			<Switch id={`${id}-multiple`} checked={checked} words={shown} onChange={(next) => set("multiple", next)} />
		</Card>
	);

	switch (field.type) {
		case "text":
			return (
				<>
					{pair(
						number("minLength", shown.minLength, field.minLength),
						number("maxLength", shown.maxLength, field.maxLength),
					)}
					{pattern(field.pattern)}
				</>
			);
		case "richText":
			return number("maxLength", shown.maxLength, field.maxLength);
		case "email":
			return pattern(field.pattern);
		case "number":
			return (
				<>
					{pair(number("min", shown.min, field.min), number("max", shown.max, field.max))}
					<Card label={shown.integer} htmlFor={`${id}-integer`} problem={problem("integer")}>
						<Switch
							id={`${id}-integer`}
							checked={field.integer}
							words={shown}
							onChange={(next) => set("integer", next)}
						/>
					</Card>
				</>
			);
		case "date":
			return (
				<>
					<Card label={shown.mode} htmlFor={`${id}-mode`} problem={problem("mode")}>
						<select
							id={`${id}-mode`}
							value={field.mode}
							onChange={(event) => set("mode", event.target.value)}
							className={`${BARE_INPUT} bg-chrome-raised`}
						>
							{(["date", "time", "dateTime"] as const).map((mode) => (
								<option key={mode} value={mode}>
									{shown.modes[mode]}
								</option>
							))}
						</select>
					</Card>
					<div className="flex gap-2.5">
						<Card label={shown.earliest} htmlFor={`${id}-min`} grow problem={problem("min")}>
							<TextSetting
								id={`${id}-min`}
								value={field.min ?? ""}
								mono
								onSave={(text) => set("min", text.trim() === "" ? null : text.trim())}
							/>
						</Card>
						<Card label={shown.latest} htmlFor={`${id}-max`} grow problem={problem("max")}>
							<TextSetting
								id={`${id}-max`}
								value={field.max ?? ""}
								mono
								onSave={(text) => set("max", text.trim() === "" ? null : text.trim())}
							/>
						</Card>
					</div>
				</>
			);
		case "select":
			return (
				<>
					<Choices words={words} id={id} field={field} problem={problem} onChange={onChange} />
					{several(shown.multipleChoices, field.multiple)}
					{field.multiple
						? pair(number("min", shown.fewestChoices, field.min), number("max", shown.mostChoices, field.max))
						: null}
				</>
			);
		case "relationship":
			return (
				<>
					<Card label={shown.pointsAt} problem={problem("postTypes")} data={{ "data-wc-field-points-at": "" }}>
						<span className="flex flex-col gap-1 py-0.5">
							{postTypes.map((postType) => (
								<label key={postType.id} className="flex items-center gap-2 text-[12px] font-medium">
									<input
										type="checkbox"
										checked={field.postTypes.includes(postType.key)}
										onChange={(event) =>
											set(
												"postTypes",
												event.target.checked
													? [...field.postTypes, postType.key]
													: field.postTypes.filter((key) => key !== postType.key),
											)
										}
										className="accent-primary size-3.5"
									/>
									<span className="text-chrome-strong">
										{postType.builtIn === "page" ? words.content.pages : postType.name}
									</span>
								</label>
							))}
						</span>
					</Card>
					{several(shown.multipleEntries, field.multiple)}
					{field.multiple
						? pair(number("min", shown.fewestEntries, field.min), number("max", shown.mostEntries, field.max))
						: null}
					<Card
						label={shown.twoWay}
						htmlFor={`${id}-twoWay`}
						help={shown.twoWayHelp}
						helpId={`${id}-twoWay-help`}
						problem={problem("twoWay")}
					>
						<Switch
							id={`${id}-twoWay`}
							checked={field.twoWay}
							words={shown}
							describedBy={`${id}-twoWay-help`}
							onChange={(next) => set("twoWay", next)}
						/>
					</Card>
				</>
			);
		case "repeater":
			return pair(number("min", shown.fewestRows, field.min), number("max", shown.mostRows, field.max));
		case "body":
			return (
				<a
					href={admin}
					target="_blank"
					rel="noopener noreferrer"
					className={`text-chrome-accent rounded-sm text-[12px] font-medium underline-offset-2 hover:underline ${FOCUS_RING}`}
				>
					{shown.inAdmin}
				</a>
			);
		default:
			return null;
	}
}

/** A select Field's choices: a value and a label each, added and removed. */
function Choices({
	words,
	id,
	field,
	problem,
	onChange,
}: {
	words: Words;
	id: string;
	field: Extract<FieldDefinition, { type: "select" }>;
	problem(setting: string): string | null;
	onChange(change: FieldChange): void;
}) {
	const shown = words.postTypes.fields;
	const changeOption = (index: number, part: "value" | "label", text: string) =>
		onChange((current) =>
			current.type === "select"
				? {
						...current,
						options: current.options.map((option, at) => (at === index ? { ...option, [part]: text } : option)),
					}
				: current,
		);
	const add = () =>
		onChange((current) => {
			if (current.type !== "select") return current;
			const taken = new Set(current.options.map((option) => option.value));
			let number = current.options.length + 1;
			while (taken.has(`choice-${number}`)) number++;
			return {
				...current,
				options: [
					...current.options,
					{ value: `choice-${number}`, label: fill(shown.optionNumber, { number: String(number) }) },
				],
			};
		});
	const remove = (index: number) =>
		onChange((current) =>
			current.type === "select" ? { ...current, options: current.options.filter((_, at) => at !== index) } : current,
		);
	return (
		<Card label={shown.options} problem={problem("options")} data={{ "data-wc-field-options": "" }}>
			<span className="flex flex-col gap-1.5 py-0.5">
				{field.options.map((option, index) => {
					const name = option.label || option.value || fill(shown.optionNumber, { number: String(index + 1) });
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: choices are edited in place, by their place.
						<span key={index} className="flex items-center gap-1.5">
							<span className="border-chrome-hover flex min-w-0 grow flex-col rounded border px-1.5 py-0.5">
								<TextSetting
									id={`${id}-option-${index}-label`}
									value={option.label}
									invalid={problem(`options[${index}].label`) !== null}
									onSave={(text) => changeOption(index, "label", text)}
									placeholder={shown.optionLabel}
									data={{ "data-wc-option-label": String(index) }}
								/>
								<label htmlFor={`${id}-option-${index}-label`} className="sr-only">
									{`${fill(shown.optionNumber, { number: String(index + 1) })}: ${shown.optionLabel}`}
								</label>
								<TextSetting
									id={`${id}-option-${index}-value`}
									value={option.value}
									mono
									invalid={problem(`options[${index}].value`) !== null}
									onSave={(text) => changeOption(index, "value", text)}
									placeholder={shown.optionValue}
								/>
								<label htmlFor={`${id}-option-${index}-value`} className="sr-only">
									{`${fill(shown.optionNumber, { number: String(index + 1) })}: ${shown.optionValue}`}
								</label>
								{problem(`options[${index}].value`) || problem(`options[${index}].label`) ? (
									<span className="text-chrome-danger text-[11px]">
										{problem(`options[${index}].value`) ?? problem(`options[${index}].label`)}
									</span>
								) : null}
							</span>
							<PlaceIconButton icon={XIcon} label={fill(shown.removeOption, { name })} onClick={() => remove(index)} />
						</span>
					);
				})}
				<button type="button" onClick={add} className={`${buttonLook("quiet")} h-7 self-start`} data-wc-option-add="">
					<PlusIcon aria-hidden="true" className="size-3.5" />
					{shown.addOption}
				</button>
			</span>
		</Card>
	);
}
