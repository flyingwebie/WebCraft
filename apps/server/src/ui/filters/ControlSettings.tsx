import {
	FILTER_DATE_PRESETS,
	FILTER_LIMITS,
	type FilterControl,
	type FilterText,
	type SortOption,
} from "@webcraft/renderer/filters";
import { filterWords } from "@webcraft/renderer/filters/words";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { Announcer } from "../content/reorder.tsx";
import { type MessageKey, useT } from "../i18n.tsx";
import { type FilterProblem, type FilterSources, keyFrom, moveItem, optionalText } from "./model.ts";
import { Segmented } from "./Segmented.tsx";

/**
 * The selected control's settings, as its type has them: where its options come from, its label and
 * URL key, how options match and what shows for one nothing matches, a range's slider or date presets,
 * a sort menu's sorts, the count's words. Each problem the server answered shows under its setting.
 * Below them, the markup that shows this one control on its own elsewhere on the page.
 */
export function ControlSettings({
	control,
	index,
	onChange,
	sources,
	searching,
	filterName,
	loop,
	language,
	problems,
}: {
	control: FilterControl;
	index: number;
	onChange(control: FilterControl): void;
	sources: FilterSources | null;
	/** Whether the Filter has a search box: only then can a sort be by relevance. */
	searching: boolean;
	filterName: string;
	loop: string;
	/** The Site's Default language, which WebCraft's own words show in. */
	language: string;
	problems: readonly FilterProblem[];
}) {
	const t = useT();
	const id = `filter-control-${index}`;
	const words = filterWords(language);
	const problemAt = (setting: string) =>
		problems.find(
			(problem) =>
				problem.at === `controls[${index}].${setting}` || problem.at.startsWith(`controls[${index}].${setting}.`),
		)?.message;
	const general = problems.find(
		(problem) => problem.at === `controls[${index}]` || problem.at === `controls[${index}].type`,
	);
	const set = (change: Partial<FilterControl>) => onChange({ ...control, ...change } as FilterControl);

	/** A text setting: required words, or optional ones that show WebCraft's words while empty. */
	const text = (setting: string, label: MessageKey, value: FilterText | null, fallback?: string, help?: MessageKey) => {
		const problem = problemAt(setting);
		const fieldId = `${id}-${setting}`;
		return (
			<Field data-invalid={problem ? true : undefined}>
				<FieldLabel htmlFor={fieldId}>{t(label)}</FieldLabel>
				<Input
					id={fieldId}
					value={value?.text ?? ""}
					placeholder={fallback}
					aria-invalid={problem ? true : undefined}
					aria-describedby={help || fallback ? `${fieldId}-help` : undefined}
					onChange={(event) =>
						set({
							[setting]:
								fallback === undefined
									? { ...(value ?? {}), text: event.target.value }
									: optionalText(value, event.target.value),
						} as Partial<FilterControl>)
					}
				/>
				{help || fallback ? (
					<FieldDescription id={`${fieldId}-help`}>
						{help ? t(help) : t("filters.settings.webcraftWords", { words: fallback ?? "" })}
					</FieldDescription>
				) : null}
				{problem ? <FieldError>{problem}</FieldError> : null}
			</Field>
		);
	};

	const keyField = () => {
		if (!("key" in control)) return null;
		const problem = problemAt("key");
		return (
			<Field data-invalid={problem ? true : undefined}>
				<FieldLabel htmlFor={`${id}-key`}>{t("filters.settings.key")}</FieldLabel>
				<Input
					id={`${id}-key`}
					value={control.key}
					className="font-mono"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={problem ? true : undefined}
					aria-describedby={`${id}-key-help`}
					onChange={(event) => set({ key: event.target.value } as Partial<FilterControl>)}
				/>
				<FieldDescription id={`${id}-key-help`}>
					{t("filters.settings.keyHelp", { example: exampleOf(control) })}
				</FieldDescription>
				{problem ? <FieldError>{problem}</FieldError> : null}
			</Field>
		);
	};

	const placement = `{{@filter ${filterName} for="${loop}" control="${control.id}"}}`;

	return (
		<FieldGroup>
			{general ? <FieldError>{general.message}</FieldError> : null}
			{control.type === "checkboxes" || control.type === "choice" ? (
				<>
					<Field data-invalid={problemAt("source") ? true : undefined}>
						<FieldLabel htmlFor={`${id}-source`}>{t("filters.settings.source")}</FieldLabel>
						<NativeSelect
							id={`${id}-source`}
							value={control.source.kind === "field" ? `field:${control.source.field}` : "postType"}
							aria-describedby={`${id}-source-help`}
							onChange={(event) => {
								const value = event.target.value;
								const option = sources?.options.find((each) => `field:${each.field}` === value);
								set({
									source: option ? { kind: "field", field: option.field } : { kind: "postType" },
									label: { ...control.label, text: option?.label ?? t("filters.settings.postTypes") },
								});
							}}
						>
							{control.source.kind === "field" &&
							!sources?.options.some(
								(each) => control.source.kind === "field" && each.field === control.source.field,
							) ? (
								<NativeSelectOption value={`field:${control.source.field}`}>{control.source.field}</NativeSelectOption>
							) : null}
							{(sources?.options ?? []).map((option) => (
								<NativeSelectOption key={option.field} value={`field:${option.field}`}>
									{t(`filters.settings.sourceOf.${option.type}`, { label: option.label, field: option.field })}
								</NativeSelectOption>
							))}
							<NativeSelectOption value="postType">{t("filters.settings.postTypes")}</NativeSelectOption>
						</NativeSelect>
						<FieldDescription id={`${id}-source-help`}>{t("filters.settings.sourceHelp")}</FieldDescription>
						{problemAt("source") ? <FieldError>{problemAt("source")}</FieldError> : null}
					</Field>
					{text("label", "filters.settings.label", control.label, undefined, "filters.settings.labelHelp")}
					{keyField()}
					{control.type === "checkboxes" ? (
						<div className="grid gap-2">
							<p id={`${id}-match-label`} className="text-sm font-medium">
								{t("filters.settings.match")}
							</p>
							<Segmented
								labelledBy={`${id}-match-label`}
								value={control.match}
								onChange={(match) => set({ match })}
								options={[
									{ value: "any", label: t("filters.settings.matchAny") },
									{ value: "all", label: t("filters.settings.matchAll") },
								]}
							/>
						</div>
					) : (
						<div className="grid gap-2">
							<p id={`${id}-display-label`} className="text-sm font-medium">
								{t("filters.settings.display")}
							</p>
							<Segmented
								labelledBy={`${id}-display-label`}
								value={control.display}
								onChange={(display) => set({ display })}
								options={[
									{ value: "radio", label: t("filters.settings.displayRadio") },
									{ value: "select", label: t("filters.settings.displaySelect") },
								]}
							/>
						</div>
					)}
					<div className="flex items-start gap-2">
						<Checkbox
							id={`${id}-counts`}
							checked={control.counts}
							onCheckedChange={(counts) => set({ counts: counts === true })}
							aria-describedby={`${id}-counts-help`}
							className="mt-0.5"
						/>
						<div className="grid gap-1">
							<FieldLabel htmlFor={`${id}-counts`}>{t("filters.settings.counts")}</FieldLabel>
							<FieldDescription id={`${id}-counts-help`}>{t("filters.settings.countsHelp")}</FieldDescription>
						</div>
					</div>
					<div className="grid gap-2">
						<p id={`${id}-empty-label`} className="text-sm font-medium">
							{t("filters.settings.empty")}
						</p>
						<Segmented
							labelledBy={`${id}-empty-label`}
							value={control.empty}
							onChange={(empty) => set({ empty })}
							options={[
								{ value: "hide", label: t("filters.settings.emptyHide") },
								{ value: "disable", label: t("filters.settings.emptyDisable") },
								{ value: "show", label: t("filters.settings.emptyShow") },
							]}
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						{control.type === "checkboxes" ? (
							<Field data-invalid={problemAt("showFirst") ? true : undefined}>
								<FieldLabel htmlFor={`${id}-show-first`}>{t("filters.settings.showFirst")}</FieldLabel>
								<Input
									id={`${id}-show-first`}
									type="number"
									min={1}
									max={FILTER_LIMITS.showFirst}
									value={control.showFirst}
									aria-describedby={`${id}-show-first-help`}
									onChange={(event) => set({ showFirst: Number(event.target.value) || 1 })}
								/>
								<FieldDescription id={`${id}-show-first-help`}>{t("filters.settings.showFirstHelp")}</FieldDescription>
								{problemAt("showFirst") ? <FieldError>{problemAt("showFirst")}</FieldError> : null}
							</Field>
						) : (
							text("allLabel", "filters.settings.allLabel", control.allLabel, words.all)
						)}
						<Field>
							<FieldLabel htmlFor={`${id}-order`}>{t("filters.settings.order")}</FieldLabel>
							<NativeSelect
								id={`${id}-order`}
								value={control.order}
								onChange={(event) => set({ order: event.target.value as typeof control.order })}
							>
								<NativeSelectOption value="source">{t("filters.settings.orderSource")}</NativeSelectOption>
								<NativeSelectOption value="label">{t("filters.settings.orderLabel")}</NativeSelectOption>
								<NativeSelectOption value="count">{t("filters.settings.orderCount")}</NativeSelectOption>
							</NativeSelect>
						</Field>
					</div>
				</>
			) : null}

			{control.type === "toggle" ? (
				<>
					<Field data-invalid={problemAt("field") ? true : undefined}>
						<FieldLabel htmlFor={`${id}-field`}>{t("filters.settings.toggleField")}</FieldLabel>
						<NativeSelect
							id={`${id}-field`}
							value={control.field}
							onChange={(event) => {
								const found = sources?.toggles.find((each) => each.field === event.target.value);
								set({
									field: event.target.value,
									label: { ...control.label, text: found?.label ?? control.label.text },
								});
							}}
						>
							{fieldChoices(control.field, sources?.toggles ?? [], t("filters.settings.chooseField"))}
						</NativeSelect>
						{problemAt("field") ? <FieldError>{problemAt("field")}</FieldError> : null}
					</Field>
					{text("label", "filters.settings.label", control.label, undefined, "filters.settings.labelHelp")}
					{keyField()}
				</>
			) : null}

			{control.type === "range" ? (
				<RangeSettings
					id={id}
					control={control}
					set={set}
					sources={sources}
					problemAt={problemAt}
					text={text}
					keyField={keyField}
					words={words}
				/>
			) : null}

			{control.type === "search" ? (
				<>
					{text("label", "filters.settings.label", control.label, words.search)}
					{text("placeholder", "filters.settings.placeholder", control.placeholder, "")}
					<p className="text-muted-foreground text-sm">{t("filters.settings.searchHelp")}</p>
				</>
			) : null}

			{control.type === "sort" ? (
				<>
					{text("label", "filters.settings.label", control.label, words.sort)}
					{keyField()}
					{text("defaultLabel", "filters.settings.defaultLabel", control.defaultLabel, words.sortDefault)}
					<SortOptions
						id={id}
						options={control.options}
						onChange={(options) => set({ options })}
						sources={sources}
						searching={searching}
						problemAt={problemAt}
					/>
				</>
			) : null}

			{control.type === "chips" ? (
				<>
					{text("label", "filters.settings.chipsLabel", control.label, words.activeFilters)}
					{text("resetLabel", "filters.settings.resetLabel", control.resetLabel, words.reset)}
				</>
			) : null}

			{control.type === "count" ? (
				<>
					{text("one", "filters.settings.countOne", control.one, words.one)}
					{text("other", "filters.settings.countOther", control.other, words.other, "filters.settings.countHelp")}
					{text("none", "filters.settings.countNone", control.none, words.none)}
				</>
			) : null}

			<PlaceApart markup={placement} />
		</FieldGroup>
	);
}

