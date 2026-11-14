import { Button } from "@webcraft/ui/components/button.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	AppWindowIcon,
	EarthIcon,
	FileTextIcon,
	FilterIcon,
	GlobeIcon,
	HashIcon,
	LinkIcon,
	ListIcon,
	type LucideIcon,
	MonitorIcon,
	MousePointerClickIcon,
	Redo2Icon,
	SearchIcon,
	SmartphoneIcon,
	TargetIcon,
	TrendingUpIcon,
	Undo2Icon,
} from "lucide-react";
import { type PointerEvent, type ReactNode, useId, useState } from "react";

import { type MessageKey, useT } from "../i18n.tsx";
import { SecondaryLabel } from "../shell/SecondarySidebar.tsx";
import type { CatalogKind } from "./model.ts";

/** The library's groups, in order, and which kinds each holds (by the kind's name, or its shape). */
const GROUPS: { id: string; label: MessageKey; holds: (kind: CatalogKind) => boolean }[] = [
	{ id: "numbers", label: "dashboards.library.numbers", holds: (kind) => kind.shape === "number" && !isGoals(kind) },
	{ id: "over-time", label: "dashboards.library.overTime", holds: (kind) => kind.shape === "series" },
	{ id: "lists", label: "dashboards.library.lists", holds: (kind) => kind.shape === "table" && !isGoals(kind) },
	{
		id: "goals",
		label: "dashboards.library.goalsAndFunnels",
		holds: (kind) => isGoals(kind) || kind.shape === "funnel",
	},
	{ id: "words", label: "dashboards.library.words", holds: (kind) => kind.shape === "note" },
];

function isGoals(kind: CatalogKind): boolean {
	return /:goals?$/.test(kind.kind);
}

/** A kind's icon, by what it shows. */
export function kindIcon(kind: Pick<CatalogKind, "kind" | "shape">): LucideIcon {
	const name = kind.kind.split(":").at(-1) ?? "";
	const named: Record<string, LucideIcon> = {
		totals: HashIcon,
		trend: TrendingUpIcon,
		"top-pages": ListIcon,
		sources: GlobeIcon,
		countries: EarthIcon,
		devices: SmartphoneIcon,
		browsers: AppWindowIcon,
		"operating-systems": MonitorIcon,
		links: LinkIcon,
		"custom-events": MousePointerClickIcon,
		goals: TargetIcon,
		goal: TargetIcon,
		funnel: FilterIcon,
		note: FileTextIcon,
	};
	if (named[name]) return named[name];
	return kind.shape === "series" ? TrendingUpIcon : kind.shape === "number" ? HashIcon : ListIcon;
}

/** A kind as a card: its icon in a small box, and its name. */
export function KindCard({ kind, className }: { kind: CatalogKind; className?: string }) {
	const Icon = kindIcon(kind);
	return (
		<span className={cn("flex min-w-0 items-center gap-2.5", className)}>
			<span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md border">
				<Icon aria-hidden="true" className="size-3.5" />
			</span>
			<span className="truncate text-sm font-medium">{kind.label}</span>
		</span>
	);
}

/**
 * The Widget library: where the secondary sidebar is while arranging, so the grid keeps its width and
 * place. Each kind can be dragged into the grid, or clicked (Enter) to land in the first free place.
 */
export function WidgetLibrary({
	catalog,
	onAdd,
	onDragStart,
}: {
	catalog: readonly CatalogKind[];
	onAdd: (kind: CatalogKind) => void;
	onDragStart: (kind: CatalogKind, event: PointerEvent<HTMLButtonElement>) => void;
}) {
	const t = useT();
	const id = useId();
	const [query, setQuery] = useState("");
	const wanted = query.trim().toLowerCase();
	const shown = catalog.filter((kind) => !wanted || kind.label.toLowerCase().includes(wanted));
	return (
		<>
			<InputGroup className="h-9 shrink-0">
				<InputGroupAddon>
					<SearchIcon aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					type="search"
					aria-label={t("dashboards.library.search")}
					placeholder={t("dashboards.library.search")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</InputGroup>
			<p className="sr-only" id={`${id}-help`}>
				{t("dashboards.library.help")}
			</p>
			<div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
				{GROUPS.map((group) => {
					const kinds = shown.filter(group.holds);
					if (kinds.length === 0) return null;
					return (
						<section key={group.id} aria-labelledby={`${id}-${group.id}`}>
							<SecondaryLabel id={`${id}-${group.id}`}>{t(group.label)}</SecondaryLabel>
							<ul className="flex flex-col gap-1">
								{kinds.map((kind) => (
									<li key={kind.kind}>
										<button
											type="button"
											disabled={!kind.available}
											aria-describedby={`${id}-help`}
											title={kind.available ? kind.description : t("dashboards.unavailable")}
											className="hover:bg-accent focus-visible:ring-ring/50 flex h-10 w-full cursor-grab touch-none items-center rounded-md border border-transparent px-2 text-start transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
											onPointerDown={(event) => onDragStart(kind, event)}
											onClick={() => onAdd(kind)}
										>
											<KindCard kind={kind} />
										</button>
									</li>
								))}
							</ul>
						</section>
					);
				})}
				{shown.length === 0 ? (
					<p className="text-muted-foreground px-2 py-4 text-sm">{t("dashboards.library.none")}</p>
				) : null}
			</div>
		</>
	);
}

/**
 * The panel in the secondary sidebar's place while arranging: 224 wide with its own right border and
 * the card's full height, holding the library or one Widget's settings.
 */
export function ArrangePanel({ label, children }: { label: string; children: ReactNode }) {
	return (
		<aside
			aria-label={label}
			data-slot="widget-library"
			className="bg-background hidden w-56 shrink-0 flex-col gap-1 overflow-hidden border-e p-3 md:flex"
		>
			{children}
		</aside>
	);
}

/** Where saving stands while arranging: saving, saved, or a save that failed. */
export type ArrangeSaveState = "saving" | "saved" | "failed";

/**
 * The arranging bar, in the header's place: "Arranging" and the Dashboard's name, Undo and Redo, the
 * saved state, and Done.
 */
export function ArrangeBar({
	name,
	state,
	canUndo,
	canRedo,
	onUndo,
	onRedo,
	onDone,
}: {
	name: string;
	state: ArrangeSaveState;
	canUndo: boolean;
	canRedo: boolean;
	onUndo: () => void;
	onRedo: () => void;
	onDone: () => void;
}) {
	const t = useT();
	return (
		<div className="mb-6 flex min-h-9 flex-wrap items-center justify-between gap-3">
			<div className="flex min-w-0 items-center gap-2">
				<h1 className="flex min-w-0 items-baseline gap-2">
					<span className="text-muted-foreground shrink-0 text-sm font-normal">{t("dashboards.arranging")}</span>
					<span className="truncate text-base font-semibold">{name}</span>
				</h1>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("dashboards.undo")}
					title={t("dashboards.undoKeys")}
					disabled={!canUndo}
					onClick={onUndo}
				>
					<Undo2Icon aria-hidden="true" />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("dashboards.redo")}
					title={t("dashboards.redoKeys")}
					disabled={!canRedo}
					onClick={onRedo}
				>
					<Redo2Icon aria-hidden="true" />
				</Button>
			</div>
			<div className="flex items-center gap-3">
				<p role="status" className={cn("text-sm", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
					{t(`dashboards.saveState.${state}`)}
				</p>
				<Button onClick={onDone}>{t("dashboards.done")}</Button>
			</div>
		</div>
	);
}
