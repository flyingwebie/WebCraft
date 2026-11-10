import {
	canBeRequired,
	FIELD_TYPE_SETTINGS,
	FORM_AUTOCOMPLETE,
	FORM_CONDITION_OPS,
	FORM_LIMITS,
	FORM_UPLOAD_FORMATS,
	type FormCondition,
	type FormConditionOp,
	type FormUploadFormat,
	isLayoutItem,
} from "@webcraft/renderer/forms";
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
 * is required, its error message, its type's own settings, and when it shows (a condition on the
 * fields before it). A section or step has its title (the label), key, help and condition only.
 * Texts are written in the Site's Default language here; the Translations tab gives their values in
 * the other languages.
 */
export function FieldPanel({
	field,
	onChange,
	problems,
	index,
	before,
}: {
	field: FormField;
	onChange: (field: FormField) => void;
	problems: readonly FormProblem[];
	index: number;
	/** The items before it, whose values its condition may read. */
	before: readonly FormField[];
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
			{canBeRequired(field.type) ? check("required", "forms.field.required") : null}
			{text("help", "forms.field.help")}
			{uses("placeholder")
				? text("placeholder", field.type === "select" ? "forms.field.choosePrompt" : "forms.field.placeholder")
				: null}
			{field.type !== "hidden" && !isLayoutItem(field)
				? text("message", "forms.field.message", "forms.field.messageHelp")
				: null}
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
			{uses("accept") ? <Accept field={field} onChange={onChange} problem={problemAt("accept")} idPrefix={id} /> : null}
			{uses("maxFileBytes") ? (
				<Setting
					id={`${id}-maxFileBytes`}
					label={t("forms.field.maxFileMb")}
					help={t("forms.field.maxFileMbHelp", { max: FORM_LIMITS.fileBytes / (1024 * 1024) })}
					problem={problemAt("maxFileBytes")}
				>
					{(props) => (
						<Input
							{...props}
							type="number"
							inputMode="decimal"
							min={0.1}
							step={0.1}
							value={field.maxFileBytes === null ? "" : Math.round((field.maxFileBytes / (1024 * 1024)) * 10) / 10}
							onChange={(event) => {
								const megabytes = numberOrNull(event.target.value);
								set("maxFileBytes", megabytes === null ? null : Math.round(megabytes * 1024 * 1024));
							}}
						/>
					)}
				</Setting>
			) : null}
			{uses("maxFiles") ? (
				<Setting id={`${id}-maxFiles`} label={t("forms.field.maxFiles")} problem={problemAt("maxFiles")}>
					{(props) => (
						<Input
							{...props}
							type="number"
							inputMode="numeric"
							min={1}
							max={FORM_LIMITS.files}
							value={field.maxFiles ?? ""}
							onChange={(event) => set("maxFiles", numberOrNull(event.target.value))}
						/>
					)}
				</Setting>
			) : null}
			<Condition
				field={field}
				before={before}
				onChange={(condition) => set("condition", condition)}
				problems={problems.filter((problem) => problem.at.startsWith(`fields[${index}].condition`))}
				idPrefix={id}
			/>
		</FieldGroup>
	);
}

/** The groups the upload formats are offered in. */
const FORMAT_GROUPS = ["image", "document", "media"] as const;