/** An example of what a control's key keeps in a page's address. */
function exampleOf(control: FilterControl): string {
	switch (control.type) {
		case "checkboxes":
			return `?${control.key}=bread,pastries`;
		case "choice":
			return `?${control.key}=bread`;
		case "toggle":
			return `?${control.key}=1`;
		case "range":
			return control.kind === "date" ? `?${control.key}=2026-01-01..2026-03-31` : `?${control.key}=2-10`;
		case "sort":
			return `?${control.key}=${control.options[0]?.value ?? "price-asc"}`;
		default:
			return "";
	}
}

/** A Field chooser's options: the Fields that fit, and the one chosen even when it no longer fits. */
function fieldChoices(current: string, fields: readonly { field: string; label: string }[], none: string) {
	return [
		current === "" ? (
			<NativeSelectOption key="" value="">
				{none}
			</NativeSelectOption>
		) : null,
		current !== "" && !fields.some((each) => each.field === current) ? (
			<NativeSelectOption key={current} value={current}>
				{current}
			</NativeSelectOption>
		) : null,
		...fields.map((each) => (
			<NativeSelectOption key={each.field} value={each.field}>
				{`${each.label} (${each.field})`}
			</NativeSelectOption>
		)),
	];
}

type RangeControl = Extract<FilterControl, { type: "range" }>;

