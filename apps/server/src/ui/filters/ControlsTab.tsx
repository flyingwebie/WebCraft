import { FILTER_CONTROL_TYPES, FILTER_LIMITS, type FilterControlType } from "@webcraft/renderer/filters";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, InfoIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { useAfterRender } from "../after-render.ts";
import { Announcer, DragHandle, useDragOrder } from "../content/reorder.tsx";
import { useT } from "../i18n.tsx";
import { ControlSettings } from "./ControlSettings.tsx";
import { CONTROL_ICONS } from "./icons.ts";
import {
	controlIndexOf,
	type FilterControl,
	type FilterProblem,
	type FilterSources,
	type FilterVersion,
	moveControl,
	newControl,
	ONE_ONLY,
} from "./model.ts";

/**
 * The Controls tab: the Filter's controls in order (each selected to change its settings; moved by
 * dragging its handle, by Alt with the arrow keys, or from its menu, every move said in a live region;
 * removed from its menu), the Add control menu with the eight kinds (one search box, sort menu, chips
 * and count at most), and the selected control's settings beside them.
 */
export function ControlsTab({
	version,
	onChange,
	selected,
	onSelect,
	sources,
	filterName,
	loop,
	language,
	problems,
}: {
	version: FilterVersion;
	onChange(version: FilterVersion): void;
	/** The selected control, by id. */
	selected: string | null;
	onSelect(controlId: string | null): void;
	sources: FilterSources | null;
	filterName: string;
	loop: string;
	language: string;
	problems: readonly FilterProblem[];
}) {
	const t = useT();
	const controls = version.controls;
	const [said, setSaid] = useState("");
	const list = useRef<HTMLOListElement>(null);
	const afterRender = useAfterRender();
	const current = controls.findIndex((control) => control.id === selected);
	const nameOf = (control: FilterControl) => controlName(t, control);

	const setControls = (next: FilterControl[]) => onChange({ ...version, controls: next });
	const move = (from: number, to: number, focus = false) => {
		const control = controls[from];
		if (!control || to < 0 || to >= controls.length || from === to) return;
		setControls(moveControl(controls, from, to));
		onSelect(control.id);
		setSaid(t("filters.controls.moved", { name: nameOf(control), place: to + 1, count: controls.length }));
		if (focus) {
			afterRender(() =>
				list.current?.querySelector<HTMLButtonElement>(`[data-control="${CSS.escape(control.id)}"]`)?.focus(),
			);
		}
	};
	const drag = useDragOrder((from, to) => move(from, to));
	const add = (type: FilterControlType) => {
		const control = newControl(type, controls, sources, {
			postTypes: t("filters.settings.postTypes"),
			sortTitle: t("filters.controls.sortTitle"),
			sortLabel: t("filters.settings.sortBy.title"),
		});
		setControls([...controls, control]);
		onSelect(control.id);
		setSaid(t("filters.controls.added", { name: nameOf(control), place: controls.length + 1 }));
	};
	const remove = (index: number) => {
		const control = controls[index];
		if (!control) return;
		const next = controls.filter((_, at) => at !== index);
		setControls(next);
		onSelect(next[Math.max(0, index - 1)]?.id ?? null);
		setSaid(t("filters.controls.removed", { name: nameOf(control) }));
	};
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
		event.preventDefault();
		move(index, index + (event.key === "ArrowUp" ? -1 : 1), true);
	};
	const full = controls.length >= FILTER_LIMITS.controls;

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
			<section aria-labelledby="filter-controls-heading" className="grid min-w-0 content-start gap-3">
				<div className="flex items-center justify-between gap-2">
					<h2 id="filter-controls-heading" className="text-muted-foreground text-xs font-medium uppercase">
						{t("filters.controls.heading")}
					</h2>
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={full} />}>
							<PlusIcon data-icon="inline-start" />
							{t("filters.controls.add")}
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{FILTER_CONTROL_TYPES.map((type) => {
								const Icon = CONTROL_ICONS[type];
								const taken = ONE_ONLY.has(type) && controls.some((control) => control.type === type);
								return (
									<DropdownMenuItem key={type} disabled={taken} onClick={() => add(type)}>
										<Icon />
										{t(`filters.types.${type}`)}
									</DropdownMenuItem>
								);
							})}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				{controls.length === 0 ? (
					<p className="text-muted-foreground rounded-md border border-dashed p-6 text-sm">
						{t("filters.controls.none")}
					</p>
				) : (
					<ol ref={list} className="grid min-w-0 gap-2" aria-describedby="filter-controls-keys">
						{controls.map((control, index) => {
							const Icon = CONTROL_ICONS[control.type];
							const broken = problems.some((problem) => controlIndexOf(problem) === index);
							const name = nameOf(control);
							return (
								<li
									key={control.id}
									{...drag.itemProps(index)}
									className={`flex min-w-0 items-center gap-1 rounded-md border p-1.5 data-[drop-target=true]:border-dashed data-[drop-target=true]:border-sky-500 ${index === current ? "border-primary ring-primary/30 ring-2" : ""} ${broken ? "border-destructive" : ""}`}
								>
									<DragHandle
										{...drag.handleProps(
											index,
											() => list.current?.querySelector<HTMLElement>(`li:nth-child(${index + 1})`) ?? null,
										)}
									/>
									<button
										type="button"
										data-control={control.id}
										className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1 text-start outline-none focus-visible:ring-3"
										aria-current={index === current ? "true" : undefined}
										onClick={() => onSelect(control.id)}
										onKeyDown={(event) => onKeyDown(event, index)}
									>
										<Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
										<span className="grid min-w-0 flex-1">
											<span className="truncate font-medium">{name}</span>
											<span className="text-muted-foreground truncate text-xs">
												{t(`filters.types.${control.type}`)}
											</span>
										</span>
										{"key" in control ? (
											<Badge variant="outline" className="font-mono">
												{control.key}
											</Badge>
										) : control.type === "search" ? (
											<Badge variant="outline" className="font-mono">
												q
											</Badge>
										) : null}
										{broken ? (
											<span className="text-destructive text-xs">{t("filters.controls.hasProblems")}</span>
										) : null}
									</button>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button variant="ghost" size="icon-sm" aria-label={t("filters.controls.actions", { name })} />
											}
										>
											<EllipsisIcon />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem disabled={index === 0} onClick={() => move(index, index - 1)}>
												<ArrowUpIcon />
												{t("filters.controls.moveUp")}
											</DropdownMenuItem>
											<DropdownMenuItem disabled={index === controls.length - 1} onClick={() => move(index, index + 1)}>
												<ArrowDownIcon />
												{t("filters.controls.moveDown")}
											</DropdownMenuItem>
											<DropdownMenuItem variant="destructive" onClick={() => remove(index)}>
												<TrashIcon />
												{t("filters.controls.remove")}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</li>
							);
						})}
					</ol>
				)}
				<p id="filter-controls-keys" className="text-muted-foreground text-xs">
					{t("filters.controls.keys")}
				</p>
				<p className="flex gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
					<InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					{t("filters.controls.combining")}
				</p>
				<Announcer message={said} />
			</section>

			<section aria-labelledby="filter-control-settings-heading" className="grid min-w-0 content-start gap-3">
				<h2 id="filter-control-settings-heading" className="text-muted-foreground text-xs font-medium uppercase">
					{controls[current]
						? t("filters.controls.settingsOf", { name: nameOf(controls[current]) })
						: t("filters.controls.settings")}
				</h2>
				{controls[current] ? (
					<ControlSettings
						key={controls[current].id}
						control={controls[current]}
						index={current}
						onChange={(control) => setControls(controls.map((each, at) => (at === current ? control : each)))}
						sources={sources}
						searching={controls.some((control) => control.type === "search")}
						filterName={filterName}
						loop={loop}
						language={language}
						problems={problems}
					/>
				) : (
					<p className="text-muted-foreground text-sm">{t("filters.controls.select")}</p>
				)}
			</section>
		</div>
	);
}

/** What the admin calls a control: its label as written, else its kind. */
export function controlName(t: ReturnType<typeof useT>, control: FilterControl): string {
	const label = "label" in control ? control.label?.text : undefined;
	return label && label.trim() !== "" ? label : t(`filters.types.${control.type}`);
}
