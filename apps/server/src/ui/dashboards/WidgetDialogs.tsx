import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { type FormEvent, type RefObject, useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
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

/** Add a Widget: the catalog, each kind with what it shows; kinds whose Module is off here say so. */
export function WidgetPicker({
	catalog,
	onPick,
	onClose,
	finalFocus,
}: {
	catalog: readonly CatalogKind[];
	onPick: (kind: CatalogKind) => Promise<void>;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const [chosen, setChosen] = useState(catalog.find((kind) => kind.available)?.kind ?? "note");
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const kind = catalog.find((each) => each.kind === chosen);
		if (!kind) return;
		setBusy(true);
		try {
			await onPick(kind);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus} className="sm:max-w-2xl">
				<form onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>{t("dashboards.pickerTitle")}</DialogTitle>
						<DialogDescription>{t("dashboards.pickerIntro")}</DialogDescription>
					</DialogHeader>
					<FieldSet className="my-6 max-h-[55vh] overflow-y-auto pe-1">
						<FieldLegend className="sr-only">{t("dashboards.pickerKinds")}</FieldLegend>
						<RadioGroup value={chosen} onValueChange={(value) => setChosen(String(value))}>
							{catalog.map((kind) => (
								<Field key={kind.kind} orientation="horizontal">
									<RadioGroupItem
										value={kind.kind}
										id={`${id}-${kind.kind}`}
										aria-describedby={`${id}-${kind.kind}-help`}
									/>
									<div className="grid gap-1">
										<FieldLabel htmlFor={`${id}-${kind.kind}`}>
											{kind.label}
											<span className="text-muted-foreground text-xs font-normal">
												{t(`dashboards.shapes.${kind.shape}`)}
											</span>
										</FieldLabel>
										<FieldDescription id={`${id}-${kind.kind}-help`}>
											{kind.description}
											{kind.available ? null : ` ${t("dashboards.unavailable")}`}
										</FieldDescription>
									</div>
								</Field>
							))}
						</RadioGroup>
					</FieldSet>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("dashboards.add")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
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
				<FieldLegend variant="label">{setting.label}</FieldLegend>
				{options === null ? <p className="text-muted-foreground text-sm">{t("dashboards.optionsLoading")}</p> : null}
				{options?.length === 0 ? <p className="text-muted-foreground text-sm">{t("dashboards.noOptions")}</p> : null}
				<div className="grid gap-2 sm:grid-cols-2">
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
		<Field>
			<FieldLabel htmlFor={id}>{setting.label}</FieldLabel>
			<NativeSelect id={id} value={single} onChange={(change) => onChange(change.target.value || undefined)}>
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
		<Field>
			<FieldLabel htmlFor={id}>{t("dashboards.goal")}</FieldLabel>
			<NativeSelect id={id} value={value ?? ""} onChange={(change) => onChange(change.target.value || undefined)}>
				<NativeSelectOption value="">{t("dashboards.anyGoal")}</NativeSelectOption>
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

/** Edit a Widget: its title, days, filters (those its kind takes), settings, rows (tables) or note. */
export function WidgetSettingsDialog({
	place,
	dashboardId,
	widget,
	kind,
	onSaved,
	onClose,
	finalFocus,
}: {
	place: DashboardPlace;
	dashboardId: string;
	widget: WidgetView;
	kind: CatalogKind | undefined;
	onSaved: () => Promise<void>;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const [title, setTitle] = useState(widget.title ?? "");
	const [range, setRange] = useState<DashboardRange | null>(widget.range);
	const [filters, setFilters] = useState<WidgetFilters>(widget.filters);
	const [settings, setSettings] = useState<Record<string, string | string[]>>(widget.settings);
	const [rows, setRows] = useState(widget.rows);
	const [busy, setBusy] = useState(false);
	const takes = (filter: string) => (kind?.filters as readonly string[] | undefined)?.includes(filter) ?? false;
	const setFilter = <Key extends keyof WidgetFilters>(key: Key, value: WidgetFilters[Key] | undefined) =>
		setFilters((before) => {
			const next = { ...before };
			if (value === undefined || value === "") delete next[key];
			else next[key] = value;
			return next;
		});
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await dashboardsApi();
			await api.widgets.update({
				...place,
				dashboardId,
				widgetId: widget.id,
				title: title.trim() || null,
				range,
				filters,
				settings,
				...(widget.shape === "table" ? { rows } : {}),
			});
			toast.success(t("dashboards.savedToast"));
			await onSaved();
			onClose();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const label = widget.title || widget.label;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus} className="sm:max-w-2xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>{t("dashboards.editTitle", { title: label })}</DialogTitle>
						<DialogDescription>{t("dashboards.editIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 max-h-[60vh] gap-6 overflow-y-auto pe-1">
						<Field>
							<FieldLabel htmlFor={`${id}-title`}>{t("dashboards.title")}</FieldLabel>
							<Input
								id={`${id}-title`}
								value={title}
								maxLength={100}
								onChange={(change) => setTitle(change.target.value)}
								aria-describedby={`${id}-title-help`}
							/>
							<FieldDescription id={`${id}-title-help`}>
								{t("dashboards.titleHelp", { name: widget.label })}
							</FieldDescription>
						</Field>
						{widget.shape === "note" ? (
							<Field>
								<FieldLabel htmlFor={`${id}-note`}>{t("dashboards.note")}</FieldLabel>
								<Textarea
									id={`${id}-note`}
									value={typeof settings.text === "string" ? settings.text : ""}
									maxLength={2000}
									rows={5}
									onChange={(change) => setSettings({ text: change.target.value })}
									aria-describedby={`${id}-note-help`}
								/>
								<FieldDescription id={`${id}-note-help`}>{t("dashboards.noteHelp")}</FieldDescription>
							</Field>
						) : (
							<>
								<FieldSet>
									<FieldLegend variant="label">{t("dashboards.rangeChoice")}</FieldLegend>
									<RadioGroup
										value={range ? "own" : "dashboard"}
										onValueChange={(value) => setRange(value === "own" ? (range ?? { preset: "last30Days" }) : null)}
									>
										<Field orientation="horizontal">
											<RadioGroupItem value="dashboard" id={`${id}-range-dashboard`} />
											<FieldLabel htmlFor={`${id}-range-dashboard`} className="font-normal">
												{t("dashboards.rangeDashboard")}
											</FieldLabel>
										</Field>
										<Field orientation="horizontal">
											<RadioGroupItem value="own" id={`${id}-range-own`} />
											<FieldLabel htmlFor={`${id}-range-own`} className="font-normal">
												{t("dashboards.rangeOwn")}
											</FieldLabel>
										</Field>
									</RadioGroup>
									{range ? (
										<RangeFields
											range={range}
											onChange={setRange}
											id={`${id}-own`}
											label={t("dashboards.rangeLabel")}
										/>
									) : null}
								</FieldSet>
								{kind?.settings.map((setting) => (
									<SettingField
										key={setting.key}
										place={place}
										kind={kind}
										setting={setting}
										value={settings[setting.key]}
										onChange={(value) =>
											setSettings((before) => {
												const next = { ...before };
												if (value === undefined) delete next[setting.key];
												else next[setting.key] = value;
												return next;
											})
										}
									/>
								))}
								{widget.shape === "table" ? (
									<Field>
										<FieldLabel htmlFor={`${id}-rows`}>{t("dashboards.rows")}</FieldLabel>
										<NativeSelect
											id={`${id}-rows`}
											value={String(rows)}
											onChange={(change) => setRows(Number(change.target.value))}
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
									<FieldSet>
										<FieldLegend variant="label">{t("dashboards.filters")}</FieldLegend>
										<FieldDescription>{t("dashboards.filtersHelp")}</FieldDescription>
										<div className="grid gap-4 sm:grid-cols-2">
											{takes("page") ? (
												<>
													<Field>
														<FieldLabel htmlFor={`${id}-page`}>{t("dashboards.pagePath")}</FieldLabel>
														<Input
															id={`${id}-page`}
															value={filters.page?.path ?? ""}
															placeholder="/pricing"
															className="font-mono"
															maxLength={1000}
															onChange={(change) => {
																const path = change.target.value.trim();
																setFilter("page", path ? { path, match: filters.page?.match ?? "exact" } : undefined);
															}}
														/>
													</Field>
													<Field>
														<FieldLabel htmlFor={`${id}-match`}>{t("dashboards.pageMatch")}</FieldLabel>
														<NativeSelect
															id={`${id}-match`}
															value={filters.page?.match ?? "exact"}
															disabled={!filters.page}
															onChange={(change) =>
																filters.page &&
																setFilter("page", {
																	path: filters.page.path,
																	match: change.target.value === "prefix" ? "prefix" : "exact",
																})
															}
														>
															<NativeSelectOption value="exact">{t("dashboards.matchExact")}</NativeSelectOption>
															<NativeSelectOption value="prefix">{t("dashboards.matchPrefix")}</NativeSelectOption>
														</NativeSelect>
													</Field>
												</>
											) : null}
											{takes("source") ? (
												<Field>
													<FieldLabel htmlFor={`${id}-source`}>{t("dashboards.source")}</FieldLabel>
													<Input
														id={`${id}-source`}
														value={filters.source ?? ""}
														placeholder="search.example"
														maxLength={200}
														onChange={(change) => setFilter("source", change.target.value.trim() || undefined)}
														aria-describedby={`${id}-source-help`}
													/>
													<FieldDescription id={`${id}-source-help`}>{t("dashboards.sourceHelp")}</FieldDescription>
												</Field>
											) : null}
											{takes("country") ? (
												<Field>
													<FieldLabel htmlFor={`${id}-country`}>{t("dashboards.country")}</FieldLabel>
													<Input
														id={`${id}-country`}
														value={filters.country ?? ""}
														placeholder="IE"
														maxLength={2}
														className="w-24 uppercase"
														onChange={(change) =>
															setFilter("country", change.target.value.trim().toUpperCase() || undefined)
														}
														aria-describedby={`${id}-country-help`}
													/>
													<FieldDescription id={`${id}-country-help`}>{t("dashboards.countryHelp")}</FieldDescription>
												</Field>
											) : null}
											{takes("device") ? (
												<Field>
													<FieldLabel htmlFor={`${id}-device`}>{t("dashboards.device")}</FieldLabel>
													<NativeSelect
														id={`${id}-device`}
														value={filters.device ?? ""}
														onChange={(change) =>
															setFilter(
																"device",
																(change.target.value || undefined) as WidgetFilters["device"] | undefined,
															)
														}
													>
														<NativeSelectOption value="">{t("dashboards.anyDevice")}</NativeSelectOption>
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
										</div>
									</FieldSet>
								) : null}
							</>
						)}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("dashboards.save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
