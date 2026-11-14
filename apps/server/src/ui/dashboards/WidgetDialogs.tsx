import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { ArrowLeftIcon, CopyIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useT } from "../i18n.tsx";
import {
	type CatalogKind,
	type DashboardPlace,
	type DashboardRange,
	dashboardsApi,
	RANGE_PRESETS,
	type WidgetFilters,
	type WidgetView,
} from "./model.ts";

/** The range fields: a moving range, or two days (custom). */
export function RangeFields({
	range,
	onChange,
	id,
	label,
}: {
	range: DashboardRange;
	onChange: (range: DashboardRange) => void;
	id: string;
	label: string;
}) {
	const t = useT();
	const today = new Date().toISOString().slice(0, 10);
	return (
		<div className="flex flex-wrap items-end gap-3">
			<Field className="w-auto">
				<FieldLabel htmlFor={`${id}-preset`}>{label}</FieldLabel>
				<NativeSelect
					id={`${id}-preset`}
					value={range.preset}
					onChange={(change) => {
						const preset = change.target.value;
						onChange(
							preset === "custom"
								? {
										preset: "custom",
										from: range.preset === "custom" ? range.from : today,
										to: range.preset === "custom" ? range.to : today,
									}
								: { preset: preset as (typeof RANGE_PRESETS)[number] },
						);
					}}
				>
					{RANGE_PRESETS.map((preset) => (
						<NativeSelectOption key={preset} value={preset}>
							{t(`dashboards.presets.${preset}`)}
						</NativeSelectOption>
					))}
					<NativeSelectOption value="custom">{t("dashboards.presets.custom")}</NativeSelectOption>
				</NativeSelect>
			</Field>
			{range.preset === "custom" ? (
				<>
					<Field className="w-auto">
						<FieldLabel htmlFor={`${id}-from`}>{t("dashboards.customFrom")}</FieldLabel>
						<Input
							id={`${id}-from`}
							type="date"
							value={range.from}
							max={range.to}
							onChange={(change) => change.target.value && onChange({ ...range, from: change.target.value })}
						/>
					</Field>
					<Field className="w-auto">
						<FieldLabel htmlFor={`${id}-to`}>{t("dashboards.customTo")}</FieldLabel>
						<Input
							id={`${id}-to`}
							type="date"
							value={range.to}
							min={range.from}
							onChange={(change) => change.target.value && onChange({ ...range, to: change.target.value })}
						/>
					</Field>
				</>
			) : null}
		</div>
	);
}

/** Whether a new Widget of this kind needs a choice before it can count (a Goal, a Funnel). */
export function needsChoice(kind: CatalogKind): boolean {
	return kind.shape === "note" || kind.settings.some((setting) => setting.options === null && !setting.multiple);
}

type Options = { value: string; label: string }[];

/** A setting's options here: fixed ones from the catalog, or asked for (the Site's Goals, its Funnels). */
function useOptions(place: DashboardPlace, kind: CatalogKind, setting: string, fixed: Options | null): Options | null {
	const [options, setOptions] = useState<Options | null>(fixed);
	// The place as text: a new object for the same place mustn't ask again.
	const where = JSON.stringify(place);
	useEffect(() => {
		if (fixed) return;
		let live = true;
		void dashboardsApi()
			.then((api) => api.options({ ...(JSON.parse(where) as DashboardPlace), kind: kind.kind, setting }))
			.then((answer) => live && setOptions(answer.options))
			.catch(() => live && setOptions([]));
		return () => {
			live = false;
		};
	}, [where, kind.kind, setting, fixed]);
	return options;
}

