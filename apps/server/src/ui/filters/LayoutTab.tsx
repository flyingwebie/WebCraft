import { Link } from "@tanstack/react-router";
import { FILTER_LAYOUTS, type FilterLayout } from "@webcraft/renderer/filters";
import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { MoveIcon, PencilRulerIcon } from "lucide-react";

import { useT } from "../i18n.tsx";
import type { FilterPlacement, FilterVersion } from "./model.ts";

/**
 * The Layout tab: the layout preset (a sidebar, a top bar of dropdowns, or a drawer opened by a
 * "Filters" button), what it becomes on phones, and where the Filter is placed, each place opened in
 * the visual builder with the Filter selected there. A preset changes only WebCraft's own markup and
 * classes, which the Design system styles: the page around it is the Template's.
 */
export function LayoutTab({
	siteId,
	filterId,
	version,
	onChange,
	placements,
	phoneWidth,
	markup,
}: {
	siteId: string;
	filterId: string;
	version: FilterVersion;
	onChange(version: FilterVersion): void;
	placements: readonly FilterPlacement[];
	/** Where phones end, from the Design system (its smallest breakpoint). */
	phoneWidth: number | null;
	/** The markup placing the Filter. */
	markup: string;
}) {
	const t = useT();
	return (
		<div className="grid max-w-2xl gap-8">
			<fieldset className="grid gap-3">
				<legend className="text-muted-foreground mb-2 text-xs font-medium uppercase">
					{t("filters.layout.preset")}
				</legend>
				{FILTER_LAYOUTS.map((layout) => (
					<label
						key={layout}
						className="has-[:checked]:border-primary has-[:checked]:ring-primary/30 has-[:focus-visible]:ring-ring/50 flex cursor-pointer items-start gap-4 rounded-lg border p-4 has-[:checked]:ring-2 has-[:focus-visible]:ring-3"
					>
						<input
							type="radio"
							name="filter-layout"
							value={layout}
							checked={version.layout === layout}
							onChange={() => onChange({ ...version, layout })}
							aria-describedby={`filter-layout-${layout}-help`}
							className="accent-primary mt-1 size-4 shrink-0"
						/>
						<Schematic layout={layout} />
						<span className="grid gap-1">
							<span className="font-medium">{t(`filters.layout.presets.${layout}`)}</span>
							<span id={`filter-layout-${layout}-help`} className="text-muted-foreground text-sm">
								{t(`filters.layout.presetHelp.${layout}`)}
							</span>
						</span>
					</label>
				))}
			</fieldset>

			<Field>
				<FieldLabel htmlFor="filter-phone">
					{phoneWidth ? t("filters.layout.phoneUnder", { width: phoneWidth }) : t("filters.layout.phone")}
				</FieldLabel>
				<NativeSelect
					id="filter-phone"
					value={version.layout === "drawer" ? "drawer" : version.phone}
					disabled={version.layout === "drawer"}
					aria-describedby="filter-phone-help"
					onChange={(event) => onChange({ ...version, phone: event.target.value as FilterVersion["phone"] })}
				>
					<NativeSelectOption value="drawer">{t("filters.layout.phoneDrawer")}</NativeSelectOption>
					<NativeSelectOption value="same">{t("filters.layout.phoneSame")}</NativeSelectOption>
				</NativeSelect>
				<FieldDescription id="filter-phone-help">
					{version.layout === "drawer" ? t("filters.layout.phoneAlways") : t("filters.layout.phoneHelp")}
				</FieldDescription>
			</Field>

			<section aria-labelledby="filter-placed-heading" className="grid gap-3">
				<h2 id="filter-placed-heading" className="text-muted-foreground text-xs font-medium uppercase">
					{t("filters.layout.placed")}
				</h2>
				<p className="text-muted-foreground text-sm">{t("filters.layout.placedHelp")}</p>
				{placements.length === 0 ? (
					<p className="rounded-md border border-dashed p-4 text-sm">
						{t("filters.layout.notPlaced")} <code className="font-mono text-xs">{markup}</code>{" "}
						<Link to="/sites/$siteId/templates" params={{ siteId }} className="underline underline-offset-4">
							{t("filters.layout.toTemplates")}
						</Link>
					</p>
				) : (
					<ul className="grid gap-2">
						{placements.map((placement) => (
							<li
								key={`${placement.kind}-${placement.id}`}
								className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
							>
								<span className="text-sm">{placementName(t, placement)}</span>
								<Link
									to="/builder/$siteId/$"
									params={{ siteId, _splat: builderPath(placement) }}
									search={{ filter: filterId }}
									className="focus-visible:ring-ring/50 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-3"
								>
									<PencilRulerIcon className="size-4" aria-hidden="true" />
									{t("filters.layout.openInBuilder", { place: placementName(t, placement) })}
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>

			<p className="flex gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
				<MoveIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{t("filters.layout.apart")}
			</p>
		</div>
	);
}

/** Where a Filter is placed, in words: "Products · Archive template", "Card (Component)". */
export function placementName(t: ReturnType<typeof useT>, placement: FilterPlacement): string {
	return t(`filters.placements.${placement.kind}`, { name: placement.name ?? "" });
}

/** The visual builder's address for where a Filter is placed: `archive-template/<Post Type>`. */
export function builderPath(placement: FilterPlacement): string {
	switch (placement.kind) {
		case "siteTemplate":
			return "site-template";
		case "searchTemplate":
			return "search-template";
		case "entryTemplate":
			return `entry-template/${placement.postTypeId ?? ""}`;
		case "archiveTemplate":
			return `archive-template/${placement.postTypeId ?? ""}`;
		case "component":
			return `component/${placement.id}`;
	}
}

/** A small drawing of a layout preset, for the eye only. */
function Schematic({ layout }: { layout: FilterLayout }) {
	const block = "bg-primary/15 rounded-sm";
	const result = "bg-muted-foreground/20 rounded-sm";
	return (
		<span aria-hidden="true" className="bg-muted grid h-14 w-20 shrink-0 gap-1 rounded-md border p-1.5">
			{layout === "sidebar" ? (
				<span className="grid grid-cols-[1fr_2fr] gap-1">
					<span className={block} />
					<span className="grid gap-1">
						<span className={result} />
						<span className={result} />
					</span>
				</span>
			) : layout === "topbar" ? (
				<span className="grid grid-rows-[0.5fr_2fr] gap-1">
					<span className="grid grid-cols-4 gap-0.5">
						<span className={block} />
						<span className={block} />
						<span className={block} />
						<span className={block} />
					</span>
					<span className="grid grid-cols-3 gap-1">
						<span className={result} />
						<span className={result} />
						<span className={result} />
					</span>
				</span>
			) : (
				<span className="grid grid-cols-[1fr_1fr] gap-1">
					<span className="grid grid-rows-[0.4fr_2fr] gap-1">
						<span className="bg-foreground/60 rounded-sm" />
						<span className={result} />
					</span>
					<span className={block} />
				</span>
			)}
		</span>
	);
}