/** The file formats a file field takes, offered by group; SVG is never among them. */
function Accept({
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
	const toggle = (format: FormUploadFormat, on: boolean) =>
		onChange({
			...field,
			accept: on ? [...field.accept, format] : field.accept.filter((each) => each !== format),
		});
	return (
		<fieldset className="grid gap-3" aria-describedby={problem ? `${idPrefix}-accept-error` : undefined}>
			<legend className="mb-1 text-sm font-medium">{t("forms.field.accept")}</legend>
			{FORMAT_GROUPS.map((group) => (
				<div key={group} className="grid gap-1.5">
					<p className="text-muted-foreground text-xs font-medium">{t(`forms.field.formatGroups.${group}`)}</p>
					<div className="flex flex-wrap gap-x-5 gap-y-3">
						{(Object.keys(FORM_UPLOAD_FORMATS) as FormUploadFormat[])
							.filter((format) => FORM_UPLOAD_FORMATS[format].group === group)
							.map((format) => (
								<div key={format} className="flex items-center gap-1.5">
									<Checkbox
										id={`${idPrefix}-accept-${format}`}
										checked={field.accept.includes(format)}
										onCheckedChange={(value) => toggle(format, value === true)}
									/>
									<Label htmlFor={`${idPrefix}-accept-${format}`} className="font-mono text-xs">
										.{FORM_UPLOAD_FORMATS[format].extensions[0]}
									</Label>
								</div>
							))}
					</div>
				</div>
			))}
			<p className="text-muted-foreground text-sm">{t("forms.field.acceptHelp")}</p>
			{problem ? <FieldError id={`${idPrefix}-accept-error`}>{problem}</FieldError> : null}
		</fieldset>
	);
}

/** The fields a condition may read: before the item, holding a value the visitor gives. */
function readable(before: readonly FormField[]): FormField[] {
	return before.filter((each) => !isLayoutItem(each) && each.type !== "hidden" && each.type !== "file");
}

/**
 * When the item shows: always, or only when all (or any) of its rules hold. Each rule reads a field
 * before it, compares its value, and is added and removed with a button.
 */
function Condition({
	field,
	before,
	onChange,
	problems,
	idPrefix,
}: {
	field: FormField;
	before: readonly FormField[];
	onChange: (condition: FormCondition | null) => void;
	problems: readonly FormProblem[];
	idPrefix: string;
}) {
	const t = useT();
	const fields = readable(before);
	const condition = field.condition;
	const rules = condition?.rules ?? [];
	const setRules = (next: FormCondition["rules"]) =>
		onChange(next.length === 0 ? null : { match: condition?.match ?? "all", rules: next });
	const first = fields[0];
	return (
		<fieldset className="grid gap-3 border-t pt-4">
			<legend className="mb-1 text-sm font-medium">{t("forms.condition.title")}</legend>
			{rules.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{fields.length === 0 ? t("forms.condition.noFields") : t("forms.condition.always")}
				</p>
			) : (
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-match`}>{t("forms.condition.match")}</FieldLabel>
					<NativeSelect
						id={`${idPrefix}-match`}
						value={condition?.match ?? "all"}
						onChange={(event) => onChange({ match: event.target.value === "any" ? "any" : "all", rules })}
					>
						<NativeSelectOption value="all">{t("forms.condition.all")}</NativeSelectOption>
						<NativeSelectOption value="any">{t("forms.condition.any")}</NativeSelectOption>
					</NativeSelect>
				</Field>
			)}
			{rules.map((rule, index) => {
				const target = fields.find((each) => each.key === rule.field);
				const needsValue = rule.op !== "isEmpty" && rule.op !== "isNotEmpty";
				const update = (change: Partial<FormCondition["rules"][number]>) =>
					setRules(rules.map((each, at) => (at === index ? { ...each, ...change } : each)));
				const problem = problems.find((each) => each.at.includes(`rules[${index}]`))?.message;
				return (
					<fieldset
						// biome-ignore lint/suspicious/noArrayIndexKey: rules are edited in place.
						key={index}
						className="grid gap-2 rounded-md border p-3"
					>
						<legend className="text-muted-foreground px-1 text-xs font-medium">
							{t("forms.condition.rule", { number: index + 1 })}
						</legend>
						<Field>
							<FieldLabel htmlFor={`${idPrefix}-rule-${index}-field`}>{t("forms.condition.field")}</FieldLabel>
							<NativeSelect
								id={`${idPrefix}-rule-${index}-field`}
								value={rule.field}
								onChange={(event) => update({ field: event.target.value })}
							>
								{target ? null : <NativeSelectOption value={rule.field}>{rule.field}</NativeSelectOption>}
								{fields.map((each) => (
									<NativeSelectOption key={each.key} value={each.key}>
										{each.label.text || each.key}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${idPrefix}-rule-${index}-op`}>{t("forms.condition.op")}</FieldLabel>
							<NativeSelect
								id={`${idPrefix}-rule-${index}-op`}
								value={rule.op}
								onChange={(event) => {
									const op = event.target.value as FormConditionOp;
									update({ op, value: op === "isEmpty" || op === "isNotEmpty" ? null : (rule.value ?? "") });
								}}
							>
								{FORM_CONDITION_OPS.map((op) => (
									<NativeSelectOption key={op} value={op}>
										{t(`forms.condition.ops.${op}`)}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						{needsValue ? (
							<Field>
								<FieldLabel htmlFor={`${idPrefix}-rule-${index}-value`}>{t("forms.condition.value")}</FieldLabel>
								{target && target.options.length > 0 ? (
									<NativeSelect
										id={`${idPrefix}-rule-${index}-value`}
										value={rule.value ?? ""}
										onChange={(event) => update({ value: event.target.value })}
									>
										<NativeSelectOption value="">{t("forms.condition.choose")}</NativeSelectOption>
										{target.options.map((option) => (
											<NativeSelectOption key={option.value} value={option.value}>
												{option.label.text}
											</NativeSelectOption>
										))}
									</NativeSelect>
								) : (
									<Input
										id={`${idPrefix}-rule-${index}-value`}
										value={rule.value ?? ""}
										onChange={(event) => update({ value: event.target.value })}
									/>
								)}
							</Field>
						) : null}
						{problem ? <FieldError>{problem}</FieldError> : null}
						<Button
							variant="ghost"
							className="justify-self-start"
							onClick={() => setRules(rules.filter((_, at) => at !== index))}
						>
							<TrashIcon data-icon="inline-start" />
							{t("forms.condition.removeRule", { number: index + 1 })}
						</Button>
					</fieldset>
				);
			})}
			{first ? (
				<Button
					variant="outline"
					className="justify-self-start"
					onClick={() =>
						setRules([
							...rules,
							{
								field: first.key,
								op: first.options.length > 0 ? "is" : "isNotEmpty",
								value: first.options[0]?.value ?? null,
							},
						])
					}
				>
					<PlusIcon data-icon="inline-start" />
					{t("forms.condition.addRule")}
				</Button>
			) : null}
			{problems.find((problem) => !/rules\[\d+\]/.test(problem.at))?.message ? (
				<FieldError>{problems.find((problem) => !/rules\[\d+\]/.test(problem.at))?.message}</FieldError>
			) : null}
		</fieldset>
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
