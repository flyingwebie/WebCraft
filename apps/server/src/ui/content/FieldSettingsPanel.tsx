import {
	FIELD_HELP_MAX_LENGTH,
	FIELD_LABEL_MAX_LENGTH,
	FIELD_TYPE_TRAITS,
	type FieldType,
	isContainerType,
	PATTERN_MAX_LENGTH,
} from "@webcraft/core/field-rules";
import { ALWAYS_ON_BLOCKS, BLOCK_TYPES } from "@webcraft/renderer/body";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { type MessageKey, useT } from "../i18n.tsx";
import { AllowedComponents } from "./body/AllowedComponents.tsx";
import { FIELD_TYPE_ICONS, type FieldOwner, offeredTypes } from "./FieldBuilder.tsx";
import { FieldValue, type ValueContext } from "./FieldValues.tsx";
import { changeField, type FieldDraft, freeKey, keyFromLabel, newField, replaceDraft } from "./field-drafts.ts";
import { emptyValue, type FieldDefinition, type Json } from "./model.ts";
import { moveItem } from "./reorder.tsx";

/** Problems the server found with one Field's settings: which setting (`key`, `options[1].value`), and why. */
export type SettingProblems = readonly { setting: string; message: string }[];

/** The settings the panel shows controls for; problems with any other show at its top. */
const SHOWN_SETTINGS = [
	"label",
	"key",
	"type",
	"help",
	"minLength",
	"maxLength",
	"pattern",
	"min",
	"max",
	"integer",
	"mode",
	"options",
	"multiple",
	"postTypes",
	"twoWay",
	"blocksOff",
	"components",
	"default",
	"required",
	"translatable",
] as const;

type Setting = (typeof SHOWN_SETTINGS)[number];