function SettingField({
	place,
	kind,
	setting,
	value,
	onChange,
}: {
	place: DashboardPlace;
	kind: CatalogKind;
	setting: CatalogKind["settings"][number];
	value: string | string[] | undefined;
	onChange: (value: string | string[] | undefined) => void;
}) {
	const t = useT();
	const id = useId();
	const options = useOptions(place, kind, setting.key, setting.options);
	if (setting.multiple) {
		const chosen = new Set(typeof value === "string" ? [value] : (value ?? []));
		return (
			<FieldSet>
				<FieldLegend variant="label" className="text-muted-foreground text-xs">
					{setting.label}
				</FieldLegend>
				{options === null ? <p className="text-muted-foreground text-sm">{t("dashboards.optionsLoading")}</p> : null}
				{options?.length === 0 ? <p className="text-muted-foreground text-sm">{t("dashboards.noOptions")}</p> : null}
				<div className="grid gap-2">
					{(options ?? []).map((option) => (
						<Field key={option.value} orientation="horizontal">
							<Checkbox
								id={`${id}-${option.value}`}
								checked={chosen.has(option.value)}
								onCheckedChange={(checked) => {
									const next = new Set(chosen);
									if (checked) next.add(option.value);
									else next.delete(option.value);
									onChange([...next]);
								}}
							/>
							<FieldLabel htmlFor={`${id}-${option.value}`} className="font-normal">
								{option.label}
							</FieldLabel>
						</Field>
					))}
				</div>
			</FieldSet>
		);
	}
	const single = typeof value === "string" ? value : (value?.[0] ?? "");
	const known = (options ?? []).some((option) => option.value === single);
	return (
		<Field className="gap-2">
			<FieldLabel htmlFor={id}>{setting.label}</FieldLabel>
			<NativeSelect
				id={id}
				className="w-full"
				value={single}
				onChange={(change) => onChange(change.target.value || undefined)}
			>
				<NativeSelectOption value="">
					{options === null ? t("dashboards.optionsLoading") : t("dashboards.choose")}
				</NativeSelectOption>
				{single && !known && options !== null ? (
					<NativeSelectOption value={single}>{t("dashboards.missingOption", { name: single })}</NativeSelectOption>
				) : null}
				{(options ?? []).map((option) => (
					<NativeSelectOption key={option.value} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Field>
	);
}

/** The Goal filter: the Goals this place offers, or any visitor. */
function GoalFilter({
	place,
	kind,
	value,
	onChange,
}: {
	place: DashboardPlace;
	kind: CatalogKind;
	value: string | undefined;
	onChange: (value: string | undefined) => void;
}) {
	const t = useT();
	const id = useId();
	const options = useOptions(place, kind, "filter:goal", null);
	const known = (options ?? []).some((option) => option.value.toLowerCase() === (value ?? "").toLowerCase());
	return (
		<Field className="gap-2">
			<FieldLabel htmlFor={id}>{t("dashboards.goalFilter")}</FieldLabel>
			<NativeSelect
				id={id}
				className="w-full"
				value={value ?? ""}
				onChange={(change) => onChange(change.target.value || undefined)}
			>
				<NativeSelectOption value="">{t("dashboards.any")}</NativeSelectOption>
				{value && !known && options !== null ? (
					<NativeSelectOption value={value}>{t("dashboards.missingOption", { name: value })}</NativeSelectOption>
				) : null}
				{(options ?? []).map((option) => (
					<NativeSelectOption key={option.value} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Field>
	);
}

/** What the settings panel changes on a Widget. */
export type WidgetFields = {
	title: string | null;
	range: DashboardRange | null;
	filters: WidgetFilters;
	settings: Record<string, string | string[]>;
	rows: number;
};

export function fieldsOf(widget: WidgetView): WidgetFields {
	return {
		title: widget.title,
		range: widget.range,
		filters: widget.filters,
		settings: widget.settings,
		rows: widget.rows,
	};
}

/** A small label above a group of fields ("Filters"). */
function GroupLabel({ children }: { children: string }) {
	return <p className="text-muted-foreground pt-1 text-xs font-medium">{children}</p>;
}

/**
 * A Widget's settings, in the library's place while arranging (SPEC 14.3): its title, its range (the
 * Dashboard's or its own), what it shows, its filters (those its kind takes), rows for lists, and
 * Duplicate and Remove. The Widget on the grid follows as they change: each change is saved a moment
 * after the last keystroke, as one step Undo takes back.
 */
export function WidgetSettingsPanel({
	place,
	widget,
	kind,
	onChange,
	onBack,
	onDuplicate,
	onRemove,
}: {
	place: DashboardPlace;
	widget: WidgetView;
	kind: CatalogKind | undefined;
	onChange: (fields: WidgetFields) => void;
	onBack: () => void;
	onDuplicate: () => void;
	onRemove: () => void;
}) {
	const t = useT();
	const id = useId();
	const back = useRef<HTMLButtonElement>(null);
	const [fields, setFields] = useState<WidgetFields>(() => fieldsOf(widget));
	const sent = useRef(JSON.stringify(fieldsOf(widget)));
	const change = useRef(onChange);
	change.current = onChange;
	// Saved a moment after the last change, and at once when the panel closes.
	const latest = useRef(fields);
	latest.current = fields;
	useEffect(() => {
		const text = JSON.stringify(fields);
		if (text === sent.current) return;
		const timer = window.setTimeout(() => {
			sent.current = text;
			change.current(fields);
		}, 450);
		return () => window.clearTimeout(timer);
	}, [fields]);
	useEffect(
		() => () => {
			const text = JSON.stringify(latest.current);
			if (text !== sent.current) change.current(latest.current);
		},
		[],
	);
	useEffect(() => {
		back.current?.focus();
	}, []);

	const { filters, settings } = fields;
	const update = (next: Partial<WidgetFields>) => setFields((before) => ({ ...before, ...next }));
	const takes = (filter: string) => (kind?.filters as readonly string[] | undefined)?.includes(filter) ?? false;
	const setFilter = <Key extends keyof WidgetFilters>(key: Key, value: WidgetFilters[Key] | undefined) =>
		setFields((before) => {
			const next = { ...before.filters };
			if (value === undefined || value === "") delete next[key];
			else next[key] = value;
			return { ...before, filters: next };
		});
	const today = new Date().toISOString().slice(0, 10);
	const range = fields.range;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1">
				<Button
					ref={back}
					variant="ghost"
					size="icon-sm"
					aria-label={t("dashboards.backToLibrary")}
					title={t("dashboards.backToLibrary")}
					onClick={onBack}
				>
					<ArrowLeftIcon aria-hidden="true" />
				</Button>
				<h2 id={`${id}-heading`} className="truncate text-sm font-semibold">
					{widget.label}
				</h2>
			</div>
			<FieldGroup className="mt-2 min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-4">
				<Field className="gap-2">
					<FieldLabel htmlFor={`${id}-title`}>{t("dashboards.title")}</FieldLabel>
					<Input
						id={`${id}-title`}
						value={fields.title ?? ""}
						placeholder={widget.label}
						maxLength={100}
						onChange={(event) => update({ title: event.target.value.trim() ? event.target.value : null })}
					/>
				</Field>
				{widget.shape === "note" ? (
					<Field className="gap-2">
						<FieldLabel htmlFor={`${id}-note`}>{t("dashboards.note")}</FieldLabel>
						<Textarea
							id={`${id}-note`}
							value={typeof settings.text === "string" ? settings.text : ""}
							maxLength={2000}
							rows={6}
							onChange={(event) => update({ settings: { text: event.target.value } })}
						/>
					</Field>
				) : (
					<>
						<Field className="gap-2">
							<FieldLabel htmlFor={`${id}-range`}>{t("dashboards.rangeChoice")}</FieldLabel>
							<NativeSelect
								id={`${id}-range`}
								className="w-full"
								value={range ? range.preset : ""}
								onChange={(event) => {
									const preset = event.target.value;
									update({
										range:
											preset === ""
												? null
												: preset === "custom"
													? {
															preset: "custom",
															from: range?.preset === "custom" ? range.from : today,
															to: range?.preset === "custom" ? range.to : today,
														}
													: { preset: preset as (typeof RANGE_PRESETS)[number] },
									});
								}}
							>
								<NativeSelectOption value="">{t("dashboards.rangeDashboard")}</NativeSelectOption>
								{RANGE_PRESETS.map((preset) => (
									<NativeSelectOption key={preset} value={preset}>
										{t(`dashboards.presets.${preset}`)}
									</NativeSelectOption>
								))}
								<NativeSelectOption value="custom">{t("dashboards.presets.custom")}</NativeSelectOption>
							</NativeSelect>
						</Field>
						{range?.preset === "custom" ? (
							<div className="grid gap-2">
								<Field className="gap-1.5">
									<FieldLabel htmlFor={`${id}-from`}>{t("dashboards.customFrom")}</FieldLabel>
									<Input
										id={`${id}-from`}
										type="date"
										value={range.from}
										max={range.to}
										onChange={(event) =>
											event.target.value && update({ range: { ...range, from: event.target.value } })
										}
									/>
								</Field>
								<Field className="gap-1.5">
									<FieldLabel htmlFor={`${id}-to`}>{t("dashboards.customTo")}</FieldLabel>
									<Input
										id={`${id}-to`}
										type="date"
										value={range.to}
										min={range.from}
										onChange={(event) => event.target.value && update({ range: { ...range, to: event.target.value } })}
									/>
								</Field>
							</div>
						) : null}
						{kind?.settings.map((setting) => (
							<SettingField
								key={setting.key}
								place={place}
								kind={kind}
								setting={setting}
								value={settings[setting.key]}
								onChange={(value) =>
									setFields((before) => {
										const next = { ...before.settings };
										if (value === undefined) delete next[setting.key];
										else next[setting.key] = value;
										return { ...before, settings: next };
									})
								}
							/>
						))}
						{widget.shape === "table" ? (
							<Field className="gap-2">
								<FieldLabel htmlFor={`${id}-rows`}>{t("dashboards.rows")}</FieldLabel>
								<NativeSelect
									id={`${id}-rows`}
									className="w-full"
									value={String(fields.rows)}
									onChange={(event) => update({ rows: Number(event.target.value) })}
								>
									{[5, 10, 20, 50].map((count) => (
										<NativeSelectOption key={count} value={String(count)}>
											{count}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</Field>
						) : null}
						{kind && kind.filters.length > 0 ? (
							<>
								<GroupLabel>{t("dashboards.filters")}</GroupLabel>
								{takes("page") ? (
									<>
										<Field className="gap-2">
											<FieldLabel htmlFor={`${id}-page`}>{t("dashboards.pagePath")}</FieldLabel>
											<Input
												id={`${id}-page`}
												value={filters.page?.path ?? ""}
												placeholder={t("dashboards.any")}
												maxLength={1000}
												onChange={(event) => {
													const path = event.target.value.trim();
													setFilter("page", path ? { path, match: filters.page?.match ?? "exact" } : undefined);
												}}
											/>
										</Field>
										{filters.page ? (
											<Field className="gap-2">
												<FieldLabel htmlFor={`${id}-match`}>{t("dashboards.pageMatch")}</FieldLabel>
												<NativeSelect
													id={`${id}-match`}
													className="w-full"
													value={filters.page.match}
													onChange={(event) =>
														filters.page &&
														setFilter("page", {
															path: filters.page.path,
															match: event.target.value === "prefix" ? "prefix" : "exact",
														})
													}
												>
													<NativeSelectOption value="exact">{t("dashboards.matchExact")}</NativeSelectOption>
													<NativeSelectOption value="prefix">{t("dashboards.matchPrefix")}</NativeSelectOption>
												</NativeSelect>
											</Field>
										) : null}
									</>
								) : null}
								{takes("source") ? (
									<Field className="gap-2">
										<FieldLabel htmlFor={`${id}-source`}>{t("dashboards.source")}</FieldLabel>
										<Input
											id={`${id}-source`}
											value={filters.source ?? ""}
											placeholder={t("dashboards.any")}
											maxLength={200}
											onChange={(event) => setFilter("source", event.target.value.trim() || undefined)}
										/>
									</Field>
								) : null}
								{takes("country") ? (
									<Field className="gap-2">
										<FieldLabel htmlFor={`${id}-country`}>{t("dashboards.country")}</FieldLabel>
										<Input
											id={`${id}-country`}
											value={filters.country ?? ""}
											placeholder={t("dashboards.any")}
											maxLength={2}
											className="uppercase placeholder:normal-case"
											aria-describedby={`${id}-country-help`}
											onChange={(event) => setFilter("country", event.target.value.trim().toUpperCase() || undefined)}
										/>
										<span id={`${id}-country-help`} className="sr-only">
											{t("dashboards.countryHelp")}
										</span>
									</Field>
								) : null}
								{takes("device") ? (
									<Field className="gap-2">
										<FieldLabel htmlFor={`${id}-device`}>{t("dashboards.device")}</FieldLabel>
										<NativeSelect
											id={`${id}-device`}
											className="w-full"
											value={filters.device ?? ""}
											onChange={(event) =>
												setFilter("device", (event.target.value || undefined) as WidgetFilters["device"] | undefined)
											}
										>
											<NativeSelectOption value="">{t("dashboards.any")}</NativeSelectOption>
											<NativeSelectOption value="desktop">{t("dashboards.devices.desktop")}</NativeSelectOption>
											<NativeSelectOption value="mobile">{t("dashboards.devices.mobile")}</NativeSelectOption>
											<NativeSelectOption value="tablet">{t("dashboards.devices.tablet")}</NativeSelectOption>
										</NativeSelect>
									</Field>
								) : null}
								{takes("goal") && kind ? (
									<GoalFilter
										place={place}
										kind={kind}
										value={filters.goal}
										onChange={(value) => setFilter("goal", value)}
									/>
								) : null}
							</>
						) : null}
					</>
				)}
			</FieldGroup>
			<div className="bg-background flex shrink-0 gap-2 border-t pt-3">
				<Button type="button" variant="outline" size="sm" className="px-2" onClick={onDuplicate}>
					<CopyIcon aria-hidden="true" />
					{t("dashboards.duplicate")}
				</Button>
				<Button type="button" variant="destructive" size="sm" className="px-2" onClick={onRemove}>
					<Trash2Icon aria-hidden="true" />
					{t("dashboards.removeWidget")}
				</Button>
			</div>
		</div>
	);
}