/** A range's settings: its Field, words and key, then a slider for numbers or presets for days. */
function RangeSettings({
	id,
	control,
	set,
	sources,
	problemAt,
	text,
	keyField,
	words,
}: {
	id: string;
	control: RangeControl;
	set(change: Partial<RangeControl>): void;
	sources: FilterSources | null;
	problemAt(setting: string): string | undefined;
	text(
		setting: string,
		label: MessageKey,
		value: FilterText | null,
		fallback?: string,
		help?: MessageKey,
	): React.ReactNode;
	keyField(): React.ReactNode;
	words: ReturnType<typeof filterWords>;
}) {
	const t = useT();
	const slider = control.slider;
	const setSlider = (part: "min" | "max" | "step", value: string) =>
		set({ slider: { ...(slider ?? { min: 0, max: 100, step: 1 }), [part]: Number(value) } });
	return (
		<>
			<Field data-invalid={problemAt("field") ? true : undefined}>
				<FieldLabel htmlFor={`${id}-field`}>{t("filters.settings.rangeField")}</FieldLabel>
				<NativeSelect
					id={`${id}-field`}
					value={control.field}
					onChange={(event) => {
						const found = sources?.ranges.find((each) => each.field === event.target.value);
						const kind = found?.kind ?? control.kind;
						set({
							field: event.target.value,
							kind,
							label: { ...control.label, text: found?.label ?? control.label.text },
							slider: kind === "number" ? control.slider : null,
							presets: kind === "date" ? control.presets : [],
						});
					}}
				>
					{fieldChoices(control.field, sources?.ranges ?? [], t("filters.settings.chooseField"))}
				</NativeSelect>
				{problemAt("field") ? <FieldError>{problemAt("field")}</FieldError> : null}
			</Field>
			{text("label", "filters.settings.label", control.label, undefined, "filters.settings.labelHelp")}
			{keyField()}
			<div className="grid gap-4 sm:grid-cols-2">
				{text("minLabel", "filters.settings.minLabel", control.minLabel, words.from)}
				{text("maxLabel", "filters.settings.maxLabel", control.maxLabel, words.to)}
			</div>
			{control.kind === "number" ? (
				<fieldset className="grid gap-3">
					<legend className="mb-2 text-sm font-medium">{t("filters.settings.slider")}</legend>
					<div className="flex items-start gap-2">
						<Checkbox
							id={`${id}-slider`}
							checked={slider !== null}
							onCheckedChange={(on) => set({ slider: on === true ? { min: 0, max: 100, step: 1 } : null })}
							aria-describedby={`${id}-slider-help`}
							className="mt-0.5"
						/>
						<div className="grid gap-1">
							<FieldLabel htmlFor={`${id}-slider`}>{t("filters.settings.sliderOn")}</FieldLabel>
							<FieldDescription id={`${id}-slider-help`}>{t("filters.settings.sliderHelp")}</FieldDescription>
						</div>
					</div>
					{slider ? (
						<div className="grid gap-4 sm:grid-cols-3">
							{(["min", "max", "step"] as const).map((part) => (
								<Field key={part}>
									<FieldLabel htmlFor={`${id}-slider-${part}`}>
										{t(`filters.settings.slider${part === "min" ? "Min" : part === "max" ? "Max" : "Step"}`)}
									</FieldLabel>
									<Input
										id={`${id}-slider-${part}`}
										type="number"
										step="any"
										value={slider[part]}
										onChange={(event) => setSlider(part, event.target.value)}
									/>
								</Field>
							))}
						</div>
					) : null}
					{problemAt("slider") ? <FieldError>{problemAt("slider")}</FieldError> : null}
				</fieldset>
			) : (
				<fieldset className="grid gap-2">
					<legend className="mb-2 text-sm font-medium">{t("filters.settings.presets")}</legend>
					<p id={`${id}-presets-help`} className="text-muted-foreground text-sm">
						{t("filters.settings.presetsHelp")}
					</p>
					<ul className="grid gap-2 sm:grid-cols-2">
						{FILTER_DATE_PRESETS.map((preset) => (
							<li key={preset} className="flex items-center gap-2">
								<Checkbox
									id={`${id}-preset-${preset}`}
									checked={control.presets.includes(preset)}
									onCheckedChange={(on) =>
										set({
											presets:
												on === true
													? FILTER_DATE_PRESETS.filter((each) => each === preset || control.presets.includes(each))
													: control.presets.filter((each) => each !== preset),
										})
									}
								/>
								<FieldLabel htmlFor={`${id}-preset-${preset}`}>{words.presets[preset]}</FieldLabel>
							</li>
						))}
					</ul>
					{problemAt("presets") ? <FieldError>{problemAt("presets")}</FieldError> : null}
				</fieldset>
			)}
		</>
	);
}