function settingOf(path: string): string {
	return path.split(/[.[]/)[0] ?? path;
}

/**
 * The selected Field's settings, next to the Field list: its label, key, type and help text, the
 * settings of its type, its default, and whether it is required and translatable. Each change goes
 * into the list at once; the screen saves the whole list. Problems the server found show at the
 * setting they are about.
 */
export function FieldSettingsPanel({
	draft,
	depth,
	siblings,
	all,
	problems,
	owner,
	postTypes,
	siteId,
	defaultLanguage,
	onChange,
	onClose,
	onRemove,
}: {
	draft: FieldDraft;
	depth: number;
	siblings: readonly FieldDraft[];
	all: readonly FieldDraft[];
	problems: SettingProblems;
	owner: FieldOwner;
	postTypes: readonly { key: string; name: string }[];
	siteId: string;
	defaultLanguage: string;
	onChange(drafts: FieldDraft[]): void;
	onClose(): void;
	onRemove(): void;
}) {
	const t = useT();
	const { field } = draft;
	const Icon = FIELD_TYPE_ICONS[field.type];
	const traits = FIELD_TYPE_TRAITS[field.type];
	const others = siblings.filter((sibling) => sibling.uid !== draft.uid);
	const set = (change: (field: FieldDefinition) => FieldDefinition) => onChange(changeField(all, draft.uid, change));
	const update = (values: Record<string, unknown>) => set((before) => ({ ...before, ...values }) as FieldDefinition);
	const at = (setting: Setting) => problems.filter((problem) => settingOf(problem.setting) === setting);
	const elsewhere = problems.filter(
		(problem) => !(SHOWN_SETTINGS as readonly string[]).includes(settingOf(problem.setting)),
	);
	// A new Field's key follows its label until someone changes the key.
	const keyFollowsLabel = !draft.saved && field.key === freeKey(keyFromLabel(field.label) || "field", others);

	return (
		<section aria-labelledby="field-settings-heading" className="grid content-start gap-6 xl:border-s xl:ps-6">
			<div className="flex items-start gap-3">
				<span className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
					<Icon className="size-4" aria-hidden="true" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 id="field-settings-heading" className="truncate text-lg font-semibold tracking-tight">
						{field.label || field.key}
					</h2>
					<p className="text-muted-foreground text-sm">
						{t("postTypes.settings.typeField", { type: t(`content.types.${field.type}`) })}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("postTypes.settings.close")}
					onClick={onClose}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>

			{elsewhere.length > 0 ? <SettingNotes id="setting-other" problems={elsewhere} /> : null}

			<div className="grid gap-4 border-t pt-5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
				<SettingField id="setting-label" label="postTypes.settings.label" problems={at("label")}>
					{(described) => (
						<Input
							id="setting-label"
							value={field.label}
							maxLength={FIELD_LABEL_MAX_LENGTH}
							autoComplete="off"
							autoFocus={!draft.saved}
							aria-describedby={described}
							aria-invalid={at("label").length > 0 ? true : undefined}
							onChange={(event) => {
								const label = event.target.value;
								update(keyFollowsLabel ? { label, key: freeKey(keyFromLabel(label) || "field", others) } : { label });
							}}
						/>
					)}
				</SettingField>
				<SettingField
					id="setting-key"
					label="postTypes.settings.key"
					help={draft.saved ? "postTypes.settings.keySavedHelp" : "postTypes.settings.keyHelp"}
					problems={at("key")}
				>
					{(described) => (
						<Input
							id="setting-key"
							value={field.key}
							readOnly={draft.saved}
							maxLength={64}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
							aria-describedby={described}
							aria-invalid={at("key").length > 0 ? true : undefined}
							onChange={(event) => update({ key: event.target.value })}
						/>
					)}
				</SettingField>
			</div>

			{!draft.saved ? (
				<SettingField id="setting-type" label="postTypes.settings.type" problems={at("type")}>
					{(described) => (
						<NativeSelect
							id="setting-type"
							value={field.type}
							aria-describedby={described}
							onChange={(event) => {
								const type = event.target.value as FieldType;
								onChange(
									replaceDraft(all, draft.uid, (before) => ({
										...before,
										field: {
											...newField(type, before.field.key, before.field.label),
											help: before.field.help,
											required: before.field.required && FIELD_TYPE_TRAITS[type].requirable,
										},
										children: isContainerType(type) ? before.children : [],
									})),
								);
							}}
							className="w-full"
						>
							{offeredTypes(owner, depth, all, draft.uid).map((type) => (
								<NativeSelectOption key={type} value={type}>
									{t(`content.types.${type}`)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					)}
				</SettingField>
			) : (
				<p className="text-muted-foreground text-sm">{t("postTypes.settings.typeKept")}</p>
			)}

			<SettingField id="setting-help" label="postTypes.settings.help" problems={at("help")}>
				{(described) => (
					<Textarea
						id="setting-help"
						value={field.help}
						rows={2}
						maxLength={FIELD_HELP_MAX_LENGTH}
						aria-describedby={described}
						onChange={(event) => update({ help: event.target.value })}
					/>
				)}
			</SettingField>

			<TypeSettings siteId={siteId} field={field} at={at} update={update} postTypes={postTypes} />

			{traits.hasDefault ? (
				<div className="grid gap-2 border-t pt-5">
					<FieldValue
						field={
							{
								...field,
								label: t("postTypes.settings.default"),
								help: t("postTypes.settings.defaultHelp"),
								required: false,
							} as FieldDefinition
						}
						value={(field.default as Json) ?? emptyValue(field)}
						onChange={(value) =>
							update({ default: value === "" || (Array.isArray(value) && value.length === 0) ? null : value })
						}
						path="default"
						context={defaultContext(siteId, defaultLanguage)}
					/>

					<SettingNotes id="setting-default" problems={at("default")} />
				</div>
			) : null}

			<div className="grid gap-4 border-t pt-5">
				{traits.requirable ? (
					<SettingCheckbox
						id="setting-required"
						label="postTypes.settings.required"
						help={
							field.type === "relationship"
								? "postTypes.settings.requiredRelationshipHelp"
								: owner === "globals"
									? "postTypes.settings.requiredGlobalsHelp"
									: "postTypes.settings.requiredHelp"
						}
						checked={field.required}
						onChange={(required) => update({ required })}
						problems={at("required")}
					/>
				) : null}
				{traits.translation === "never" ? (
					<p className="text-muted-foreground text-sm">
						{t(
							field.type === "relationship" ? "postTypes.settings.sharedAlways" : "postTypes.settings.translatedInside",
						)}
					</p>
				) : (
					<SettingCheckbox
						id="setting-translatable"
						label="postTypes.settings.translatable"
						help="postTypes.settings.translatableHelp"
						checked={field.translatable}
						onChange={(translatable) => update({ translatable })}
						problems={at("translatable")}
					/>
				)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
				<Button type="button" variant="outline" onClick={onRemove}>
					<Trash2Icon aria-hidden="true" />
					{t("postTypes.fields.remove")}
				</Button>
				<Button type="button" onClick={onClose}>
					{t("postTypes.settings.done")}
				</Button>
			</div>
		</section>
	);
}

/** The context the default value's control runs in: no problems of its own, nothing to point at. */
function defaultContext(siteId: string, defaultLanguage: string): ValueContext {
	return {
		siteId,
		idPrefix: "setting",
		language: defaultLanguage,
		defaultLanguage,
		problems: [],
		relationships: {},
		media: {},
		onMediaChosen: () => {},
		markShared: false,
	};
}

/** The settings only some Field types have. */
function TypeSettings({
	siteId,
	field,
	at,
	update,
	postTypes,
}: {
	siteId: string;
	field: FieldDefinition;
	at(setting: Setting): SettingProblems;
	update(values: Record<string, unknown>): void;
	postTypes: readonly { key: string; name: string }[];
}) {
	const t = useT();
	switch (field.type) {
		case "text":
			return (
				<div className="grid gap-4 border-t pt-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<NumberSetting
							id="setting-minLength"
							label="postTypes.settings.minLength"
							value={field.minLength}
							whole
							problems={at("minLength")}
							onChange={(minLength) => update({ minLength })}
						/>
						<NumberSetting
							id="setting-maxLength"
							label="postTypes.settings.maxLength"
							value={field.maxLength}
							whole
							problems={at("maxLength")}
							onChange={(maxLength) => update({ maxLength })}
						/>
					</div>
					<PatternSetting value={field.pattern} problems={at("pattern")} onChange={(pattern) => update({ pattern })} />
				</div>
			);
		case "richText":
			return (
				<div className="grid gap-4 border-t pt-5">
					<NumberSetting
						id="setting-maxLength"
						label="postTypes.settings.maxTextLength"
						value={field.maxLength}
						whole
						problems={at("maxLength")}
						onChange={(maxLength) => update({ maxLength })}
					/>
				</div>
			);
		case "email":
			return (
				<div className="grid gap-4 border-t pt-5">
					<PatternSetting value={field.pattern} problems={at("pattern")} onChange={(pattern) => update({ pattern })} />
				</div>
			);
		case "number":
			return (
				<div className="grid gap-4 border-t pt-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<NumberSetting
							id="setting-min"
							label="postTypes.settings.minNumber"
							value={field.min}
							problems={at("min")}
							onChange={(min) => update({ min })}
						/>
						<NumberSetting
							id="setting-max"
							label="postTypes.settings.maxNumber"
							value={field.max}
							problems={at("max")}
							onChange={(max) => update({ max })}
						/>
					</div>
					<SettingCheckbox
						id="setting-integer"
						label="postTypes.settings.integer"
						checked={field.integer}
						onChange={(integer) => update({ integer })}
						problems={at("integer")}
					/>
				</div>
			);
		case "date":
			return (
				<div className="grid gap-4 border-t pt-5">
					<SettingField id="setting-mode" label="postTypes.settings.mode" problems={at("mode")}>
						{(described) => (
							<NativeSelect
								id="setting-mode"
								value={field.mode}
								aria-describedby={described}
								onChange={(event) => update({ mode: event.target.value, min: null, max: null, default: null })}
								className="w-full"
							>
								<NativeSelectOption value="date">{t("postTypes.settings.modes.date")}</NativeSelectOption>
								<NativeSelectOption value="time">{t("postTypes.settings.modes.time")}</NativeSelectOption>
								<NativeSelectOption value="dateTime">{t("postTypes.settings.modes.dateTime")}</NativeSelectOption>
							</NativeSelect>
						)}
					</SettingField>
					<div className="grid gap-4 sm:grid-cols-2">
						{(["min", "max"] as const).map((bound) => (
							<SettingField
								key={bound}
								id={`setting-${bound}`}
								label={bound === "min" ? "postTypes.settings.earliest" : "postTypes.settings.latest"}
								help={field.mode === "dateTime" ? "postTypes.settings.utcHelp" : undefined}
								problems={at(bound)}
							>
								{(described) => (
									<Input
										id={`setting-${bound}`}
										type={field.mode === "dateTime" ? "datetime-local" : field.mode}
										value={(field[bound] ?? "").replace(/:\d\dZ$/, "")}
										aria-describedby={described}
										aria-invalid={at(bound).length > 0 ? true : undefined}
										onChange={(event) => {
											const value = event.target.value;
											update({
												[bound]: value === "" ? null : field.mode === "dateTime" ? `${value.slice(0, 16)}:00Z` : value,
											});
										}}
									/>
								)}
							</SettingField>
						))}
					</div>
				</div>
			);
		case "select":
			return (
				<div className="grid gap-4 border-t pt-5">
					<OptionsSetting
						options={field.options}
						problems={at("options")}
						onChange={(options) => update({ options })}
					/>
					<SettingCheckbox
						id="setting-multiple"
						label="postTypes.settings.multipleChoices"
						checked={field.multiple}
						onChange={(multiple) => update({ multiple, min: null, max: null, default: null })}
						problems={at("multiple")}
					/>
					{field.multiple ? (
						<CountSettings min={field.min} max={field.max} at={at} update={update} kind="choices" />
					) : null}
				</div>
			);
		case "relationship":
			return (
				<div className="grid gap-4 border-t pt-5">
					<fieldset
						className="grid gap-2"
						aria-describedby={at("postTypes").length > 0 ? "setting-postTypes-problems" : undefined}
					>
						<legend className="mb-1 text-sm font-medium">{t("postTypes.settings.pointsAt")}</legend>
						{postTypes.map((postType) => (
							<div key={postType.key} className="flex items-center gap-2">
								<Checkbox
									id={`setting-postTypes-${postType.key}`}
									checked={field.postTypes.includes(postType.key)}
									onCheckedChange={(checked) =>
										update({
											postTypes:
												checked === true
													? [...field.postTypes, postType.key]
													: field.postTypes.filter((key) => key !== postType.key),
										})
									}
								/>
								<Label htmlFor={`setting-postTypes-${postType.key}`} className="font-normal">
									{postType.name}
								</Label>
							</div>
						))}
						<SettingNotes id="setting-postTypes" problems={at("postTypes")} />
					</fieldset>
					<SettingCheckbox
						id="setting-multiple"
						label="postTypes.settings.multipleEntries"
						checked={field.multiple}
						onChange={(multiple) => update({ multiple, min: null, max: null })}
						problems={at("multiple")}
					/>
					{field.multiple ? (
						<CountSettings min={field.min} max={field.max} at={at} update={update} kind="entries" />
					) : null}
					<fieldset className="grid gap-2">
						<legend className="mb-1 text-sm font-medium">{t("postTypes.settings.direction")}</legend>
						<RadioGroup
							value={field.twoWay ? "two" : "one"}
							onValueChange={(value) => update({ twoWay: value === "two" })}
							aria-describedby="setting-twoWay-help"
						>
							<div className="flex items-center gap-2">
								<RadioGroupItem id="setting-twoWay-two" value="two" />
								<Label htmlFor="setting-twoWay-two" className="font-normal">
									{t("postTypes.settings.twoWay")}
								</Label>
							</div>
							<div className="flex items-center gap-2">
								<RadioGroupItem id="setting-twoWay-one" value="one" />
								<Label htmlFor="setting-twoWay-one" className="font-normal">
									{t("postTypes.settings.oneWay")}
								</Label>
							</div>
						</RadioGroup>
						<p id="setting-twoWay-help" className="text-muted-foreground text-sm">
							{t(field.twoWay ? "postTypes.settings.twoWayHelp" : "postTypes.settings.oneWayHelp")}
						</p>
						<SettingNotes id="setting-twoWay" problems={at("twoWay")} />
					</fieldset>
				</div>
			);
		case "repeater":
			return (
				<div className="grid gap-4 border-t pt-5">
					<CountSettings min={field.min} max={field.max} at={at} update={update} kind="rows" />
				</div>
			);
		case "body":
			return (
				<div className="grid gap-4 border-t pt-5">
					<fieldset className="grid gap-2" aria-describedby="setting-blocksOff-help">
						<legend className="mb-1 text-sm font-medium">{t("postTypes.settings.blocks")}</legend>
						<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
							{BLOCK_TYPES.filter((type) => !ALWAYS_ON_BLOCKS.includes(type)).map((type) => (
								<div key={type} className="flex items-center gap-2">
									<Checkbox
										id={`setting-blocks-${type}`}
										checked={!field.blocksOff.includes(type)}
										onCheckedChange={(checked) =>
											update({
												blocksOff:
													checked === true
														? field.blocksOff.filter((off) => off !== type)
														: BLOCK_TYPES.filter((each) => each === type || field.blocksOff.includes(each)),
											})
										}
									/>
									<Label htmlFor={`setting-blocks-${type}`} className="font-normal">
										{t(`body.types.${type}`)}
									</Label>
								</div>
							))}
						</div>
						<p id="setting-blocksOff-help" className="text-muted-foreground text-sm">
							{t("postTypes.settings.blocksHelp")}
						</p>
						<SettingNotes id="setting-blocksOff" problems={at("blocksOff")} />
					</fieldset>
					<AllowedComponents
						siteId={siteId}
						value={field.components}
						onChange={(components) => update({ components })}
					/>
					<SettingNotes id="setting-components" problems={at("components")} />
				</div>
			);
		case "group":
			return null;
		default:
			return null;
	}
}

/** The fewest and most choices, Entries or rows. */
function CountSettings({
	min,
	max,
	at,
	update,
	kind,
}: {
	min: number | null;
	max: number | null;
	at(setting: Setting): SettingProblems;
	update(values: Record<string, unknown>): void;
	kind: "choices" | "entries" | "rows";
}) {
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<NumberSetting
				id="setting-min"
				label={`postTypes.settings.fewest.${kind}`}
				value={min}
				whole
				problems={at("min")}
				onChange={(value) => update({ min: value })}
			/>
			<NumberSetting
				id="setting-max"
				label={`postTypes.settings.most.${kind}`}
				value={max}
				whole
				problems={at("max")}
				onChange={(value) => update({ max: value })}
			/>
		</div>
	);
}

/** A select Field's choices: each a label people see and a value Templates and the APIs read. */
function OptionsSetting({
	options,
	problems,
	onChange,
}: {
	options: readonly { value: string; label: string }[];
	problems: SettingProblems;
	onChange(options: { value: string; label: string }[]): void;
}) {
	const t = useT();
	const at = (index: number, part: "value" | "label") =>
		problems.filter((problem) => problem.setting === `options[${index}].${part}`);
	const general = problems.filter((problem) => problem.setting === "options");
	const change = (index: number, part: "value" | "label", text: string) =>
		onChange(
			options.map((option, each) => {
				if (each !== index) return option;
				if (part === "value") return { ...option, value: text };
				// A choice's value follows its label until someone changes it.
				const follows = option.value === "" || option.value === optionValue(option.label);
				return { label: text, value: follows ? optionValue(text) : option.value };
			}),
		);
	return (
		<fieldset className="grid gap-3" aria-describedby={general.length > 0 ? "setting-options-problems" : undefined}>
			<legend className="mb-1 text-sm font-medium">{t("postTypes.settings.options")}</legend>
			{options.length > 0 ? (
				<ol className="grid gap-3">
					{options.map((option, index) => {
						const name = option.label || t("postTypes.settings.optionNumber", { number: index + 1 });
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: choices are edited in place; their values can repeat while typing.
							<li key={index} className="grid gap-2 rounded-md border p-3">
								<div className="grid gap-2 sm:grid-cols-2">
									<div className="grid gap-1">
										<Label htmlFor={`setting-option-${index}-label`} className="font-normal">
											{t("postTypes.settings.optionLabel")}
										</Label>
										<Input
											id={`setting-option-${index}-label`}
											value={option.label}
											maxLength={100}
											autoComplete="off"
											aria-describedby={
												at(index, "label").length > 0 ? `setting-option-${index}-label-problems` : undefined
											}
											aria-invalid={at(index, "label").length > 0 ? true : undefined}
											onChange={(event) => change(index, "label", event.target.value)}
										/>
										<SettingNotes id={`setting-option-${index}-label`} problems={at(index, "label")} />
									</div>
									<div className="grid gap-1">
										<Label htmlFor={`setting-option-${index}-value`} className="font-normal">
											{t("postTypes.settings.optionValue")}
										</Label>
										<Input
											id={`setting-option-${index}-value`}
											value={option.value}
											maxLength={64}
											autoComplete="off"
											spellCheck={false}
											className="font-mono"
											aria-describedby={
												at(index, "value").length > 0 ? `setting-option-${index}-value-problems` : undefined
											}
											aria-invalid={at(index, "value").length > 0 ? true : undefined}
											onChange={(event) => change(index, "value", event.target.value)}
										/>
										<SettingNotes id={`setting-option-${index}-value`} problems={at(index, "value")} />
									</div>
								</div>
								<div className="flex justify-end gap-1">
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										disabled={index === 0}
										aria-label={t("postTypes.settings.optionUp", { name })}
										onClick={() => onChange(moveItem(options, index, index - 1))}
									>
										<ArrowUpIcon aria-hidden="true" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										disabled={index === options.length - 1}
										aria-label={t("postTypes.settings.optionDown", { name })}
										onClick={() => onChange(moveItem(options, index, index + 1))}
									>
										<ArrowDownIcon aria-hidden="true" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										aria-label={t("postTypes.settings.optionRemove", { name })}
										onClick={() => onChange(options.filter((_, each) => each !== index))}
									>
										<Trash2Icon aria-hidden="true" />
									</Button>
								</div>
							</li>
						);
					})}
				</ol>
			) : null}
			<div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onChange([...options, { value: "", label: "" }])}
				>
					<PlusIcon aria-hidden="true" />
					{t("postTypes.settings.addOption")}
				</Button>
			</div>
			<SettingNotes id="setting-options" problems={general} />
		</fieldset>
	);
}

/** A choice's value made from its label: `Very hard` gives `very-hard`. */
function optionValue(label: string): string {
	return label
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** A regular expression the whole value must match, in the syntax the server's linear-time engine reads. */
function PatternSetting({
	value,
	problems,
	onChange,
}: {
	value: string | null;
	problems: SettingProblems;
	onChange(pattern: string | null): void;
}) {
	return (
		<SettingField
			id="setting-pattern"
			label="postTypes.settings.pattern"
			help="postTypes.settings.patternHelp"
			problems={problems}
		>
			{(described) => (
				<Input
					id="setting-pattern"
					value={value ?? ""}
					maxLength={PATTERN_MAX_LENGTH}
					autoComplete="off"
					spellCheck={false}
					className="font-mono"
					aria-describedby={described}
					aria-invalid={problems.length > 0 ? true : undefined}
					onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
				/>
			)}
		</SettingField>
	);
}

/** A number setting; empty means none. */
function NumberSetting({
	id,
	label,
	value,
	whole,
	problems,
	onChange,
}: {
	id: string;
	label: MessageKey;
	value: number | null;
	whole?: boolean;
	problems: SettingProblems;
	onChange(value: number | null): void;
}) {
	return (
		<SettingField id={id} label={label} problems={problems}>
			{(described) => (
				<Input
					id={id}
					type="number"
					inputMode={whole ? "numeric" : "decimal"}
					step={whole ? 1 : "any"}
					min={whole ? 0 : undefined}
					value={value ?? ""}
					aria-describedby={described}
					aria-invalid={problems.length > 0 ? true : undefined}
					onChange={(event) => {
						const typed = event.target.value.trim();
						onChange(typed === "" || !Number.isFinite(Number(typed)) ? null : Number(typed));
					}}
				/>
			)}
		</SettingField>
	);
}

/** A setting's label, control, help text and problems. */
function SettingField({
	id,
	label,
	help,
	problems,
	children,
}: {
	id: string;
	label: MessageKey;
	help?: MessageKey;
	problems: SettingProblems;
	children(describedBy: string | undefined): ReactNode;
}) {
	const t = useT();
	const described =
		[help ? `${id}-help` : null, problems.length > 0 ? `${id}-problems` : null].filter(Boolean).join(" ") || undefined;
	return (
		<div className="grid content-start gap-1.5">
			<Label htmlFor={id}>{t(label)}</Label>
			{children(described)}
			{help ? (
				<p id={`${id}-help`} className="text-muted-foreground text-sm">
					{t(help)}
				</p>
			) : null}
			<SettingNotes id={id} problems={problems} />
		</div>
	);
}

/** A setting that is on or off, with what it means. */
function SettingCheckbox({
	id,
	label,
	help,
	checked,
	onChange,
	problems,
}: {
	id: string;
	label: MessageKey;
	help?: MessageKey;
	checked: boolean;
	onChange(checked: boolean): void;
	problems: SettingProblems;
}) {
	const t = useT();
	const described =
		[help ? `${id}-help` : null, problems.length > 0 ? `${id}-problems` : null].filter(Boolean).join(" ") || undefined;
	return (
		<div className="grid gap-1">
			<div className="flex items-start gap-2">
				<Checkbox
					id={id}
					checked={checked}
					onCheckedChange={(value) => onChange(value === true)}
					aria-describedby={described}
					className="mt-0.5"
				/>
				<div className="grid gap-0.5">
					<Label htmlFor={id}>{t(label)}</Label>
					{help ? (
						<p id={`${id}-help`} className="text-muted-foreground text-sm">
							{t(help)}
						</p>
					) : null}
				</div>
			</div>
			<SettingNotes id={id} problems={problems} />
		</div>
	);
}

/** What the server said is wrong with a setting. */
function SettingNotes({ id, problems }: { id: string; problems: SettingProblems }) {
	if (problems.length === 0) return null;
	return (
		<ul id={`${id}-problems`} className="text-destructive grid gap-1 text-sm">
			{problems.map((problem) => (
				<li key={`${problem.setting}:${problem.message}`} className="flex items-start gap-1.5">
					<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<span>{problem.message}</span>
				</li>
			))}
		</ul>
	);
}
