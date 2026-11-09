import { FIELD_TYPE_SETTINGS, FORM_AUTOCOMPLETE } from "@webcraft/renderer/forms";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { PlusIcon, TrashIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { type MessageKey, useT } from "../i18n.tsx";
import { type FormField, type FormProblem, numberOrNull, optionalText } from "./model.ts";

/**
 * The settings of one field: its label (which may be hidden, never left out), key, help, whether it
 * is required, its error message, and its type's own settings. Texts are written in the Site's
 * Default language here; the Translations tab gives their values in the other languages.
 */
export function FieldPanel({
	field,
	onChange,
	problems,
	index,
}: {
	field: FormField;
	onChange: (field: FormField) => void;
	problems: readonly FormProblem[];
	index: number;
}) {
	const t = useT();
	const id = useId();
	const uses = (name: string) => (FIELD_TYPE_SETTINGS[field.type] as readonly string[]).includes(name);
	const problemAt = (setting: string) =>
		problems.find(
			(problem) =>
				problem.at === `fields[${index}].${setting}` || problem.at.startsWith(`fields[${index}].${setting}.`),
		)?.message;
	const set = <Key extends keyof FormField>(key: Key, value: FormField[Key]) => onChange({ ...field, [key]: value });

	const text = (setting: "label" | "help" | "placeholder" | "message", label: MessageKey, help?: MessageKey) => (
		<Setting id={`${id}-${setting}`} label={t(label)} help={help ? t(help) : undefined} problem={problemAt(setting)}>
			{(props) => (
				<Input
					{...props}
					value={field[setting]?.text ?? ""}
					onChange={(event) =>
						setting === "label"
							? set("label", { ...field.label, text: event.target.value })
							: set(setting, optionalText(field[setting], event.target.value))
					}
				/>
			)}
		</Setting>
	);
	const number = (
		setting: "minLength" | "maxLength" | "min" | "max" | "minChoices" | "maxChoices",
		label: MessageKey,
	) => (
		<Setting id={`${id}-${setting}`} label={t(label)} problem={problemAt(setting)}>
			{(props) => (
				<Input
					{...props}
					type="number"
					inputMode="decimal"
					value={field[setting] ?? ""}
					onChange={(event) => set(setting, numberOrNull(event.target.value))}
				/>
			)}
		</Setting>
	);
	const check = (setting: "required" | "hideLabel" | "integer", label: MessageKey, help?: MessageKey) => (
		<div className="flex items-start gap-2">
			<Checkbox
				id={`${id}-${setting}`}
				checked={field[setting]}
				onCheckedChange={(value) => set(setting, value === true)}
				aria-describedby={help ? `${id}-${setting}-help` : undefined}
				className="mt-0.5"
			/>
			<div className="grid gap-0.5">
				<Label htmlFor={`${id}-${setting}`}>{t(label)}</Label>
				{help ? (
					<p id={`${id}-${setting}-help`} className="text-muted-foreground text-sm">
						{t(help)}
					</p>
				) : null}
			</div>
		</div>
	);

	return (
		<FieldGroup>
			{text("label", "forms.field.label", "forms.field.labelHelp")}
			{check("hideLabel", "forms.field.hideLabel", "forms.field.hideLabelHelp")}
			<Setting id={`${id}-key`} label={t("forms.field.key")} help={t("forms.field.keyHelp")} problem={problemAt("key")}>
				{(props) => (
					<Input
						{...props}
						className="font-mono"
						value={field.key}
						onChange={(event) => set("key", event.target.value)}
					/>
				)}
			</Setting>
			{field.type !== "hidden" ? check("required", "forms.field.required") : null}
			{text("help", "forms.field.help")}
			{uses("placeholder")
				? text("placeholder", field.type === "select" ? "forms.field.choosePrompt" : "forms.field.placeholder")
				: null}
			{field.type !== "hidden" ? text("message", "forms.field.message", "forms.field.messageHelp") : null}
			{uses("minLength") ? number("minLength", "forms.field.minLength") : null}
			{uses("maxLength") ? number("maxLength", "forms.field.maxLength") : null}
			{uses("pattern") ? (
				<Setting
					id={`${id}-pattern`}
					label={t("forms.field.pattern")}
					help={t("forms.field.patternHelp")}
					problem={problemAt("pattern")}
				>
					{(props) => (
						<Input
							{...props}
							className="font-mono"
							value={field.pattern ?? ""}
							onChange={(event) => set("pattern", event.target.value === "" ? null : event.target.value)}
						/>
					)}
				</Setting>
			) : null}
			{uses("autocomplete") ? (
				<Setting
					id={`${id}-autocomplete`}
					label={t("forms.field.autocomplete")}
					help={t("forms.field.autocompleteHelp")}
					problem={problemAt("autocomplete")}
				>
					{(props) => (
						<NativeSelect
							{...props}
							value={field.autocomplete ?? ""}
							onChange={(event) => set("autocomplete", event.target.value === "" ? null : event.target.value)}
						>
							<NativeSelectOption value="">{t("forms.field.autocompleteNone")}</NativeSelectOption>
							{FORM_AUTOCOMPLETE.map((purpose) => (
								<NativeSelectOption key={purpose} value={purpose}>
									{purpose}
								</NativeSelectOption>
							))}
						</NativeSelect>
					)}
				</Setting>
			) : null}
			{uses("min") ? number("min", "forms.field.min") : null}
			{uses("max") ? number("max", "forms.field.max") : null}
			{uses("integer") ? check("integer", "forms.field.integer") : null}
			{uses("minDate")
				? (["minDate", "maxDate"] as const).map((setting) => (
						<Setting
							key={setting}
							id={`${id}-${setting}`}
							label={t(setting === "minDate" ? "forms.field.minDate" : "forms.field.maxDate")}
							problem={problemAt(setting)}
						>
							{(props) => (
								<Input
									{...props}
									type="date"
									value={field[setting] ?? ""}
									onChange={(event) => set(setting, event.target.value === "" ? null : event.target.value)}
								/>
							)}
						</Setting>
					))
				: null}
			{uses("options") ? (
				<Options field={field} onChange={onChange} problem={problemAt("options")} idPrefix={id} />
			) : null}
			{uses("minChoices") ? number("minChoices", "forms.field.minChoices") : null}
			{uses("maxChoices") ? number("maxChoices", "forms.field.maxChoices") : null}
			{uses("source") ? <Source field={field} onChange={onChange} problem={problemAt("source")} idPrefix={id} /> : null}
		</FieldGroup>
	);
}

/** One setting: its label, control, help and the server's problem with it, linked together. */
function Setting({
	id,
	label,
	help,
	problem,
	children,
}: {
	id: string;
	label: string;
	help?: string;
	problem?: string;
	children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
	const describedBy = [help ? `${id}-help` : null, problem ? `${id}-error` : null].filter(Boolean).join(" ");
	return (
		<Field data-invalid={problem ? true : undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			{children({ id, "aria-describedby": describedBy || undefined, "aria-invalid": problem ? true : undefined })}
			{help ? <FieldDescription id={`${id}-help`}>{help}</FieldDescription> : null}
			{problem ? <FieldError id={`${id}-error`}>{problem}</FieldError> : null}
		</Field>
	);
}

/** A field's options: each one's label and the value kept, in order; added and removed. */
function Options({
	field,
	onChange,
	problem,
	idPrefix,
}: {
	field: FormField;
	onChange: (field: FormField) => void;
	problem?: string;
	idPrefix: string;
}) {
	const t = useT();
	const options = field.options;
	const update = (next: FormField["options"]) => onChange({ ...field, options: next });
	return (
		<fieldset className="grid gap-3">
			<legend className="mb-2 text-sm font-medium">{t("forms.field.options")}</legend>
			{options.map((option, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: options are edited in place; their values can repeat while typing.
				<div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
					<Field>
						<FieldLabel htmlFor={`${idPrefix}-option-${index}-label`}>
							{t("forms.field.optionLabel", { number: index + 1 })}
						</FieldLabel>
						<Input
							id={`${idPrefix}-option-${index}-label`}
							value={option.label.text}
							onChange={(event) =>
								update(
									options.map((one, at) =>
										at === index ? { ...one, label: { ...one.label, text: event.target.value } } : one,
									),
								)
							}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${idPrefix}-option-${index}-value`}>
							{t("forms.field.optionValue", { number: index + 1 })}
						</FieldLabel>
						<Input
							id={`${idPrefix}-option-${index}-value`}
							className="font-mono"
							value={option.value}
							onChange={(event) =>
								update(options.map((one, at) => (at === index ? { ...one, value: event.target.value } : one)))
							}
						/>
					</Field>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("forms.field.removeOption", { label: option.label.text })}
						onClick={() => update(options.filter((_, at) => at !== index))}
					>
						<TrashIcon />
					</Button>
				</div>
			))}
			<Button
				variant="outline"
				className="justify-self-start"
				onClick={() =>
					update([
						...options,
						{
							value: `option_${options.length + 1}`,
							label: { text: `${t("forms.field.option")} ${options.length + 1}` },
						},
					])
				}
			>
				<PlusIcon data-icon="inline-start" />
				{t("forms.field.addOption")}
			</Button>
			{problem ? <FieldError>{problem}</FieldError> : null}
		</fieldset>
	);
}

/** Where a hidden field's value comes from: the page's address, a parameter of it, or fixed text. */
function Source({
	field,
	onChange,
	problem,
	idPrefix,
}: {
	field: FormField;
	onChange: (field: FormField) => void;
	problem?: string;
	idPrefix: string;
}) {
	const t = useT();
	const source = field.source ?? { kind: "page" };
	return (
		<FieldGroup>
			<Field>
				<FieldLabel htmlFor={`${idPrefix}-source`}>{t("forms.field.source")}</FieldLabel>
				<NativeSelect
					id={`${idPrefix}-source`}
					value={source.kind}
					onChange={(event) => {
						const kind = event.target.value;
						onChange({
							...field,
							source:
								kind === "query"
									? { kind: "query", name: "utm_source" }
									: kind === "fixed"
										? { kind: "fixed", value: "" }
										: { kind: "page" },
						});
					}}
				>
					<NativeSelectOption value="page">{t("forms.field.sourcePage")}</NativeSelectOption>
					<NativeSelectOption value="query">{t("forms.field.sourceQuery")}</NativeSelectOption>
					<NativeSelectOption value="fixed">{t("forms.field.sourceFixed")}</NativeSelectOption>
				</NativeSelect>
			</Field>
			{source.kind === "query" ? (
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-source-name`}>{t("forms.field.sourceName")}</FieldLabel>
					<Input
						id={`${idPrefix}-source-name`}
						className="font-mono"
						value={source.name}
						onChange={(event) => onChange({ ...field, source: { kind: "query", name: event.target.value } })}
					/>
				</Field>
			) : null}
			{source.kind === "fixed" ? (
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-source-value`}>{t("forms.field.sourceValue")}</FieldLabel>
					<Input
						id={`${idPrefix}-source-value`}
						value={source.value}
						onChange={(event) => onChange({ ...field, source: { kind: "fixed", value: event.target.value } })}
					/>
				</Field>
			) : null}
			{problem ? <FieldError>{problem}</FieldError> : null}
		</FieldGroup>
	);
}