/** A sort menu's sorts: each one's words, URL value, what it sorts by and which way; added, moved and removed. */
function SortOptions({
	id,
	options,
	onChange,
	sources,
	searching,
	problemAt,
}: {
	id: string;
	options: readonly SortOption[];
	onChange(options: SortOption[]): void;
	sources: FilterSources | null;
	searching: boolean;
	problemAt(setting: string): string | undefined;
}) {
	const t = useT();
	const [said, setSaid] = useState("");
	const sorts = [
		...(sources?.sorts ?? []).map((sort) => ({
			by: sort.by,
			label: sort.label ?? t(`filters.settings.sortBy.${sort.by as "title"}`),
		})),
		...(searching ? [{ by: "relevance", label: t("filters.settings.sortBy.relevance") }] : []),
	];
	const change = (index: number, part: Partial<SortOption>) =>
		onChange(options.map((option, at) => (at === index ? { ...option, ...part } : option)));
	const move = (index: number, by: -1 | 1) => {
		const target = index + by;
		const option = options[index];
		if (!option || target < 0 || target >= options.length) return;
		onChange(moveItem(options, index, target));
		setSaid(t("filters.controls.movedSort", { label: option.label.text, place: target + 1, count: options.length }));
	};
	const add = () => {
		const used = new Set(options.map((option) => option.value));
		const first = sorts[0] ?? { by: "title", label: "" };
		onChange([
			...options,
			{
				value: keyFrom(`${first.by}-asc`, used),
				label: { text: first.label },
				by: first.by,
				direction: "asc",
			},
		]);
	};
	return (
		<fieldset className="grid gap-3">
			<legend className="mb-2 text-sm font-medium">{t("filters.settings.sorts")}</legend>
			{problemAt("options") ? <FieldError>{problemAt("options")}</FieldError> : null}
			<ol className="grid gap-3">
				{options.map((option, index) => {
					const at = `${id}-sort-${index}`;
					const problem = problemAt(`options[${index}]`);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: sorts are edited in place, their values can repeat while typing.
						<li key={index} className="grid gap-3 rounded-md border p-3">
							<p className="text-sm font-medium">{t("filters.settings.sortNumber", { number: index + 1 })}</p>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor={`${at}-label`}>{t("filters.settings.sortLabel")}</FieldLabel>
									<Input
										id={`${at}-label`}
										value={option.label.text}
										onChange={(event) => change(index, { label: { ...option.label, text: event.target.value } })}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${at}-value`}>{t("filters.settings.sortValue")}</FieldLabel>
									<Input
										id={`${at}-value`}
										value={option.value}
										className="font-mono"
										spellCheck={false}
										onChange={(event) => change(index, { value: event.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${at}-by`}>{t("filters.settings.sortByLabel")}</FieldLabel>
									<NativeSelect
										id={`${at}-by`}
										value={option.by}
										onChange={(event) => change(index, { by: event.target.value })}
									>
										{sorts.some((sort) => sort.by === option.by) ? null : (
											<NativeSelectOption value={option.by}>{option.by}</NativeSelectOption>
										)}
										{sorts.map((sort) => (
											<NativeSelectOption key={sort.by} value={sort.by}>
												{sort.label}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${at}-direction`}>{t("filters.settings.sortDirection")}</FieldLabel>
									<NativeSelect
										id={`${at}-direction`}
										value={option.direction}
										onChange={(event) => change(index, { direction: event.target.value as "asc" | "desc" })}
									>
										<NativeSelectOption value="asc">{t("filters.settings.ascending")}</NativeSelectOption>
										<NativeSelectOption value="desc">{t("filters.settings.descending")}</NativeSelectOption>
									</NativeSelect>
								</Field>
							</div>
							{problem ? <FieldError>{problem}</FieldError> : null}
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={index === 0}
									onClick={() => move(index, -1)}
								>
									<ArrowUpIcon data-icon="inline-start" />
									{t("filters.controls.moveUp")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={index === options.length - 1}
									onClick={() => move(index, 1)}
								>
									<ArrowDownIcon data-icon="inline-start" />
									{t("filters.controls.moveDown")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={options.length === 1}
									onClick={() => onChange(options.filter((_, at) => at !== index))}
								>
									<TrashIcon data-icon="inline-start" />
									{t("filters.settings.removeSort", { label: option.label.text })}
								</Button>
							</div>
						</li>
					);
				})}
			</ol>
			<Button
				type="button"
				variant="outline"
				className="w-fit"
				disabled={options.length >= FILTER_LIMITS.sorts}
				onClick={add}
			>
				<PlusIcon data-icon="inline-start" />
				{t("filters.settings.addSort")}
			</Button>
			<Announcer message={said} />
		</fieldset>
	);
}

/** The markup showing this one control on its own elsewhere on the page, with a Copy button. */
function PlaceApart({ markup }: { markup: string }) {
	const t = useT();
	const [said, setSaid] = useState("");
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(markup);
			setSaid(t("filters.settings.copied"));
		} catch {
			setSaid(t("filters.settings.copyFailed"));
		}
	};
	return (
		<div className="bg-muted/50 grid gap-2 rounded-md border p-3">
			<p className="text-sm font-medium">{t("filters.settings.placeApart")}</p>
			<p className="text-muted-foreground text-sm">{t("filters.settings.placeApartHelp")}</p>
			<div className="flex flex-wrap items-center gap-2">
				<code className="bg-background rounded border px-2 py-1 font-mono text-xs break-all">{markup}</code>
				<Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
					<CopyIcon data-icon="inline-start" />
					{t("filters.settings.copy")}
				</Button>
			</div>
			<Announcer message={said} />
		</div>
	);
}
